// src/users.ts — first-boot user seed. Subsonic token auth is
// md5(password + salt) per request, so bcrypt-only cannot verify it later;
// the password is stored encrypted (AES-256-GCM, key from MELOFON_SECRET via
// SHA-256) and can be recovered server-side when a client authenticates.
// Never log the secret or the password.
import { encodeHex } from '@std/encoding/hex';
import type { Config } from './config.ts';
import type { Db } from './db.ts';

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

function esc(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function seedFirstUser(db: Db, cfg: Config): Promise<void> {
  const res = await db.conn.runAndReadAll('SELECT count(*) AS n FROM users');
  const rows = res.getRowObjects() as { n: bigint | number }[];
  const count = Number(rows[0]?.n ?? 0);
  if (count > 0) return; // existing users are never overwritten from env
  if (!cfg.user || !cfg.password) return;
  if (!cfg.secret) {
    throw new Error(
      'MELOFON_SECRET is required to seed the first user (encrypts the stored password)',
    );
  }
  const enc = await encryptPassword(cfg.secret, cfg.password);
  await db.conn.run(
    `INSERT INTO users (id, name, password_enc, created_at) VALUES (${
      esc(crypto.randomUUID())
    }, ${esc(cfg.user)}, ${esc(enc)}, now())`,
  );
}
