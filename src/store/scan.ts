import { type Engine, esc, type Queries } from './engine.ts';

export type ScanProblemKind =
  | 'folder_unreadable'
  | 'root_unavailable'
  | 'tags_unreadable'
  | 'no_streams'
  | 'fingerprint_failed';
export interface ScanProblem {
  runId: string;
  libraryId: string;
  path: string;
  kind: ScanProblemKind;
  message: string;
}
export interface ScanResult {
  runId: string;
  startedAt: string;
  mode: ScanMode;
  libraries: { id: string; available: boolean }[];
  problems: ScanProblem[];
}
export type ScanMode = 'quick' | 'full';
export interface LibraryStats {
  songs: number;
  albums: number;
  artists: number;
  files: number;
  sizeBytes: number;
  durationMs: number;
  problems: number;
  lastScanStartedAt: string;
  lastScanEndedAt: string;
  lastScanMode: ScanMode;
  available: boolean;
}

/** Sole writer, called inside the catalog publication transaction. */
export async function writeScanResult(q: Queries, result: ScanResult) {
  const changed: string[] = [];
  const endedAt = new Date().toISOString();
  for (const library of result.libraries) {
    // Read the published catalog, including retained rows on partial/unavailable
    // scans. Statistics and the latest-run pointer commit together with it.
    const [totals] = await q.all<Record<string, number>>(`SELECT
      count(*) AS files, count(DISTINCT album_id) AS albums,
      coalesce(sum(size), 0) AS size, coalesce(sum(duration_ms), 0) AS duration
      FROM files WHERE library_id = ${esc(library.id)}`);
    const [artists] = await q.all<{ n: number }>(`SELECT count(*) AS n FROM (
      SELECT artist_id FROM files WHERE library_id = ${
      esc(library.id)
    } AND artist_id IS NOT NULL
      UNION SELECT al.album_artist_id FROM albums al JOIN files f ON f.album_id = al.id
      WHERE f.library_id = ${
      esc(library.id)
    } AND al.album_artist_id IS NOT NULL)`);
    const stats: LibraryStats = {
      songs: Number(totals.files),
      files: Number(totals.files),
      albums: Number(totals.albums),
      artists: Number(artists.n),
      sizeBytes: Number(totals.size),
      durationMs: Number(totals.duration),
      problems: result.problems.filter((p) =>
        p.libraryId === library.id
      ).length,
      lastScanStartedAt: result.startedAt,
      lastScanEndedAt: endedAt,
      lastScanMode: result.mode,
      available: library.available,
    };
    await q.run(
      `INSERT INTO scan_runs VALUES (${esc(result.runId)}, ${
        esc(library.id)
      }, ${esc(JSON.stringify(stats))}::JSON)`,
    );
    const previous = await q.all<{ available: boolean }>(
      `SELECT available FROM scan_libraries WHERE library_id = ${
        esc(library.id)
      }`,
    );
    if ((previous[0]?.available ?? true) !== library.available) {
      changed.push(library.id);
    }
    await q.run(
      `DELETE FROM scan_problems WHERE library_id = ${esc(library.id)}`,
    );
    await q.run(`INSERT INTO scan_libraries (library_id, run_id, available)
      VALUES (${esc(library.id)}, ${esc(result.runId)}, ${library.available})
      ON CONFLICT (library_id) DO UPDATE SET run_id = excluded.run_id, available = excluded.available`);
  }
  for (const problem of result.problems) {
    await q.run(
      `INSERT INTO scan_problems (run_id, library_id, path, kind, message)
      VALUES (${
        [
          problem.runId,
          problem.libraryId,
          problem.path,
          problem.kind,
          problem.message,
        ].map(esc).join(', ')
      })`,
    );
  }
  return changed;
}

export function createScanStore(engine: Engine) {
  return {
    stats(libraryId: string): Promise<LibraryStats | null> {
      return engine.exclusive(async (q) => {
        const [row] = await q.all<{ stats: string }>(
          `SELECT r.stats::VARCHAR AS stats
          FROM scan_libraries s JOIN scan_runs r ON r.run_id = s.run_id AND r.library_id = s.library_id
          WHERE s.library_id = ${esc(libraryId)}`,
        );
        return row ? JSON.parse(row.stats) : null;
      });
    },
    problems(libraryId: string | undefined, limit: number) {
      return engine.exclusive(async (q) => {
        const rows = await q.all<ScanProblem>(
          `SELECT p.run_id AS "runId", p.library_id AS "libraryId", p.path, p.kind, p.message
          FROM scan_problems p JOIN libraries l ON l.id = p.library_id
          ${
            libraryId === undefined
              ? ''
              : `WHERE p.library_id = ${esc(libraryId)}`
          }
          ORDER BY p.library_id, p.path, p.kind LIMIT ${Math.trunc(limit) + 1}`,
        );
        return {
          problems: rows.slice(0, limit),
          truncated: rows.length > limit,
        };
      });
    },
  };
}
