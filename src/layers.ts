// Discovery reads data only. Importing is a separate startup-only operation;
// src/hats.ts owns lifecycle and activation, never the injected hat bag.
import { pathfinder } from '@pathfinder/pathfinder';
import type { PathfinderApp } from '@pathfinder/pathfinder';
import { scopedLog } from './logging.ts';
import type { State } from './state.ts';
import { parseSettingsSchema } from './settings-schema.ts';
import type { HatServices } from './hat-service.ts';

export interface HeaderMatch {
  name: string;
  includes: string;
}

export interface Mount {
  /** Directory walked for this mount (inside the layer dir). */
  folder: string;
  /** URL prefix the mount answers ('' = the layer dir itself is the root). */
  prefix: string;
  app: PathfinderApp;
}

export interface Layer {
  name: string;
  mounts: Mount[];
  /** Claimed default ports from the manifest (hooks, not binds). [] = unported. */
  ports: number[];
  headers: HeaderMatch[];
  dir: string;
}

const RESERVED = new Set(['port', 'headers', 'settings', 'setup']);

export interface HatError {
  phase: 'manifest' | 'import' | 'activate';
  code: string;
  message: string;
  file?: string;
}

export interface FoundHat {
  name: string;
  dir: string;
  mounts: { folder: string; prefix: string }[];
  ports: number[];
  headers: HeaderMatch[];
  settings: string[];
  setup: boolean;
  hash: string;
  errors: HatError[];
}

export function hatError(
  phase: HatError['phase'],
  code: string,
  error: unknown,
  file?: string,
): HatError {
  return {
    phase,
    code,
    message: error instanceof Error ? error.message : String(error),
    ...(file === undefined ? {} : { file }),
  };
}

// Include names as well as bytes: additions/removals/renames are changes too.
async function contentHash(dir: string): Promise<string> {
  const files: [string, string][] = [];
  const hex = (bytes: ArrayBuffer) =>
    Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0'))
      .join('');
  async function walk(folder: string, relative: string) {
    for await (const entry of Deno.readDir(folder)) {
      const name = `${relative}${entry.name}`;
      if (entry.isDirectory) await walk(`${folder}/${entry.name}`, `${name}/`);
      else if (entry.isFile) {
        files.push([
          name,
          hex(
            await crypto.subtle.digest(
              'SHA-256',
              await Deno.readFile(`${folder}/${entry.name}`),
            ),
          ),
        ]);
      } else {
        throw new Error(
          `${folder}/${entry.name}: hat files must be regular files or directories`,
        );
      }
    }
  }
  await walk(dir, '');
  files.sort(([a], [b]) => a.localeCompare(b));
  return hex(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(files)),
    ),
  );
}

// Manifest `port`: number | number[] | undefined → number[]. Anything else
// (non-int, 0, >65535, mixed junk) is a load-time error naming the file.
function parsePortClaim(dir: string, raw: unknown): number[] {
  if (raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  for (const p of list) {
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 65535) {
      throw new Error(
        `${dir}/manifest.json — "port" must be an integer 1..65535 or a list of them, got ${
          JSON.stringify(raw)
        }`,
      );
    }
  }
  return list;
}

