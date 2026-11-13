import { atomic, type Engine, esc, type Queries } from './engine.ts';
import { passwordToken } from '../password-crypto.ts';
import { UserError } from '../user-errors.ts';
import { endUserSessions } from './sessions.ts';

export interface UserProfile {
  username: string;
  role: 'admin' | 'user';
}

export interface UserRecord extends UserProfile {
  id: string;
  displayName: string;
  email: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  lastAccessAt: string | null;
}

type StoredUser =
  & Omit<UserRecord, 'createdAt' | 'lastLoginAt' | 'lastAccessAt'>
  & {
    createdAt: number;
    lastLoginAt: number | null;
    lastAccessAt: number | null;
  };

type NewUser = {
  id: string;
  username: string;
  passwordEnc: string;
  role: UserProfile['role'];
  displayName?: string;
  email?: string;
};

async function insertUser(q: Queries, input: NewUser) {
  await checkName(q, input.username);
  await q.run(
    `INSERT INTO users (id, name, name_key, password_enc, role, display_name, email, created_at)
    VALUES (${esc(input.id)}, ${esc(input.username)}, ${
      esc(input.username.toLowerCase())
    },
    ${esc(input.passwordEnc)}, ${esc(input.role)},
    ${input.displayName ? esc(input.displayName) : 'NULL'},
    ${input.email ? esc(input.email) : 'NULL'}, now())`,
  );
  return (await readUser(q, input.id))!;
}
const fields =
  `id, name AS username, role, coalesce(display_name, name) AS displayName,
  email, epoch_ms(created_at)::DOUBLE AS createdAt, epoch_ms(last_login_at)::DOUBLE AS lastLoginAt, epoch_ms(last_access_at)::DOUBLE AS lastAccessAt`;
function userRecord(row: StoredUser): UserRecord {
  const iso = (ms: number | null) =>
    ms === null ? null : new Date(ms).toISOString();
  return {
    ...row,
    createdAt: new Date(row.createdAt).toISOString(),
    lastLoginAt: iso(row.lastLoginAt),
    lastAccessAt: iso(row.lastAccessAt),
  };
}

export async function readUser(
  q: Queries,
  id: string,
): Promise<UserRecord | null> {
  const row = (await q.all<StoredUser>(
    `SELECT ${fields} FROM users WHERE id = ${esc(id)}`,
  ))[0];
  return row ? userRecord(row) : null;
}

export function noteLogin(q: Queries, id: string, now: number): Promise<void> {
  return q.run(
    `UPDATE users SET last_login_at = epoch_ms(${now}) WHERE id = ${esc(id)}`,
  );
}

export async function requireCaller(
  q: Queries,
  caller: string,
  target?: string,
): Promise<UserRecord> {
  const user = await readUser(q, caller);
  if (!user || (user.role !== 'admin' && caller !== target)) {
    throw new UserError('forbidden');
  }
  return user;
}

async function checkName(
  q: Queries,
  name: string,
  except?: string,
): Promise<void> {
  const rows = await q.all<{ id: string; name: string }>(
    'SELECT id, name FROM users',
  );
  if (
    rows.some((row) =>
      row.id !== except && row.name.toLowerCase() === name.toLowerCase()
    )
  ) {
    throw new UserError('name_taken');
  }
}

/** Preserve all legacy case collisions, with exact-spelling sign-in for each.
 * The earliest account reserves the folded key. Others retain a NULL key until
 * an admin renames them; checkName reserves their folded names too. */
export async function migrateUserNames(q: Queries): Promise<string[]> {
  const rows = await q.all<{ id: string; name: string }>(
    'SELECT id, name FROM users ORDER BY created_at, id',
  );
  const seen = new Set<string>();
  const conflicts: string[] = [];
  for (const row of rows) {
    const key = row.name.toLowerCase();
    if (seen.has(key)) conflicts.push(row.id);
    else {
      seen.add(key);
      await q.run(
        `UPDATE users SET name_key = ${esc(key)} WHERE id = ${esc(row.id)}`,
      );
    }
  }
  return conflicts;
}

