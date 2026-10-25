// Core-only registry: desired database flags and effective serving are distinct.
import {
  findHats,
  type FoundHat,
  type HatError,
  hatError,
  type Layer,
  loadHat,
} from './layers.ts';
import type { Store } from './store/index.ts';
import type { Notify } from './notify.ts';
import { type Log, scopedLog } from './logging.ts';
import type { PortMapping } from './binds.ts';
import type { ListenManager } from './listen-manager.ts';

export interface HatView {
  name: string;
  state: 'found' | 'loaded' | 'active' | 'failed';
  active: boolean;
  pendingRestart: boolean;
  errors: HatError[];
  mounts: { folder: string; prefix: string }[];
  ports: { claimed: number[]; actual: number[] };
  settings: string[];
  setup: boolean;
}
interface Entry {
  found: FoundHat;
  discoveryErrors: HatError[];
  view: HatView;
  layer?: Layer;
  changed: boolean;
}
export interface Hats {
  list(): HatView[];
  readonly restartRequired: boolean;
  layers(): Layer[];
  activeLayers(): Layer[];
  rescan(): Promise<HatView[]>;
  activate(name: string): Promise<HatView>;
  deactivate(name: string): Promise<HatView>;
}

/** Build once at startup. Runtime rescan never calls loadHat. */
export async function createHats(opts: {
  store: Pick<Store, 'hats'>;
  app: object;
  layersRoot?: string;
  mapping: PortMapping;
  listens: Pick<ListenManager, 'ensure'>;
  notify: Notify;
  log?: Log;
  setupMode?: boolean;
}): Promise<Hats> {
  const entries = new Map<string, Entry>();
  const flags = new Map(
    (await opts.store.hats.list()).map((row) => [row.name, row.active]),
  );
  const log = opts.log ?? scopedLog('hats');
  const emit = () => opts.notify.emit(['hats']);
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  }
  const copy = (entry: Entry) => structuredClone(entry.view);
  function get(name: string): Entry {
    const entry = entries.get(name);
    if (!entry) throw new Error(`Unknown hat: ${name}`);
    return entry;
  }
  function pending(entry: Entry) {
    entry.view.pendingRestart = entry.changed ||
      entry.view.active !== (entry.view.state === 'active');
  }
  function found(hat: FoundHat): Entry {
    const entry: Entry = {
      found: hat,
      discoveryErrors: hat.errors,
      changed: false,
      view: {
        name: hat.name,
        state: hat.errors.length ? 'failed' : 'found',
        active: flags.get(hat.name) === true,
        pendingRestart: false,
        errors: [...hat.errors],
        mounts: hat.mounts,
        ports: { claimed: hat.ports, actual: [] },
        settings: hat.settings,
        setup: hat.setup,
      },
    };
    if (hat.errors.length === 0) {
      try {
        entry.view.ports.actual = opts.mapping.actual(hat);
      } catch (error) {
        entry.view.state = 'failed';
        entry.view.errors.push(hatError('manifest', 'hat_ports_failed', error));
      }
    }
    entries.set(hat.name, entry);
    log.event('hat_found', { hat: hat.name });
    if (entry.view.state === 'failed') {
      const error = entry.view.errors[0];
      log.event('hat_failed', {
        hat: hat.name,
        phase: error.phase,
        code: error.code,
        error: error.message,
      });
    }
    emit();
    return entry;
  }
  async function activate(entry: Entry, startup = false): Promise<HatView> {
    if (entry.view.state === 'failed') {
      throw new Error(`Hat failed: ${entry.view.name}`);
    }
    if (
      (entry.found.setup && !startup) || (opts.setupMode && !entry.found.setup)
    ) {
      throw new Error(`Setup hat is reserved: ${entry.view.name}`);
    }
    if (entry.view.state === 'loaded') {
      try {
        if (!opts.setupMode) await opts.listens.ensure(entry.view.ports.actual);
      } catch (error) {
        const failure = hatError('activate', 'hat_activation_failed', error);
        entry.view.errors = [
          ...entry.view.errors.filter((e) => e.phase !== 'activate'),
          failure,
        ];
        log.event('hat_activation_failed', {
          hat: entry.view.name,
          code: failure.code,
          error,
        });
        emit();
        if (startup) return copy(entry);
        throw error;
      }
      // Publish routes only after all ports and the desired flag are ready.
      if (!startup) await opts.store.hats.set(entry.view.name, true);
      entry.view.state = 'active';
      entry.view.errors = entry.view.errors.filter((e) =>
        e.phase !== 'activate'
      );
    } else if (!startup) {
      await opts.store.hats.set(entry.view.name, true);
    }
    if (!opts.setupMode) {
      entry.view.active = true;
      pending(entry);
    }
    log.event('hat_activated', { hat: entry.view.name });
    emit();
    return copy(entry);
  }
  const hats: Hats = {
    list: () => [...entries.values()].map(copy),
    get restartRequired() {
      return [...entries.values()].some((e) => e.view.pendingRestart);
    },
    layers: () =>
      [...entries.values()].flatMap((e) => e.layer ? [e.layer] : []),
    activeLayers: () =>
      [...entries.values()].flatMap((e) =>
        e.view.state === 'active' && e.layer ? [e.layer] : []
      ),
    rescan: () =>
      serial(async () => {
        const scanned = await findHats(opts);
        const names = new Set(scanned.map((hat) => hat.name));
        for (const hat of scanned) {
          const previous = entries.get(hat.name);
          if (!previous) {
            found(hat);
            continue;
          }
          if (
            previous.changed || previous.found.hash !== hat.hash ||
            JSON.stringify(previous.found.errors) !== JSON.stringify(hat.errors)
          ) {
            previous.changed = true;
            previous.view.errors = [
              ...previous.view.errors.filter((e) =>
                !previous.discoveryErrors.includes(e) &&
                e.code !== 'hat_changed' && e.code !== 'hat_removed'
              ),
              ...hat.errors,
              hatError(
                'manifest',
                'hat_changed',
                'Hat files changed; restart required',
              ),
            ];
            // Keep discovery's replaceable snapshot separate from runtime failures.
            previous.discoveryErrors = hat.errors;
            pending(previous);
            emit();
          }
        }
        for (const entry of entries.values()) {
          if (!names.has(entry.view.name)) {
            entry.changed = true;
            entry.view.errors = [
              ...entry.view.errors.filter((e) => e.code !== 'hat_removed'),
              hatError(
                'manifest',
                'hat_removed',
                'Hat folder removed; restart required',
              ),
            ];
            pending(entry);
            emit();
          }
        }
        return hats.list();
      }),
    activate: (name) => serial(() => activate(get(name))),
    deactivate: (name) =>
      serial(async () => {
        const entry = get(name);
        await opts.store.hats.set(name, false);
        entry.view.active = false;
        pending(entry);
        log.event('hat_deactivated', { hat: name });
        emit();
        return copy(entry);
      }),
  };
  for (const hat of await findHats(opts)) {
    const entry = found(hat);
    if (
      entry.view.state === 'failed' || hat.setup !== (opts.setupMode === true)
    ) continue;
    try {
      entry.layer = await loadHat(hat, opts.app);
      if (opts.setupMode) entry.layer.ports = [];
      entry.view.state = 'loaded';
      log.event('hat_loaded', { hat: hat.name });
      emit();
    } catch (error) {
      entry.view.state = 'failed';
      entry.view.errors.push(
        hatError('import', 'hat_import_failed', error, hat.dir),
      );
      log.event('hat_failed', {
        hat: hat.name,
        phase: 'import',
        code: 'hat_import_failed',
        error,
      });
      emit();
    }
  }
  // The composition's live registry callback can now resolve this service before
  // activation; no request is routed until createHats returns.
  for (const entry of entries.values()) {
    if (
      entry.view.state === 'loaded' && (opts.setupMode || entry.view.active)
    ) {
      await activate(entry, true);
    }
  }
  return hats;
}
