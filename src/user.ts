// src/user.ts — app.user: credential verification for hats. Subsonic token
// auth is md5(password + salt) per request, so M0's recoverable-password
// design is the enabler: core decrypts server-side (the layer never sees a
// password). Verification, including md5 math, has one core owner.
// Success → { username, displayName }; failure → null. Unknown user and bad
// password are indistinguishable to the caller (no user enumeration).
import type { Config } from './config.ts';
import type { Store } from './store/index.ts';
import type { UserProfile } from './users.ts';
import {
  createPasswordVerifier,
  type PasswordVerifier,
} from './password-verifier.ts';

export interface StateUser {
  username: string;
  displayName: string;
}

export interface UserService {
  get(
    caller: string,
    username: string,
  ): Promise<UserProfile | null | 'forbidden'>;
  list(caller: string): Promise<UserProfile[] | 'forbidden'>;
  /** Classic password (Subsonic `p`, later Jellyfin AuthenticateByName). */
  auth(username: string, password: string): Promise<StateUser | null>;
  /** Subsonic `t`+`s`: token = md5(password + salt), lowercase hex. */
  authMd5(
    username: string,
    token: string,
    salt: string,
  ): Promise<StateUser | null>;
}

export function createUserService(store: Store, cfg: Config, options: {
  verifier?: PasswordVerifier;
  noteAccess?: (id: string) => Promise<void>;
} = {}): UserService {
  const verify = options.verifier ?? createPasswordVerifier(store, cfg);
  async function result(record: Awaited<ReturnType<PasswordVerifier>>) {
    if (!record) return null;
    await options.noteAccess?.(record.user.id);
    return {
      username: record.user.username,
      displayName: record.user.displayName,
    };
  }

  return {
    async get(caller, username) {
      const actor = await store.users.profile(caller);
      if (!actor || (caller !== username && actor.role !== 'admin')) {
        return 'forbidden';
      }
      return store.users.profile(username);
    },
    async list(caller) {
      if ((await store.users.profile(caller))?.role !== 'admin') {
        return 'forbidden';
      }
      return store.users.profiles();
    },
    async auth(username, password) {
      return result(await verify({ username }, { password }));
    },

    async authMd5(username, token, salt) {
      return result(await verify({ username }, { token, salt }));
    },
  };
}
