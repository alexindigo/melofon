import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Wildcard bind addresses are never meaningful outbound destinations. */
export function unspecifiedAddress(address: string): boolean {
  if (isIP(address) === 4) return address === '0.0.0.0';
  if (isIP(address) !== 6) return false;
  const normalized = new URL(`http://[${address}]/`).hostname;
  return normalized === '[::]' || normalized === '[::ffff:0:0]';
}

/** Only global unicast destinations. URL parsing canonicalizes unusual IPv4 spellings. */
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && (b === 168 || b === 0) ||
      a === 198 && (b === 18 || b === 19) ||
      a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(address) !== 6) return false;
  // URL canonicalization expands embedded IPv4 to hex. Treat mapped IPv4 by
  // its underlying policy, never as an independent public IPv6 destination.
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const mapped = normalized.match(/^::ffff:([\da-f]+):([\da-f]+)$/i);
  if (mapped) {
    const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16);
    return publicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  // Global IPv6 unicast is 2000::/3. This also excludes unspecified,
  // loopback, link-local, unique-local, multicast and transition prefixes.
  const first = parseInt(normalized.split(':')[0], 16);
  return first >= 0x2000 && first <= 0x3fff &&
    !normalized.startsWith('2001:db8:') && !normalized.startsWith('2002:');
}

export async function resolveAddresses(host: string): Promise<string[]> {
  const name = host.replace(/^\[|\]$/g, '');
  if (isIP(name)) return [name];
  return (await lookup(name, { all: true })).map((answer) => answer.address);
}

/** DNS itself is not cancellable; its result can never outlive call authority. */
export function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() =>
      signal.removeEventListener('abort', abort)
    );
  });
}