/** Discover all folders, isolating manifest/settings/mount failures per hat. */
export async function findHats(opts: {
  app: object;
  layersRoot?: string;
}): Promise<FoundHat[]> {
  const root = opts.layersRoot ?? './layers';
  const hats: FoundHat[] = [];
  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(root)) entries.push(entry);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const dir = `${root}/${entry.name}`;
    const file = `${dir}/manifest.json`;
    const hat: FoundHat = {
      name: entry.name,
      dir,
      mounts: [],
      ports: [],
      headers: [],
      settings: [],
      setup: false,
      hash: '',
      errors: [],
    };
    try {
      hat.hash = await contentHash(dir);
      let manifest: Record<string, unknown> = {};
      try {
        manifest = JSON.parse(await Deno.readTextFile(file));
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      if (
        manifest === null || typeof manifest !== 'object' ||
        Array.isArray(manifest)
      ) throw new Error('manifest must be an object');
      if (manifest.setup !== undefined && typeof manifest.setup !== 'boolean') {
        throw new Error('setup must be a boolean');
      }
      hat.setup = manifest.setup === true;
      hat.ports = parsePortClaim(dir, manifest.port);
      if (manifest.headers !== undefined) {
        if (
          !Array.isArray(manifest.headers) ||
          !manifest.headers.every((h) =>
            h !== null && typeof h === 'object' && typeof h.name === 'string' &&
            h.name.length > 0 && typeof h.includes === 'string'
          )
        ) throw new Error('headers must be a list of {name, includes}');
        hat.headers = manifest.headers;
      }
      if (manifest.settings !== undefined) {
        if (
          manifest.settings === null || typeof manifest.settings !== 'object' ||
          Array.isArray(manifest.settings)
        ) {
          throw new Error('settings must map keys to schemas');
        }
        const state = (opts.app as { state?: Pick<State, 'declare'> }).state;
        if (!state) throw new Error('settings service is required');
        // Validate all schemas before publishing any declaration from this manifest.
        const settings = Object.entries(manifest.settings).map((
          [key, schema],
        ) => [key, parseSettingsSchema(schema)] as const);
        for (const [key, schema] of settings) {
          state.declare(key, schema, `hat:${entry.name}`);
        }
        hat.settings = settings.map(([key]) => key);
      }
      const mountKeys = Object.keys(manifest).filter((k) => !RESERVED.has(k))
        .sort();
      const rootPath = await Deno.realPath(dir);
      for (const key of mountKeys) {
        const prefix = manifest[key];
        if (
          typeof prefix !== 'string' ||
          (prefix !== '' && (!prefix.startsWith('/') || prefix.endsWith('/')))
        ) {
          throw new Error(
            `mount "${key}" must map to a URL prefix string (no trailing slash)`,
          );
        }
        const folder = `${dir}/${key}`;
        const resolved = await Deno.realPath(folder);
        if (
          !resolved.startsWith(`${rootPath}/`) ||
          !(await Deno.stat(folder)).isDirectory
        ) {
          throw new Error(`mount "${key}" must be a directory inside the hat`);
        }
        hat.mounts.push({ folder, prefix });
      }
      if (mountKeys.length === 0) hat.mounts.push({ folder: dir, prefix: '' });
    } catch (error) {
      hat.errors.push(hatError('manifest', 'hat_manifest_failed', error, file));
    }
    hats.push(hat);
  }
  return hats;
}

/** Startup only. Callers own the per-hat import failure boundary. */
export async function loadHat(hat: FoundHat, bag: object): Promise<Layer> {
  const { store: _store, hats, ...services } = bag as
    & Record<string, unknown>
    & { hats?: HatServices };
  const app = {
    ...services,
    log: scopedLog(`hat:${hat.name}`),
    ...(hats ? { hats: hats(hat.name) } : {}),
  };
  // Every import path (registry and isolated loader) crosses this boundary.
  // Copy all non-secret config values, preserving version/OwnTone acting user.
  if ('cfg' in app && app.cfg !== null && typeof app.cfg === 'object') {
    const { password: _password, secret: _secret, ...view } = app.cfg as Record<
      string,
      unknown
    >;
    app.cfg = Object.freeze(view);
  }
  const mounts: Mount[] = [];
  for (const mount of hat.mounts) {
    mounts.push({
      ...mount,
      app: await pathfinder({ roots: [mount.folder], app }),
    });
  }
  return {
    name: hat.name,
    dir: hat.dir,
    ports: hat.ports,
    headers: hat.headers,
    mounts,
  };
}

/** Low-level startup loader for isolated protocol consumers. No activation policy. */
export async function loadLayers(
  opts: { app: object; layersRoot?: string },
): Promise<Layer[]> {
  const layers: Layer[] = [];
  for (const hat of await findHats(opts)) {
    if (hat.errors.length || hat.setup) continue;
    try {
      layers.push(await loadHat(hat, opts.app));
    } catch (error) {
      scopedLog('hats').event('hat_failed', {
        hat: hat.name,
        phase: 'import',
        code: 'hat_import_failed',
        error,
      });
    }
  }
  return layers;
}
