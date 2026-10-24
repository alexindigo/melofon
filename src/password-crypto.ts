import { createHash, timingSafeEqual } from 'node:crypto';

// Same built-in node:crypto boundary as src/stream.ts (createHash and
// timingSafeEqual). MD5 is required by Subsonic, never delegated to SQL.
export function passwordToken(passwordAndSalt: string): string {
  return createHash('md5').update(passwordAndSalt).digest('hex');
}

/** Fixed-size digests avoid a length-dependent comparison/early return. */
export function equalCredentials(actual: string, expected: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(actual), digest(expected));
}
