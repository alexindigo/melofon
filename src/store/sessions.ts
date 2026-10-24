import { atomic, type Engine, esc, type Queries } from './engine.ts';
import { noteLogin, readUser, requireCaller } from './users.ts';
import { UserError } from '../user-errors.ts';

export interface SessionRecord {
  id: string;
  userId: string;
  deviceName: string;
  userAgent: string;
  createdAt: string;
  lastUsedAt: string;
}
const fields =
  `id, user_id AS userId, device_name AS deviceName, user_agent AS userAgent,
  epoch_ms(created_at)::DOUBLE AS createdAt, epoch_ms(last_used_at)::DOUBLE AS lastUsedAt`;
type StoredSession = Omit<SessionRecord, 'createdAt' | 'lastUsedAt'> & {
  createdAt: number;
  lastUsedAt: number;
};
function sessionRecord(row: StoredSession): SessionRecord {
  return {
    ...row,
    createdAt: new Date(row.createdAt).toISOString(),
    lastUsedAt: new Date(row.lastUsedAt).toISOString(),
  };
}

/** Shared transaction primitive: sessions.ts remains the sole sessions writer. */
export async function endUserSessions(
  q: Queries,
  userId: string,
): Promise<string[]> {
  const rows = await q.all<{ id: string }>(
    `DELETE FROM sessions WHERE user_id = ${esc(userId)} RETURNING id`,
  );
  return rows.map((r) => r.id);
}

export function createSessionsStore(engine: Engine) {
  return {
    create(
      input: {
        id: string;
        userId: string;
        keyHash: string;
        deviceName: string;
        userAgent: string;
        now: number;
      },
      passwordEnc?: string,
    ) {
      return atomic(engine, async (q) => {
        if (!await readUser(q, input.userId)) throw new UserError('not_found');
        if (passwordEnc !== undefined) {
          const current = (await q.all<{ password_enc: string }>(
            `SELECT password_enc FROM users WHERE id = ${esc(input.userId)}`,
          ))[0];
          if (current.password_enc !== passwordEnc) {
            throw new UserError('invalid_credentials');
          }
        }
        await q.run(
          `INSERT INTO sessions VALUES (${esc(input.id)}, ${
            esc(input.userId)
          }, ${esc(input.keyHash)},
          ${esc(input.deviceName)}, ${
            esc(input.userAgent)
          }, epoch_ms(${input.now}), epoch_ms(${input.now}))`,
        );
        // Native sign-in alone passes the verified credential version. Session
        // creation and the login timestamp cannot get separated by a reset.
        if (passwordEnc !== undefined) {
          await noteLogin(q, input.userId, input.now);
        }
        return sessionRecord(
          (await q.all<StoredSession>(
            `SELECT ${fields} FROM sessions WHERE id = ${esc(input.id)}`,
          ))[0],
        );
      });
    },
    authenticate(
      keyHash: string,
      now: number,
      idleMs: number,
      intervalMs: number,
    ) {
      return atomic(engine, async (q) => {
        const row = (await q.all<StoredSession>(
          `SELECT ${fields} FROM sessions WHERE key_hash = ${esc(keyHash)}`,
        ))[0];
        if (!row) return { auth: null, ended: null };
        const user = await readUser(q, row.userId);
        if (!user || (idleMs > 0 && now - row.lastUsedAt >= idleMs)) {
          await q.run(`DELETE FROM sessions WHERE id = ${esc(row.id)}`);
          return {
            auth: null,
            ended: { userId: row.userId, sessionIds: [row.id] },
          };
        }
        if (now - row.lastUsedAt >= intervalMs) {
          await q.run(
            `UPDATE sessions SET last_used_at = epoch_ms(${now}) WHERE id = ${
              esc(row.id)
            }`,
          );
        }
        return { auth: { user, sessionId: row.id }, ended: null };
      });
    },
    list(userId: string, caller?: string) {
      return engine.exclusive(async (q) => {
        if (caller !== undefined) await requireCaller(q, caller, userId);
        return (await q.all<StoredSession>(
          `SELECT ${fields} FROM sessions WHERE user_id = ${
            esc(userId)
          } ORDER BY created_at, id`,
        )).map(sessionRecord);
      });
    },
    revoke(caller: string, id: string) {
      return atomic(engine, async (q) => {
        const row = (await q.all<{ userId: string }>(
          `SELECT user_id AS userId FROM sessions WHERE id = ${esc(id)}`,
        ))[0];
        if (!row) {
          if (!await readUser(q, caller)) throw new UserError('forbidden');
          throw new UserError('not_found');
        }
        await requireCaller(q, caller, row.userId);
        await q.run(`DELETE FROM sessions WHERE id = ${esc(id)}`);
        return { userId: row.userId, sessionIds: [id] };
      });
    },
    revokeAll(userId: string, caller?: string) {
      return atomic(engine, async (q) => {
        if (caller !== undefined) await requireCaller(q, caller, userId);
        return endUserSessions(q, userId);
      });
    },
  };
}
