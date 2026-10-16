// src/libraries.ts — app.libraries: the scan sources. Disjoint folders,
// keep-on-rescan; each row is one OpenSubsonic music folder (id, name, one
// path). Hats ask this namespace instead of inventing their own list from
// filesystem paths. Core exposes the same CRUD under /_/ so the Settings UI
// (M5) is a form, not a second store. This table is the only source list —
// no env var names one.
import { encodeHex } from '@std/encoding/hex';
import type { Store } from './store/index.ts';
import type { LibraryRow } from './store/catalog.ts';
export type { LibraryRow } from './store/catalog.ts';

export interface Libraries {
  /** All configured sources, by name. */
  list(): Promise<LibraryRow[]>;
  /** Add a source (idempotent by path: re-adding returns the existing row). */
  add(name: string, path: string): Promise<LibraryRow>;
  /**
   * Remove a source and its catalog rows (files of that source, then albums
   * and artists left with no files). User state is keep-on-rescan: stars and
   * friends keep their target ids and resolve again if the source is
   * re-added (ids are stable content hashes).
   */
  remove(id: string): Promise<boolean>;
}

async function stableId(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`library\n${key}`),
  );
  return encodeHex(new Uint8Array(digest)).slice(0, 32);
}

export function createLibraries(store: Store): Libraries {
  return {
    list: store.catalog.listLibraries,

    async add(name, path) {
      const normalized = path.replace(/\/+$/, '');
      const row: LibraryRow = {
        id: await stableId(normalized),
        name,
        path: normalized,
      };
      return await store.catalog.addLibrary(row);
    },

    remove: store.catalog.removeLibrary,
  };
}
