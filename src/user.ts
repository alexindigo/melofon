// src/user.ts — app.user: credential verification for hats. Subsonic token
// auth is md5(password + salt) per request, so M0's recoverable-password
// design is the enabler: core decrypts server-side (the layer never sees a
// password) and does the md5 math (DuckDB's md5() — Web Crypto has none).
// Success → { username, displayName }; failure → null. Unknown user and bad
// password are indistinguishable to the caller (no user enumeration).
import type { Config } from './config.ts';
import type { Store } from './store/index.ts';
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

export function createUserService(store: Store, cfg: Config): UserService {
  async function passwordOf(username: string): Promise<string | null> {
    if (cfg.secret === undefined) return null;
    const encrypted = await store.users.passwordForName(username);
    if (encrypted === null) return null;
    return await decryptPassword(cfg.secret, encrypted);
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
      const hash = await store.users.passwordToken(stored + salt);
      if (hash !== token.toLowerCase()) return null;
      return { username, displayName: username };
    },
  };
}
