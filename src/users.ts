// src/users.ts — first-boot user seed. Subsonic token auth is
// md5(password + salt) per request, so bcrypt-only cannot verify it later;
// the password is stored encrypted (AES-256-GCM, key from MELOFON_SECRET via
// SHA-256) and can be recovered server-side when a client authenticates.
// Never log the secret or the password.
import { encodeHex } from '@std/encoding/hex';
import type { Config } from './config.ts';
import type { Store } from './store/index.ts';
import type { PasswordVerifier } from './password-verifier.ts';
import type { Sessions } from './sessions.ts';
import type { State } from './state.ts';
import { UserError } from './user-errors.ts';
import type { Notify } from './notify.ts';
export type { UserProfile } from './store/users.ts';
export { UserError } from './user-errors.ts';

/** Directory access is core policy, separate from credential verification. */
export function createUsers(store: Store, options: {
  cfg: Pick<Config, 'secret'>;
  verifier: PasswordVerifier;
  sessions: Sessions;
  state: State;
  now?: () => number;
  notify?: Notify;
}) {
  const { cfg, verifier, sessions, state } = options;
  const now = options.now ?? Date.now;
  const changed = (id: string) => {
    options.notify?.emit(['users'], { users: [id] }, 'admins');
    options.notify?.emit(['me'], { me: [id] }, { userId: id });
  };
  state.declare('auth.passwordMinLength', {
    type: 'integer',
    minimum: 8,
    default: 8,
  });
  state.declare('auth.accessUpdateSeconds', {
    type: 'integer',
    minimum: 60,
    default: 60,
  });
  async function encryptNew(password: string) {
    if (
      Array.from(password).length <
        Number(await state.getTyped('auth.passwordMinLength'))
    ) throw new UserError('password_too_short');
    if (cfg.secret === undefined) {
      throw new Error('MELOFON_SECRET is required to store passwords');
    }
    return encryptPassword(cfg.secret, password);
  }
  return {
    get: store.users.get,
    list: store.users.list,
    async createFirstAdmin(input: {
      username: string;
      password: string;
      displayName?: string;
    }) {
      const { password, ...details } = input;
      const user = await store.users.createFirstAdmin({
        ...details,
        id: crypto.randomUUID(),
        passwordEnc: await encryptNew(password),
      });
      changed(user.id);
      return user;
    },
    async create(
      caller: string,
      input: {
        username: string;
        password: string;
        role: 'admin' | 'user';
        displayName?: string;
        email?: string;
      },
    ) {
      // Fail authorization before processing credentials; store rechecks it at commit.
      await store.users.list(caller);
      const { password, ...details } = input;
      const user = await store.users.create(caller, {
        ...details,
        id: crypto.randomUUID(),
        passwordEnc: await encryptNew(password),
      });
      changed(user.id);
      return user;
    },
    async update(
      caller: string,
      target: string,
      input: Parameters<Store['users']['update']>[2],
    ) {
      const user = await store.users.update(caller, target, input);
      changed(user.id);
      return user;
    },
    async setRole(caller: string, target: string, role: 'admin' | 'user') {
      const user = await store.users.update(caller, target, { role });
      changed(user.id);
      return user;
    },
    async setPassword(
      caller: string,
      target: string,
      input: { current?: string; new: string },
    ) {
      await store.users.get(caller, target);
      let expected: string | undefined;
      if (caller === target) {
        const verified = await verifier({ id: target }, {
          password: input.current ?? '',
        });
        if (input.current === undefined || !verified) {
          throw new UserError('invalid_credentials');
        }
        expected = verified.passwordEnc;
      }
      const ids = await store.users.setPassword(
        caller,
        target,
        await encryptNew(input.new),
        expected,
      );
      sessions.ended({ userId: target, sessionIds: ids });
      changed(target);
    },
    async noteAccess(id: string) {
      await store.users.noteAccess(
        id,
        now(),
        Number(await state.getTyped('auth.accessUpdateSeconds')) * 1000,
      );
    },
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return await crypto.subtle.importKey('raw', digest, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptPassword(
  secret: string,
  plaintext: string,
): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoder.encode(plaintext),
    ),
  );
  return `${encodeHex(iv)}:${encodeHex(ct)}`;
}

export async function decryptPassword(
  secret: string,
  stored: string,
): Promise<string> {
  const [ivHex, ctHex] = stored.split(':');
  if (!ivHex || !ctHex) throw new Error('stored password is malformed');
  const key = await deriveKey(secret);
  const hexToBytes = (h: string) =>
    new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)));
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: hexToBytes(ivHex) },
    key,
    hexToBytes(ctHex),
  );
  return decoder.decode(pt);
}

export async function seedFirstUser(store: Store, cfg: Config): Promise<void> {
  const count = await store.users.count();
  if (count > 0) return; // existing users are never overwritten from env
  if (!cfg.user || !cfg.password) return;
  if (!cfg.secret) {
    throw new Error(
      'MELOFON_SECRET is required to seed the first user (encrypts the stored password)',
    );
  }
  const enc = await encryptPassword(cfg.secret, cfg.password);
  await store.users.seedFirst(crypto.randomUUID(), cfg.user, enc);
}
