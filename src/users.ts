// src/users.ts — first-boot user seed. Subsonic token auth is
// md5(password + salt) per request, so bcrypt-only cannot verify it later;
// the password is stored encrypted (AES-256-GCM, key from MELOFON_SECRET via
// SHA-256) and can be recovered server-side when a client authenticates.
// Never log the secret or the password.
import { encodeHex } from '@std/encoding/hex';
import type { Config } from './config.ts';
import type { Store } from './store/index.ts';
export type { UserProfile } from './store/users.ts';

/** Directory access is core policy, separate from credential verification. */
export function createUsers(store: Store) {
  return {
    async get(caller: string, username: string) {
      const user = await store.users.profile(caller);
      if (user === null || (caller !== username && user.role !== 'admin')) {
        return 'forbidden' as const;
      }
      return await store.users.profile(username);
    },
    async list(caller: string) {
      if ((await store.users.profile(caller))?.role !== 'admin') {
        return 'forbidden' as const;
      }
      return await store.users.profiles();
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
