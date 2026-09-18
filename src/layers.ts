// src/layers.ts — glob layers/*/, read the optional manifest.json, boot one
// pathfinder app per declared mount. The layer name is the folder name; core
// never imports a layer by name. Layers get the injected service bag
// (app.user, app.library, …, cfg) — never a DuckDB handle.
//
// manifest.json: `port` and `headers` are reserved sniff keys; every other
// key declares a mount — folder (under the layer dir) → URL prefix:
//
//   { "rest": "/rest" }   →   layers/<name>/rest/ answered at /rest/…
//
// `port` is a number or a list of numbers — the layer's CLAIMED default
// ports (hooks, never binds; src/binds.ts maps claims to actual sockets).
// Omitted or [] means unported: a candidate on the default listen only.
//
// A layer with no mount keys keeps the old shape: the whole layer dir is the
// pathfinder root (prefix '').
import { pathfinder } from '@pathfinder/pathfinder';
import type { PathfinderApp } from '@pathfinder/pathfinder';

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

const RESERVED = new Set(['port', 'headers']);

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

export async function loadLayers(opts: {
  app: object;
  layersRoot?: string;
}): Promise<Layer[]> {
  const root = opts.layersRoot ?? './layers';
  const layers: Layer[] = [];
  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(root)) entries.push(entry);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const dir = `${root}/${entry.name}`;
    let manifest:
      & { port?: number | number[]; headers?: HeaderMatch[] }
      & Record<
        string,
        unknown
      > = {};
    try {
      manifest = JSON.parse(await Deno.readTextFile(`${dir}/manifest.json`));
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
    const mountKeys = Object.keys(manifest).filter((k) => !RESERVED.has(k))
      .sort();
    const mounts: Mount[] = [];
    if (mountKeys.length === 0) {
      mounts.push({
        folder: dir,
        prefix: '',
        app: await pathfinder({ roots: [dir], app: opts.app }),
      });
    } else {
      for (const key of mountKeys) {
        const prefix = manifest[key];
        if (typeof prefix !== 'string') {
          throw new Error(
            `${dir}/manifest.json — mount "${key}" must map to a URL prefix string`,
          );
        }
        const folder = `${dir}/${key}`;
        mounts.push({
          folder,
          prefix,
          app: await pathfinder({ roots: [folder], app: opts.app }),
        });
      }
    }
    layers.push({
      name: entry.name,
      mounts,
      ports: parsePortClaim(dir, manifest.port),
      headers: manifest.headers ?? [],
      dir,
    });
  }
  return layers;
}
