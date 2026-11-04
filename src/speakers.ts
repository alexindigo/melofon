import type { CommandSource, Output, Outputs } from './player.ts';
import type { PreparationView } from './output-admission.ts';
import { isConnectionStrategy } from './connection-strategy.ts';
import { SpeakerError } from './speaker-errors.ts';
import { PlaybackError } from './playback-errors.ts';
import type { State } from './state.ts';
export { SpeakerError } from './speaker-errors.ts';

function fields(input: unknown, allowed: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SpeakerError(
      'invalid_field',
      'Speaker configuration must be an object',
    );
  }
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new SpeakerError(
      'unknown_field',
      'Unknown speaker configuration field',
    );
  }
  return input as Record<string, unknown>;
}

function strategy(value: unknown) {
  if (!isConnectionStrategy(value)) {
    throw new SpeakerError('invalid_field', 'Invalid connection strategy');
  }
  return value;
}

/** Public facts only. No profiles, transports, permits or lifecycle commands. */
export interface SpeakerAbilities {
  volume: boolean;
  seek: boolean;
  pin: boolean;
  password: boolean;
  formats: string[];
}

export interface SpeakerSessionView {
  connection: 'disconnected' | 'connecting' | 'connected' | 'failed';
  authentication: 'none' | 'authentication_required';
  error?: { code: string; message: string };
}

export interface SpeakerAdapterView {
  preparation: PreparationView;
  abilities?: SpeakerAbilities | null;
  session?: SpeakerSessionView;
}

export interface SpeakerView {
  ignored?: true;
  id: string;
  name: string;
  protocol: string;
  address?: string;
  port?: number;
  model?: string;
  selected: boolean;
  volume: number;
  connectionStrategy: Output['connectionStrategy'];
  adopted: boolean;
  discovered: boolean;
  abilities: SpeakerAbilities | null;
  state: { preparation: PreparationView } & SpeakerSessionView;
}

/** An offline ignore marker retains identity only, never old protocol facts. */
export interface SpeakerIgnoreView {
  id: string;
  ignored: true;
  adopted: false;
  discovered: false;
}
export type SpeakerListEntry = SpeakerView | SpeakerIgnoreView;

/** One protocol-neutral boundary over control preferences and live facts.
 * Reading never acquires facts, starts a session or saves configuration. */
