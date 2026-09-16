// src/user.ts — app.user: credential verification for hats. Subsonic token
// auth is md5(password + salt) per request, so M0's recoverable-password
// design is the enabler: core decrypts server-side (the layer never sees a
// password) and does the md5 math (DuckDB's md5() — Web Crypto has none).
// Success → { username, displayName }; failure → null. Unknown user and bad
// password are indistinguishable to the caller (no user enumeration).
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { decryptPassword } from './users.ts';

export interface StateUser {
  username: string;
  displayName: string;
}

export interface UserService {
  /** Classic password (Subsonic `p`, later Jellyfin AuthenticateByName). */
  auth(username: string, password: string): Promise<StateUser | null>;
  /** Subsonic `t`+`s`: token = md5(password + salt), lowercase hex. */
  authMd5(
    username: string,
    token: string,
    salt: string,
  ): Promise<StateUser | null>;
}

function esc(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function createUserService(db: Db, cfg: Config): UserService {
  async function passwordOf(username: string): Promise<string | null> {
    if (cfg.secret === undefined) return null;
    const res = await db.conn.runAndReadAll(
      `SELECT password_enc FROM users WHERE name = ${esc(username)}`,
    );
    const row = (res.getRowObjects() as { password_enc: string }[])[0];
    if (!row) return null;
    return await decryptPassword(cfg.secret, row.password_enc);
  }

  return {
    async auth(username, password) {
      const stored = await passwordOf(username);
      if (stored === null || stored !== password) return null;
      return { username, displayName: username };
    },

    async authMd5(username, token, salt) {
      const stored = await passwordOf(username);
      if (stored === null) return null;
      const res = await db.conn.runAndReadAll(
        `SELECT md5(${esc(stored + salt)}) AS h`,
      );
      const hash = (res.getRowObjects() as { h: string }[])[0].h;
      if (hash !== token.toLowerCase()) return null;
      return { username, displayName: username };
    },
  };
}