/** The old setup path created just one user. Never overwrite a recorded role. */
export async function upgradeUsers(q: Queries): Promise<void> {
  await q.run(`UPDATE users SET role = CASE
    WHEN id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1)
    THEN 'admin' ELSE 'user' END WHERE role IS NULL`);
  await q.run("ALTER TABLE users ALTER COLUMN role SET DEFAULT 'user'");
  const columns = await q.all<{ is_nullable: string }>(
    "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'role'",
  );
  if (columns[0]?.is_nullable === 'YES') {
    await q.run('ALTER TABLE users ALTER COLUMN role SET NOT NULL');
  }
  // DuckDB rejects SET NOT NULL with an explicit dependent index, even when
  // already NOT NULL. Install the new index only after the role upgrade and
  // avoid re-altering the established constraint on subsequent starts.
  await q.run(
    'CREATE UNIQUE INDEX IF NOT EXISTS users_name_key ON users(name_key)',
  );
}

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
    idForName(username: string): Promise<string | null> {
      return engine.exclusive((q) => userIdForName(q, username));
    },
    profile(username: string): Promise<UserProfile | null> {
      return engine.exclusive(async (q) =>
        (await q.all<UserProfile>(
          `SELECT name AS username, role FROM users WHERE name = ${
            esc(username)
          }`,
        ))[0] ?? null
      );
    },
    profiles(): Promise<UserProfile[]> {
      return engine.exclusive((q) =>
        q.all<UserProfile>(
          'SELECT name AS username, role FROM users ORDER BY name',
        )
      );
    },
    count(): Promise<number> {
      return engine.exclusive(async (q) => {
        const rows = await q.all<{ n: number }>(
          'SELECT count(*) AS n FROM users',
        );
        return Number(rows[0]?.n ?? 0);
      });
    },
    adminCount(): Promise<number> {
      return engine.exclusive(async (q) =>
        Number(
          (await q.all<{ n: number }>(
            "SELECT count(*) AS n FROM users WHERE role = 'admin'",
          ))[0].n,
        )
      );
    },
    createFirstAdmin(input: Omit<NewUser, 'role' | 'email'>) {
      return atomic(engine, async (q) => {
        const rows = await q.all<{ n: number }>(
          "SELECT count(*) AS n FROM users WHERE role = 'admin'",
        );
        if (Number(rows[0].n) !== 0) throw new UserError('forbidden');
        return insertUser(q, { ...input, role: 'admin' });
      });
    },
    byId(id: string) {
      return engine.exclusive((q) => readUser(q, id));
    },
    get(caller: string, id: string) {
      return engine.exclusive(async (q) => {
        await requireCaller(q, caller, id);
        const user = await readUser(q, id);
        if (!user) throw new UserError('not_found');
        return user;
      });
    },
    list(caller: string) {
      return engine.exclusive(async (q) => {
        await requireCaller(q, caller);
        return (await q.all<StoredUser>(
          `SELECT ${fields} FROM users ORDER BY name, id`,
        )).map(userRecord);
      });
    },
    create(
      caller: string,
      input: {
        id: string;
        username: string;
        passwordEnc: string;
        role: UserProfile['role'];
        displayName?: string;
        email?: string;
      },
    ) {
      return atomic(engine, async (q) => {
        await requireCaller(q, caller);
        return insertUser(q, input);
      });
    },
    update(
      caller: string,
      id: string,
      input: {
        username?: string;
        displayName?: string | null;
        email?: string | null;
        role?: UserProfile['role'];
      },
    ) {
      return atomic(engine, async (q) => {
        const actor = await requireCaller(q, caller, id);
        const target = await readUser(q, id);
        if (!target) throw new UserError('not_found');
        if (
          (input.username !== undefined || input.role !== undefined) &&
          actor.role !== 'admin'
        ) throw new UserError('forbidden');
        if (input.role === 'user' && target.role === 'admin') {
          const admins = await q.all<{ n: number }>(
            "SELECT count(*) AS n FROM users WHERE role = 'admin'",
          );
          if (Number(admins[0].n) <= 1) throw new UserError('last_admin');
        }
        const changes: string[] = [];
        if (input.username !== undefined) {
          await checkName(q, input.username, id);
          changes.push(
            `name = ${esc(input.username)}`,
            `name_key = ${esc(input.username.toLowerCase())}`,
          );
        }
        if (input.role !== undefined) changes.push(`role = ${esc(input.role)}`);
        if (input.displayName !== undefined) {
          changes.push(
            `display_name = ${
              input.displayName ? esc(input.displayName) : 'NULL'
            }`,
          );
        }
        if (input.email !== undefined) {
          changes.push(`email = ${input.email ? esc(input.email) : 'NULL'}`);
        }
        if (changes.length) {
          await q.run(
            `UPDATE users SET ${changes.join(', ')} WHERE id = ${esc(id)}`,
          );
        }
        return (await readUser(q, id))!;
      });
    },
    credentials(identity: { username: string } | { id: string }) {
      return engine.exclusive(async (q) => {
        // One identical query for present/absent identities. Exact spelling
        // preserves access to each legacy case-colliding account.
        const rows = await q.all<StoredUser & { passwordEnc: string }>(
          `SELECT ${fields}, password_enc AS passwordEnc FROM users ORDER BY created_at, id`,
        );
        const row = 'id' in identity
          ? rows.find((r) => r.id === identity.id)
          : rows.find((r) => r.username === identity.username) ??
            rows.find((r) =>
              r.username.toLowerCase() === identity.username.toLowerCase()
            );
        if (!row) return null;
        const { passwordEnc, ...user } = row;
        return { user: userRecord(user), passwordEnc };
      });
    },
    setPassword(
      caller: string,
      id: string,
      passwordEnc: string,
      expected?: string,
    ) {
      return atomic(engine, async (q) => {
        await requireCaller(q, caller, id);
        const target = await readUser(q, id);
        if (!target) throw new UserError('not_found');
        if (caller === id) {
          const row = (await q.all<{ password_enc: string }>(
            `SELECT password_enc FROM users WHERE id = ${esc(id)}`,
          ))[0];
          if (expected === undefined || row.password_enc !== expected) {
            throw new UserError('invalid_credentials');
          }
        }
        await q.run(
          `UPDATE users SET password_enc = ${esc(passwordEnc)} WHERE id = ${
            esc(id)
          }`,
        );
        return endUserSessions(q, id);
      });
    },
    noteAccess(id: string, now: number, intervalMs: number) {
      return engine.exclusive((q) =>
        q.run(
          `UPDATE users SET last_access_at = epoch_ms(${now}) WHERE id = ${
            esc(id)
          }
        AND (last_access_at IS NULL OR epoch_ms(last_access_at) <= ${
            now - intervalMs
          })`,
        )
      );
    },
    seedFirst(id: string, name: string, passwordEnc: string): Promise<void> {
      return atomic(engine, async (q) => {
        const rows = await q.all<{ n: number }>(
          'SELECT count(*) AS n FROM users',
        );
        if (Number(rows[0]?.n ?? 0) > 0) return;
        await q.run(
          `INSERT INTO users (id, name, password_enc, created_at, role, name_key) VALUES (${
            esc(id)
          }, ${esc(name)}, ${esc(passwordEnc)}, now(), 'admin', ${
            esc(name.toLowerCase())
          })`,
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
      // Compatibility for existing consumers; pure TypeScript, no SQL slot.
      return Promise.resolve(passwordToken(passwordAndSalt));
    },
  };
}
