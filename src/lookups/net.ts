import { type Log, scopedLog } from '../logging.ts';
import { hostPattern } from './manifest.ts';

export function matchesHost(pattern: string, host: string): boolean {
  return pattern.startsWith('*.')
    ? host.endsWith(pattern.slice(1)) && host !== pattern.slice(2)
    : host === pattern;
}
export function intersectHosts(
  requested: string[],
  approved: string[],
): string[] {
  const result = new Set<string>();
  const subset = (a: string, b: string) =>
    a === b ||
    b.startsWith('*.') && (a.startsWith('*.')
        ? a.slice(2).endsWith(b.slice(1))
        : matchesHost(b, a));
  for (const a of requested.map(hostPattern)) {
    for (const b of approved.map(hostPattern)) {
      if (subset(a, b)) {
        result.add(a);
      } else if (subset(b, a)) result.add(b);
    }
  }
  return [...result].sort();
}
export async function parentGrant(hosts: string[]): Promise<string[]> {
  const all = await Deno.permissions.query({ name: 'net' });
  if (all.state === 'granted' && !all.partial) return hosts;
  const result: string[] = [];
  for (const host of hosts) {
    try {
      const status = await Deno.permissions.query({ name: 'net', host });
      if (status.state === 'granted' && !status.partial) result.push(host);
    } catch { /* A scope that cannot be delegated grants nothing. */ }
  }
  return result;
}
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, Math.max(0, ms));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
export interface NetworkAuthority {
  plugin: string;
  hosts: string[];
  ratePerMinute: number;
  signal: AbortSignal;
}
export function createLookupNetwork(options: {
  version?: string;
  log?: Log;
  /** Test-only origin mapping; original authority is always checked first. */
  fixtures?: Record<string, string>;
} = {}) {
  const log = options.log ?? scopedLog('lookups');
  const next = new Map<string, number>();
  return {
    async fetch(
      authority: NetworkAuthority,
      input: string,
      init: RequestInit = {},
      limits: { timeoutMs: number; maxBytes: number },
    ): Promise<Response> {
      const controller = new AbortController();
      const signal = AbortSignal.any([
        authority.signal,
        ...(init.signal ? [init.signal] : []),
        controller.signal,
      ]);
      const timer = setTimeout(
        () => controller.abort(new Error('Lookup request timed out')),
        limits.timeoutMs,
      );
      let url = new URL(input);
      try {
        for (let redirects = 0; redirects <= 5; redirects++) {
          let status: string | number = 'error';
          const host = url.hostname;
          try {
            signal.throwIfAborted();
            if (
              !['http:', 'https:'].includes(url.protocol) || url.username ||
              url.password || !authority.hosts.some((p) => matchesHost(p, host))
            ) throw new Error(`Host not granted: ${host}`);
            const start = Math.max(Date.now(), next.get(authority.plugin) ?? 0);
            next.set(authority.plugin, start + 60000 / authority.ratePerMinute);
            await delay(start - Date.now(), signal);
            signal.throwIfAborted();
            const endpoint = options.fixtures?.[host];
            const target = endpoint
              ? new URL(`${url.pathname}${url.search}`, endpoint)
              : url;
            const headers = new Headers(init.headers);
            headers.set(
              'user-agent',
              `Melofon/${
                options.version ?? '0.1.0'
              } (+https://github.com/alexindigo/melofon)`,
            );
            const response = await fetch(target, {
              ...init,
              headers,
              signal,
              redirect: 'manual',
            });
            status = response.status;
            if (
              [301, 302, 303, 307, 308].includes(response.status) &&
              response.headers.has('location')
            ) {
              await response.body?.cancel();
              url = new URL(response.headers.get('location')!, url);
              continue;
            }
            const reader = response.body?.getReader();
            const chunks: Uint8Array[] = [];
            let length = 0;
            try {
              if (
                Number(response.headers.get('content-length')) > limits.maxBytes
              ) throw new Error('Lookup response exceeds size cap');
              while (reader) {
                const part = await reader.read();
                if (part.done) break;
                length += part.value.length;
                if (length > limits.maxBytes) {
                  throw new Error('Lookup response exceeds size cap');
                }
                chunks.push(part.value);
              }
            } finally {
              await reader?.cancel();
            }
            const bytes = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.length;
            }
            return new Response(
              [204, 205, 304].includes(response.status) ? null : bytes,
              {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              },
            );
          } finally {
            log.event('lookup_request', {
              plugin: authority.plugin,
              host,
              status,
            });
          }
        }
        throw new Error('Too many lookup redirects');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
export type LookupNetwork = ReturnType<typeof createLookupNetwork>;
