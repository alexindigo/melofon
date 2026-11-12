import { atomic, type Engine, esc, type Queries } from './engine.ts';
import { readUser } from './users.ts';

export interface HatDataRow {
  hat: string;
  ownerScope: string;
  key: string;
  kind: 'data' | 'credential' | 'image';
  payload: string;
}

const fields = 'hat, owner_scope AS ownerScope, key, kind, payload';

/** DuckDB cannot expand a CHECK in place. Rebuild from canonical DDL in one
 * transaction, preserving data and encrypted credentials byte for byte. */
export async function upgradeHatData(q: Queries, schema: string) {
  const constraints = await q.all<{ constraint_text: string }>(
    "SELECT constraint_text FROM duckdb_constraints() WHERE table_name = 'hat_records' AND constraint_type = 'CHECK'",
  );
  if (!constraints.some((c) => !c.constraint_text.includes("'image'"))) return;
  const definition = schema.split(';').find((sql) =>
    /CREATE TABLE IF NOT EXISTS hat_records\s*\(/.test(sql)
  );
  if (!definition) throw new Error('Missing canonical hat record schema');
  await q.run('BEGIN TRANSACTION');
  try {
    await q.run('ALTER TABLE hat_records RENAME TO hat_records_before_images');
    await q.run(definition);
    await q.run(
      'INSERT INTO hat_records SELECT * FROM hat_records_before_images',
    );
    await q.run('DROP TABLE hat_records_before_images');
    await q.run('COMMIT');
  } catch (error) {
    await q.run('ROLLBACK');
    throw error;
  }
}

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
    imagePayloads: () =>
      engine.exclusive(async (q) =>
        (await q.all<{ payload: string }>(
          "SELECT payload FROM hat_records WHERE kind = 'image'",
        )).map((r) => r.payload)
      ),
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
        const previous = (await q.all<HatDataRow>(
          `SELECT ${fields} FROM hat_records WHERE ${
            scope(row.hat, row.ownerScope)
          } AND key = ${esc(row.key)}`,
        ))[0] ?? null;
        await q.run(
          `INSERT INTO hat_records (hat, owner_scope, key, kind, payload)
        VALUES (${esc(row.hat)}, ${esc(row.ownerScope)}, ${esc(row.key)}, ${
            esc(row.kind)
          }, ${esc(row.payload)})
        ON CONFLICT (hat, owner_scope, key) DO UPDATE SET
        kind = excluded.kind, payload = excluded.payload`,
        );
        return previous;
      }),
    remove: (hat: string, ownerScope: string, key: string) =>
      engine.exclusive(async (q) =>
        (await q.all<HatDataRow>(
          `DELETE FROM hat_records WHERE ${scope(hat, ownerScope)} AND key = ${
            esc(key)
          } RETURNING ${fields}`,
        ))[0] ?? null
      ),
  };
}

/** Obsolete native previews are derived data, not user records or image files. */
export async function retireArtworkFacts(q: Queries): Promise<void> {
  await q.run(`DELETE FROM hat_records WHERE hat = 'melofon'
    AND owner_scope = '' AND kind = 'data'
    AND (starts_with(key, 'artwork-facts/v1/') OR starts_with(key, 'artwork-facts/v2/'))`);
}
