import { atomic, type Engine, esc, type Queries } from './engine.ts';

export async function userIdForName(
  q: Queries,
  username: string,
): Promise<string | null> {
  const sql = `SELECT id FROM users WHERE name = ${esc(username)}`;
  const rows = await q.all<{ id: string }>(sql);
  return rows[0]?.id ?? null;
}

export async function requireUserId(
  q: Queries,
  username: string,
): Promise<string> {
  const id = await userIdForName(q, username);
  if (id === null) throw new Error(`unknown user: ${username}`);
  return id;
}

export function createUsersStore(engine: Engine) {
  return {
    count(): Promise<number> {
      return engine.exclusive(async (q) => {
        const rows = await q.all<{ n: number }>(
          'SELECT count(*) AS n FROM users',
        );
        return Number(rows[0]?.n ?? 0);
      });
    },
    seedFirst(id: string, name: string, passwordEnc: string): Promise<void> {
      return atomic(engine, async (q) => {
        const rows = await q.all<{ n: number }>(
          'SELECT count(*) AS n FROM users',
        );
        if (Number(rows[0]?.n ?? 0) > 0) return;
        await q.run(
          `INSERT INTO users (id, name, password_enc, created_at) VALUES (${
            esc(id)
          }, ${esc(name)}, ${esc(passwordEnc)}, now())`,
        );
      });
    },
    passwordForName(username: string): Promise<string | null> {
      return engine.exclusive(async (q) => {
        const rows = await q.all<{ password_enc: string }>(
          `SELECT password_enc FROM users WHERE name = ${esc(username)}`,
        );
        return rows[0]?.password_enc ?? null;
      });
    },
    passwordToken(passwordAndSalt: string): Promise<string> {
      return engine.exclusive(async (q) =>
        (await q.all<{ h: string }>(
          `SELECT md5(${esc(passwordAndSalt)}) AS h`,
        ))[0].h
      );
    },
  };
}
