import { atomic, type Engine, esc, type Queries } from './engine.ts';
import { readUser } from './users.ts';

export interface HatDataRow {
  hat: string;
  ownerScope: string;
  key: string;
  kind: 'data' | 'credential';
  payload: string;
}

const fields = 'hat, owner_scope AS ownerScope, key, kind, payload';

function scope(hat: string, ownerScope: string): string {
  return `hat = ${esc(hat)} AND owner_scope = ${esc(ownerScope)}`;
}

/** Table-owner primitive for a future user-deletion transaction. Returned
 * retired records let core dispose of any type-specific backing after commit. */
export function deleteHatRecordsForUser(
  q: Queries,
  userId: string,
): Promise<HatDataRow[]> {
  if (!userId) throw new Error('A user id is required');
  return q.all<HatDataRow>(
    `DELETE FROM hat_records WHERE owner_scope = ${
      esc(userId)
    } RETURNING ${fields}`,
  );
}

export function createHatDataStore(engine: Engine) {
  return {
    get: (hat: string, ownerScope: string, key: string) =>
      engine.exclusive(async (q) =>
        (await q.all<HatDataRow>(
          `SELECT ${fields} FROM hat_records WHERE ${
            scope(hat, ownerScope)
          } AND key = ${esc(key)}`,
        ))[0] ?? null
      ),
    list: (hat: string, ownerScope: string) =>
      engine.exclusive((q) =>
        q.all<Pick<HatDataRow, 'key' | 'kind'>>(
          `SELECT key, kind FROM hat_records WHERE ${
            scope(hat, ownerScope)
          } ORDER BY key`,
        )
      ),
    put: (row: HatDataRow) =>
      atomic(engine, async (q) => {
        // Check inside the same slot as publication, never before encryption.
        if (row.ownerScope && !await readUser(q, row.ownerScope)) {
          throw new Error('Hat record owner does not exist');
        }
        await q.run(
          `INSERT INTO hat_records (hat, owner_scope, key, kind, payload)
        VALUES (${esc(row.hat)}, ${esc(row.ownerScope)}, ${esc(row.key)}, ${
            esc(row.kind)
          }, ${esc(row.payload)})
        ON CONFLICT (hat, owner_scope, key) DO UPDATE SET
        kind = excluded.kind, payload = excluded.payload`,
        );
      }),
    remove: (hat: string, ownerScope: string, key: string) =>
      engine.exclusive(async (q) =>
        (await q.all<{ key: string }>(
          `DELETE FROM hat_records WHERE ${scope(hat, ownerScope)} AND key = ${
            esc(key)
          } RETURNING key`,
        )).length !== 0
      ),
  };
}
