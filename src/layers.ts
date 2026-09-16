// src/layers.ts — glob layers/*/, read the optional manifest.json, boot one
// pathfinder app per folder. The layer name is the folder name; core never
// imports a layer by name.
import { pathfinder } from '@pathfinder/pathfinder';
import type { PathfinderApp } from '@pathfinder/pathfinder';
import type { Config } from './config.ts';
import type { Db } from './db.ts';

export interface HeaderMatch {
  name: string;
  includes: string;
}

export interface Layer {
  name: string;
  app: PathfinderApp;
  port: number | undefined;
  headers: HeaderMatch[];
  dir: string;
}

export async function loadLayers(opts: {
  db: Db;
  cfg: Config;
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
    let manifest: { port?: number; headers?: HeaderMatch[] } = {};
    try {
      manifest = JSON.parse(await Deno.readTextFile(`${dir}/manifest.json`));
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
    const app = await pathfinder({
      roots: [dir],
      app: { db: opts.db, cfg: opts.cfg },
    });
    layers.push({
      name: entry.name,
      app,
      port: manifest.port,
      headers: manifest.headers ?? [],
      dir,
    });
  }
  return layers;
}
