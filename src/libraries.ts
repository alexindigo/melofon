// src/libraries.ts — app.libraries: the scan sources. Disjoint folders,
// keep-on-rescan; each row is one OpenSubsonic music folder (id, name, one
// path). Hats ask this namespace instead of inventing their own list from
// filesystem paths. Core exposes the same CRUD under /_/ so the Settings UI
// (M5) is a form, not a second store. This table is the only source list —
// no env var names one.
import { encodeHex } from '@std/encoding/hex';
import type { Store } from './store/index.ts';
import type { LibraryRow } from './store/catalog.ts';
import { isAbsolute, normalize, resolve } from 'node:path';
import { LibraryError } from './library-errors.ts';
import type { ScanService } from './scan.ts';
import type { Notify } from './notify.ts';
import { type Log, scopedLog } from './logging.ts';
import type { Provenance } from './logging-events.ts';
export type { LibraryRow } from './store/catalog.ts';

export interface Libraries {
  stats(id: string): ReturnType<Store['scan']['stats']>;
  /** All configured sources, by name. */
  list(): Promise<LibraryRow[]>;
  /** Add a validated, disjoint source and queue a background scan. */
  add(name: string, path: string, source?: Provenance): Promise<LibraryRow>;
  update(
    id: string,
    input: { name?: string; path?: string },
    source?: Provenance,
  ): Promise<LibraryRow>;
  /**
   * Remove a source and its catalog rows (files of that source, then albums
   * and artists left with no files). User state is keep-on-rescan: stars and
   * friends keep their target ids and resolve again if the source is
   * re-added (ids are stable content hashes).
   */
  remove(id: string, source?: Provenance): Promise<boolean>;
}

async function stableId(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`library\n${key}`),
  );
  return encodeHex(new Uint8Array(digest)).slice(0, 32);
}

export function createLibraries(store: Store, options: {
  dataDir?: string;
  scan?: ScanService;
  notify?: Notify;
  log?: Log;
} = {}): Libraries {
  const log = options.log ?? scopedLog('libraries');
  const nameOf = (name: string) => {
    if (typeof name !== 'string' || !name.trim()) {
      throw new LibraryError('invalid_field', 'name must not be empty');
    }
    return name.trim();
  };
  const pathOf = async (path: string, id?: string) => {
    if (!isAbsolute(path)) {
      throw new LibraryError(
        'path_not_absolute',
        'Library path must be absolute',
      );
    }
    let canonical: string;
    try {
      canonical = await Deno.realPath(normalize(path));
      if (!(await Deno.stat(canonical)).isDirectory) {
        throw new LibraryError(
          'path_not_directory',
          'Library path must be a directory',
        );
      }
      // Iteration, including the first read of an empty directory, is the
      // accessibility test. stat/permission bits alone do not prove it.
      for await (const _entry of Deno.readDir(canonical)) { /* exhaust */ }
    } catch (error) {
      if (error instanceof LibraryError) throw error;
      if (error instanceof Deno.errors.NotFound) {
        throw new LibraryError('path_not_found', 'Library path does not exist');
      }
      if (error instanceof Deno.errors.NotADirectory) {
        throw new LibraryError(
          'path_not_directory',
          'Library path must be a directory',
        );
      }
      throw new LibraryError(
        'path_unreadable',
        'Library directory cannot be listed',
      );
    }
    if (options.dataDir !== undefined) {
      const data = await Deno.realPath(resolve(options.dataDir));
      if (
        canonical === data ||
        canonical.startsWith(data === '/' ? '/' : `${data}/`)
      ) {
        throw new LibraryError(
          'path_in_data_dir',
          'Library path is inside the data directory',
        );
      }
    }
    // Older installs may contain relative or symlink paths. Compare their
    // actual roots too; validation must not make a second view of that tree.
    // Store rechecks canonical new rows atomically to close concurrent adds.
    for (const row of await store.catalog.listLibraries()) {
      if (row.id === id) continue;
      const other = await Deno.realPath(resolve(row.path)).catch(() =>
        resolve(row.path)
      );
      if (canonical === other) {
        throw new LibraryError(
          'path_duplicate',
          'Library path is already configured',
        );
      }
      if (
        canonical.startsWith(other === '/' ? '/' : `${other}/`) ||
        other.startsWith(canonical === '/' ? '/' : `${canonical}/`)
      ) {
        throw new LibraryError(
          'path_overlaps',
          'Library paths must not overlap',
        );
      }
    }
    return canonical;
  };
  const changed = (operation: string, id: string, source: Provenance) => {
    log.event('libraries_changed', { operation, library: id, source });
    options.notify?.emit(['libraries'], { libraries: [id] });
  };
  return {
    list: store.catalog.listLibraries,
    stats: store.scan.stats,

    async add(name, path, source = { kind: 'internal' }) {
      const normalized = await pathOf(path);
      const row: LibraryRow = {
        id: await stableId(normalized),
        name: nameOf(name),
        path: normalized,
        available: true,
      };
      const added = await store.catalog.addLibrary(row);
      changed('add', added.id, source);
      void options.scan?.start({ afterCurrent: true });
      return added;
    },

    async update(id, input, source = { kind: 'internal' }) {
      const previous = (await store.catalog.listLibraries()).find((row) =>
        row.id === id
      );
      if (!previous) throw new LibraryError('not_found', 'Library not found');
      const { library: row, pathChanged } = await store.catalog.updateLibrary(
        id,
        {
          ...(input.name === undefined ? {} : { name: nameOf(input.name) }),
          ...(input.path === undefined
            ? {}
            : { path: await pathOf(input.path, id) }),
        },
      );
      changed('update', row.id, source);
      if (pathChanged) {
        void options.scan?.start({ afterCurrent: true });
      }
      return row;
    },
    async remove(id, source = { kind: 'internal' }) {
      const removed = await store.catalog.removeLibrary(id);
      if (removed) {
        changed('remove', id, source);
        void options.scan?.start({ afterCurrent: true, ifRunning: true });
      }
      return removed;
    },
  };
}
