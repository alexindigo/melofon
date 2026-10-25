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
  libraries: { id: string; available: boolean }[];
  problems: ScanProblem[];
}

/** Sole writer, called inside the catalog publication transaction. */
export async function writeScanResult(q: Queries, result: ScanResult) {
  const changed: string[] = [];
  for (const library of result.libraries) {
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
