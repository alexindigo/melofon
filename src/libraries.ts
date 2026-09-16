// src/libraries.ts — app.libraries: the scan sources. Disjoint folders,
// keep-on-rescan; each row is one OpenSubsonic music folder (id, name, one
// path). Hats ask this namespace instead of inventing their own list from
// filesystem paths. Core exposes the same CRUD under /_/ so the Settings UI
// (M5) is a form, not a second store. MELOFON_LIBRARY is not the live list.
import { encodeHex } from '@std/encoding/hex';
import type { Db } from './db.ts';

export interface LibraryRow {
  id: string;
  name: string;
  path: string;
}

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

function esc(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function createLibraries(db: Db): Libraries {
  return {
    async list(): Promise<LibraryRow[]> {
      const res = await db.conn.runAndReadAll(
        'SELECT id, name, path FROM libraries ORDER BY name',
      );
      return res.getRowObjects() as unknown as LibraryRow[];
    },

    async add(name, path) {
      const normalized = path.replace(/\/+$/, '');
      const existing = await db.conn.runAndReadAll(
        `SELECT id, name, path FROM libraries WHERE path = ${esc(normalized)}`,
      );
      const found = (existing.getRowObjects() as unknown as LibraryRow[])[0];
      if (found) return found;
      const row: LibraryRow = {
        id: await stableId(normalized),
        name,
        path: normalized,
      };
      const stmt = await db.conn.prepare(
        'INSERT INTO libraries (id, name, path) VALUES (?, ?, ?)',
      );
      stmt.bindVarchar(1, row.id);
      stmt.bindVarchar(2, row.name);
      stmt.bindVarchar(3, row.path);
      await stmt.run();
      stmt.destroySync();
      return row;
    },

    async remove(id) {
      const existing = await db.conn.runAndReadAll(
        `SELECT id FROM libraries WHERE id = ${esc(id)}`,
      );
      if (existing.getRowObjects().length === 0) return false;
      await db.conn.run('BEGIN TRANSACTION');
      try {
        await db.conn.run(`DELETE FROM libraries WHERE id = ${esc(id)}`);
        await db.conn.run(`DELETE FROM files WHERE library_id = ${esc(id)}`);
        await db.conn.run(
          `DELETE FROM albums WHERE id NOT IN
             (SELECT DISTINCT album_id FROM files WHERE album_id IS NOT NULL)`,
        );
        await db.conn.run(
          `DELETE FROM artists WHERE id NOT IN
             (SELECT album_artist_id FROM albums
               WHERE album_artist_id IS NOT NULL)
           AND id NOT IN
             (SELECT DISTINCT artist_id FROM files
               WHERE artist_id IS NOT NULL)`,
        );
        await db.conn.run('COMMIT');
      } catch (err) {
        await db.conn.run('ROLLBACK');
        throw err;
      }
      return true;
    },
  };
}
