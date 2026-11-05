// Read-only indexed directory hierarchy. No filesystem walk, synthetic album
// tree or folder table: configured roots and ancestors of present media only.
import { type Engine, esc } from './engine.ts';
import { catalogRevision } from './catalog-revision.ts';
import { catalogSongRows, type SongRow } from './catalog.ts';
import { sortKeySql } from './catalog-sql.ts';
import { LibraryError } from '../library-errors.ts';
import { invalidFolderPathPattern } from '../folder-path.ts';

export interface FolderRow {
  libraryId: string;
  path: string;
  name: string;
}
export interface FolderPageOptions {
  libraryId?: string;
  path?: string;
  ignoredArticles?: string[];
  folders: { offset: number; limit: number };
  songs: { offset: number; limit: number };
}
export interface FolderPages {
  folder: FolderRow | null;
  folders: { rows: FolderRow[]; total: number };
  songs: { rows: SongRow[]; total: number };
  revision: string;
}

export function createFoldersStore(engine: Engine) {
  return {
    browse(opts: FolderPageOptions): Promise<FolderPages> {
      return engine.exclusive(async (q) => {
        const page = async (select: string) => {
          const [count] = await q.all<{ total: number }>(
            `SELECT COUNT(*) AS total FROM (${select}) folder_entries`,
          );
          const rows = await q.all<FolderRow>(`${select}
            ORDER BY ${
            sortKeySql('name', opts.ignoredArticles)
          }, "libraryId", path
            LIMIT ${opts.folders.limit} OFFSET ${opts.folders.offset}`);
          return { rows, total: Number(count.total) };
        };
        if (opts.libraryId === undefined) {
          return {
            folder: null,
            folders: await page(
              `SELECT id AS "libraryId", '' AS path, name FROM libraries`,
            ),
            songs: { rows: [], total: 0 },
            revision: await catalogRevision(q),
          };
        }
        const [library] = await q.all<{ name: string; path: string }>(
          `SELECT name, path FROM libraries WHERE id = ${esc(opts.libraryId)}`,
        );
        if (!library) throw new LibraryError('not_found', 'Library not found');
        const path = opts.path ?? '';
        const root = library.path === '/'
          ? '/'
          : `${library.path.replace(/\/+$/, '')}/`;
        // starts_with, rather than LIKE: %, _ and quotes in real names are literal.
        // Only canonical directory ancestry can produce navigable addresses.
        // Replace only the media basename with a valid segment: folder rules
        // must not restrict song names, and every directory separator stays intact.
        const relative = `substring(f.path, ${Array.from(root).length + 1})`;
        const ancestry = `regexp_replace(${relative}, '[^/]*$', '_')`;
        const indexed = `SELECT f.id, ${relative} AS rel FROM files f
          WHERE f.library_id = ${esc(opts.libraryId)} AND starts_with(f.path, ${
          esc(root)
        })
          AND ${relative} <> ''
          AND NOT regexp_matches(${ancestry}, ${
          esc(invalidFolderPathPattern)
        })`;
        const prefix = path === '' ? '' : `${path}/`;
        const descendants = `SELECT id, substring(rel, ${
          Array.from(prefix).length + 1
        }) AS child
          FROM (${indexed}) indexed WHERE starts_with(rel, ${esc(prefix)})`;
        if (path !== '') {
          const exists = await q.all(
            `SELECT 1 FROM (${descendants}) descendants LIMIT 1`,
          );
          if (!exists.length) {
            throw new LibraryError('not_found', 'Folder not found');
          }
        }
        const folders = await page(
          `SELECT DISTINCT ${esc(opts.libraryId)} AS "libraryId",
          ${esc(prefix)} || split_part(child, '/', 1) AS path,
          split_part(child, '/', 1) AS name
          FROM (${descendants}) descendants WHERE contains(child, '/')`,
        );
        const songs =
          `f.id IN (SELECT id FROM (${descendants}) descendants WHERE NOT contains(child, '/'))`;
        const [count] = await q.all<{ total: number }>(
          `SELECT COUNT(*) AS total FROM files f WHERE ${songs}`,
        );
        const rows = await catalogSongRows(
          q,
          `WHERE ${songs}
          ORDER BY ${
            sortKeySql("regexp_extract(f.path, '[^/]+$')", opts.ignoredArticles)
          }, f.id
          LIMIT ${opts.songs.limit} OFFSET ${opts.songs.offset}`,
        );
        return {
          folder: {
            libraryId: opts.libraryId,
            path,
            name: path === '' ? library.name : path.split('/').pop()!,
          },
          folders,
          songs: { rows, total: Number(count.total) },
          revision: await catalogRevision(q),
        };
      });
    },
  };
}