export function createSpeakers(deps: {
  outputs: Pick<
    Outputs,
    | 'list'
    | 'get'
    | 'lifetime'
    | 'adopt'
    | 'update'
    | 'forget'
    | 'ignored'
    | 'ignore'
    | 'unignore'
    | 'presence'
  >;
  playback?: { pause(source?: CommandSource): void };
  adapterView(id: string): SpeakerAdapterView;
  retry?(id: string): Promise<void>;
  state?: State;
  prepare?(id: string, signal: AbortSignal): Promise<boolean>;
  registerAddress?(input: {
    host: string;
    name?: string;
    port?: number;
    connectionStrategy?: Output['connectionStrategy'];
  }, source?: CommandSource): Promise<Output | null>;
}) {
  deps.state?.declare('speakers.preparationSeconds', {
    type: 'number',
    minimum: 0.01,
    maximum: 60,
    default: 5,
    description:
      'Maximum wait for selected speaker preparation before playback',
  });
  const selected = () => deps.outputs.list().filter((row) => row.selected);
  const connected = (id: string) => {
    const session = deps.adapterView(id).session;
    return session?.connection === 'connected' &&
      session.authentication === 'none';
  };
  const eligible = (id: string) =>
    connected(id) ||
    deps.outputs.presence(id) !== 'gone' ||
    deps.adapterView(id).preparation.state === 'ready';
  const view = (row: Output): SpeakerView => {
    const adapter = deps.adapterView(row.id);
    return ({
      ...(deps.outputs.ignored().includes(row.id) ? { ignored: true } : {}),
      id: row.id,
      name: row.name,
      protocol: row.type,
      ...(row.host === undefined ? {} : { address: row.host }),
      ...(row.port === undefined ? {} : { port: row.port }),
      ...(row.model === undefined ? {} : { model: row.model }),
      selected: row.selected,
      volume: row.volume,
      connectionStrategy: row.connectionStrategy,
      ...deps.outputs.lifetime(row.id),
      abilities: structuredClone(adapter.abilities ?? null),
      state: structuredClone({
        preparation: adapter.preparation,
        ...(adapter.session ?? {
          connection: 'disconnected',
          authentication: 'none',
        }),
      }),
    });
  };
  const requireRow = (id: string, includeIgnored = false) => {
    const row = deps.outputs.get(id, { includeIgnored });
    if (!row) throw new SpeakerError('not_found', 'Speaker not found');
    return row;
  };
  const durable = async (operation: () => Promise<Output | null>) => {
    try {
      const row = await operation();
      if (!row) throw new SpeakerError('not_found', 'Speaker not found');
      return view(row);
    } catch (error) {
      if (error instanceof SpeakerError) throw error;
      throw new SpeakerError(
        'persistence_failed',
        'Speaker configuration could not be saved',
      );
    }
  };
  const marker = (id: string): SpeakerIgnoreView => ({
    id,
    ignored: true,
    adopted: false,
    discovered: false,
  });
  const changeIgnore = async (operation: () => Promise<void>) => {
    try {
      await operation();
    } catch (error) {
      if (error instanceof SpeakerError) throw error;
      throw new SpeakerError(
        'persistence_failed',
        'Speaker ignore could not be saved',
      );
    }
  };
  return {
    /** Ongoing sessions outlive discovery, but withdrawn idle targets cannot start. */
    hasPlaybackTarget(): boolean {
      return selected().some((row) => eligible(row.id));
    },
    async preparePlayback(signal: AbortSignal): Promise<void> {
      const rows = selected();
      if (!rows.length) {
        throw new PlaybackError('no_target', 'Select a speaker before playing');
      }
      const candidates = rows.filter((row) => eligible(row.id));
      if (!candidates.length) {
        throw new PlaybackError(
          'target_unavailable',
          'Selected speakers are unavailable',
        );
      }
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal.addEventListener('abort', cancel, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (signal.aborted) {
          throw new PlaybackError(
            'playback_cancelled',
            'Playback start cancelled',
          );
        }
        const seconds = deps.state
          ? await deps.state.getTyped('speakers.preparationSeconds') as number
          : 5;
        const aborted = new Promise<boolean>((resolve) => {
          controller.signal.addEventListener('abort', () => resolve(false), {
            once: true,
          });
          if (controller.signal.aborted) resolve(false);
        });
        timer = setTimeout(cancel, seconds * 1000);
        // One ready peer suffices. Slower/failed peers remain independently visible
        // and the boot decides their later sessions, never this catalog preflight.
        const prepared = Promise.any(candidates.map(async (row) => {
          const key = JSON.stringify([row.type, row.host, row.port]);
          const ok = connected(row.id) ||
            await deps.prepare?.(row.id, controller.signal);
          const current = deps.outputs.get(row.id);
          if (
            !ok || !current?.selected || !eligible(row.id) ||
            JSON.stringify([current.type, current.host, current.port]) !== key
          ) throw new Error('unavailable');
          return true;
        })).catch(() => false);
        const ok = await Promise.race([prepared, aborted]);
        if (signal.aborted) {
          throw new PlaybackError(
            'playback_cancelled',
            'Playback start cancelled',
          );
        }
        if (!ok) {
          throw new PlaybackError(
            'target_unavailable',
            'Selected speakers could not be prepared',
          );
        }
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        controller.abort();
      }
    },
    list(options?: { includeIgnored?: boolean }): SpeakerListEntry[] {
      const rows: SpeakerListEntry[] = deps.outputs.list(options).map(view);
      if (options?.includeIgnored) {
        const present = new Set(rows.map((row) => row.id));
        for (const id of deps.outputs.ignored()) {
          if (!present.has(id)) rows.push(marker(id));
        }
      }
      return rows;
    },
    get(
      id: string,
      options?: { includeIgnored?: boolean },
    ): SpeakerListEntry | null {
      const row = deps.outputs.get(id, options);
      if (row) return view(row);
      return options?.includeIgnored && deps.outputs.ignored().includes(id)
        ? marker(id)
        : null;
    },
    async ignore(id: string): Promise<SpeakerListEntry> {
      await changeIgnore(() => deps.outputs.ignore(id));
      const row = deps.outputs.get(id, { includeIgnored: true });
      return row ? view(row) : marker(id);
    },
    async unignore(id: string): Promise<void> {
      await changeIgnore(() => deps.outputs.unignore(id));
    },
    async add(input: unknown, source?: CommandSource): Promise<SpeakerView> {
      const body = fields(input, [
        'protocol',
        'address',
        'port',
        'name',
        'connectionStrategy',
      ]);
      if (body.protocol !== 'AirPlay') {
        throw new SpeakerError(
          body.protocol === undefined
            ? 'invalid_field'
            : 'unsupported_protocol',
          'Unsupported speaker protocol',
        );
      }
      if (typeof body.address !== 'string' || !body.address.trim()) {
        throw new SpeakerError(
          'invalid_field',
          'Address must be a non-empty host',
        );
      }
      if (
        body.name !== undefined &&
        (typeof body.name !== 'string' || !body.name.trim())
      ) {
        throw new SpeakerError(
          'invalid_field',
          'Name must be a non-empty string',
        );
      }
      if (
        body.port !== undefined &&
        (typeof body.port !== 'number' || !Number.isInteger(body.port) ||
          body.port < 1 || body.port > 65535)
      ) {
        throw new SpeakerError(
          'invalid_field',
          'Port must be an integer from 1 to 65535',
        );
      }
      const connectionStrategy = body.connectionStrategy === undefined
        ? undefined
        : strategy(body.connectionStrategy);
      if (!deps.registerAddress) {
        throw new Error('Speaker address adapter unavailable');
      }
      return await durable(() =>
        deps.registerAddress!({
          host: body.address as string,
          ...(body.name === undefined
            ? {}
            : { name: (body.name as string).trim() }),
          ...(body.port === undefined ? {} : { port: body.port as number }),
          ...(connectionStrategy === undefined ? {} : { connectionStrategy }),
        }, source)
      );
    },
    async adopt(id: string): Promise<SpeakerView> {
      requireRow(id, true);
      return await durable(() => deps.outputs.adopt(id));
    },
    async retry(id: string): Promise<SpeakerView> {
      const row = requireRow(id);
      if (row.type !== 'AirPlay') {
        throw new SpeakerError(
          'unsupported_protocol',
          'Unsupported speaker protocol',
        );
      }
      if (!deps.retry) throw new Error('Speaker lifecycle unavailable');
      await deps.retry(id);
      return view(requireRow(id));
    },
    async forget(id: string, source?: CommandSource): Promise<void> {
      const row = requireRow(id);
      if (!deps.outputs.lifetime(id).adopted) {
        throw new SpeakerError(
          'not_adopted',
          'Discovered speakers cannot be forgotten; use ignore',
        );
      }
      const operation = deps.outputs.forget(id, source);
      if (
        row.selected && !deps.outputs.list().some((speaker) => speaker.selected)
      ) {
        deps.playback?.pause(source);
      }
      try {
        await operation;
      } catch {
        throw new SpeakerError(
          'persistence_failed',
          'Speaker configuration could not be removed',
        );
      }
    },
    async configure(
      id: string,
      input: unknown,
      source?: CommandSource,
    ): Promise<SpeakerView> {
      const body = fields(input, ['connectionStrategy']);
      const connectionStrategy = strategy(body.connectionStrategy);
      requireRow(id);
      const adopted = deps.outputs.lifetime(id).adopted;
      const row = deps.outputs.update(id, { connectionStrategy }, source)!;
      // Temporary edits stay temporary; saved edits await durable completion.
      return adopted ? await durable(() => deps.outputs.adopt(id)) : view(row);
    },
  };
}

export type Speakers = ReturnType<typeof createSpeakers>;
