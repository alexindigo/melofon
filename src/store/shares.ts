import { atomic, type Engine, esc, type Queries } from './engine.ts';
import { requireUserId } from './users.ts';

export type ShareKind = 'song' | 'album' | 'artist' | 'playlist';
export interface ShareRow {
  id: string;
  owner: string;
  description: string;
  resourceType: ShareKind;
  resourceIds: string[];
  downloadable: boolean;
  expiresAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
  lastVisitedAtMs: number | null;
  visitCount: number;
}
export interface ShareUpdate {
  description?: string;
  expiresAtMs?: number | null;
}
const SELECT = `SELECT s.id, u.name AS owner, s.description,
  s.resource_type AS "resourceType", s.resource_ids AS "resourceIds", s.downloadable,
  s.expires_ms::DOUBLE AS "expiresAtMs", s.created_ms::DOUBLE AS "createdAtMs",
  s.updated_ms::DOUBLE AS "updatedAtMs", s.last_visited_ms::DOUBLE AS "lastVisitedAtMs",
  s.visit_count::DOUBLE AS "visitCount" FROM shares s JOIN users u ON u.id = s.user_id`;
async function get(q: Queries, id: string): Promise<ShareRow | null> {
  return (await q.all<ShareRow>(`${SELECT} WHERE s.id = ${esc(id)}`))[0] ??
    null;
}
const nullable = (value: number | null) =>
  value === null ? 'NULL' : String(value);

export function createSharesStore(engine: Engine) {
  return {
    get: (id: string) => engine.exclusive((q) => get(q, id)),
    list: (owner?: string): Promise<ShareRow[]> =>
      engine.exclusive((q) =>
        q.all<ShareRow>(
          `${SELECT} ${
            owner === undefined ? '' : `WHERE u.name = ${esc(owner)}`
          }
        ORDER BY s.created_ms DESC, s.id`,
        )
      ),
    create(
      input: Omit<
        ShareRow,
        'id' | 'createdAtMs' | 'updatedAtMs' | 'lastVisitedAtMs' | 'visitCount'
      >,
    ): Promise<ShareRow> {
      return atomic(engine, async (q) => {
        const userId = await requireUserId(q, input.owner);
        const alphabet =
          '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
        let id: string;
        do {
          id = '';
          // Rejection sampling keeps all 62 characters equally likely.
          while (id.length < 10) {
            const byte = crypto.getRandomValues(new Uint8Array(1))[0];
            if (byte < 248) id += alphabet[byte % alphabet.length];
          }
        } while (
          (await q.all(`SELECT 1 FROM shares WHERE id = ${esc(id)}`)).length > 0
        );
        const now = Date.now();
        await q.run(`INSERT INTO shares VALUES (${esc(id)}, ${esc(userId)},
          ${esc(input.description)}, ${esc(input.resourceType)},
          [${input.resourceIds.map(esc).join(',')}], ${input.downloadable},
          ${nullable(input.expiresAtMs)}, ${now}, ${now}, NULL, 0)`);
        return (await get(q, id))!;
      });
    },
    update(id: string, input: ShareUpdate): Promise<ShareRow | null> {
      return atomic(engine, async (q) => {
        const columns = [`updated_ms = ${Date.now()}`];
        if (input.description !== undefined) {
          columns.push(`description = ${esc(input.description)}`);
        }
        if (input.expiresAtMs !== undefined) {
          columns.push(`expires_ms = ${nullable(input.expiresAtMs)}`);
        }
        await q.run(
          `UPDATE shares SET ${columns.join(', ')} WHERE id = ${esc(id)}`,
        );
        return get(q, id);
      });
    },
    delete(id: string): Promise<boolean> {
      return atomic(engine, async (q) => {
        if (!await get(q, id)) return false;
        await q.run(`DELETE FROM shares WHERE id = ${esc(id)}`);
        return true;
      });
    },
    open(id: string, now: number): Promise<ShareRow | 'expired' | null> {
      return atomic(engine, async (q) => {
        const row = await get(q, id);
        if (!row) return null;
        if (row.expiresAtMs !== null && row.expiresAtMs <= now) {
          return 'expired';
        }
        await q.run(`UPDATE shares SET visit_count = visit_count + 1,
          last_visited_ms = ${now} WHERE id = ${esc(id)}`);
        return (await get(q, id))!;
      });
    },
  };
}
