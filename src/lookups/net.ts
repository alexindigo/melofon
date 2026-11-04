import { type Log, scopedLog } from '../logging.ts';
import type { State } from '../state.ts';
import { hostPattern } from './manifest.ts';
import {
  abortable,
  publicAddress,
  resolveAddresses,
  unspecifiedAddress,
} from '../net-address.ts';
import { pinnedRequest } from '../net-transport.ts';

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
  /** Operator-approved hosts; also the trust context for plugin requests. */
  hosts: string[];
  ratePerMinute: number;
  signal: AbortSignal;
}
export interface CoreNetworkAuthority {
  caller: string;
  /** Core owner policy, evaluated on every logical redirect URL. */
  hosts: (url: URL) => boolean;
  /** Hosts entered by the user, never hosts learned from fetched content. */
  trustedHosts: string[];
  ratePerMinute: number;
  signal: AbortSignal;
}
type Authority = NetworkAuthority | CoreNetworkAuthority;
type Limits = { timeoutMs: number; maxBytes: number };
export interface StreamLimits {
  /** Whole open budget, including rate waits, DNS and all redirect headers. */
  openTimeoutMs: number;
  /** Pending body-read budget; downstream backpressure is not upstream idleness. */
  idleTimeoutMs: number;
}
export interface OwnedResponse {
  response: Response;
  /** Final logical URL, not a fixture endpoint or a newly trusted address. */
  url: string;
  /** Idempotent; also releases an unread body or a pending read. */
  close(): Promise<void>;
}

async function ownResponse(
  response: Response,
  url: string,
  signal: AbortSignal,
  arm: () => void,
  disarm: () => void,
  release: () => Promise<void>,
): Promise<OwnedResponse> {
  const reader = response.body?.getReader();
  if (!reader) {
    await release();
    return { response, url, close: () => Promise.resolve() };
  }
  let output: ReadableStreamDefaultController<Uint8Array>;
  let finished = false;
  let closing: Promise<void> | undefined;
  const finish = () => {
    if (closing) return closing;
    finished = true;
    disarm();
    signal.removeEventListener('abort', abort);
    closing = (async () => {
      try {
        await reader.cancel();
      } catch {
        /* Preserve the original body failure. */
      } finally {
        reader.releaseLock();
        await release();
      }
    })();
    return closing;
  };
  const abort = () => {
    if (finished) return;
    output.error(signal.reason);
    void finish();
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      if (finished) return;
      try {
        arm();
        const part = await abortable(reader.read(), signal);
        disarm();
        if (finished) return;
        if (part.done) {
          controller.close();
          await finish();
        } else controller.enqueue(part.value);
      } catch (error) {
        if (!finished) controller.error(error);
        await finish();
      }
    },
    cancel: finish,
  }, { highWaterMark: 0 });
  return {
    response: new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    url,
    close() {
      if (!finished) {
        output.error(new DOMException('Response stream closed', 'AbortError'));
      }
      return finish();
    },
  };
}
export function createLookupNetwork(options: {
  version?: string;
  log?: Log;
  state?: Pick<State, 'declare' | 'getTyped'>;
  /** Test-only origin mapping; original authority is always checked first. */
  fixtures?: Record<string, string>;
  /** Test-only DNS answers; connections are still pinned to checked addresses. */
  resolve?: (host: string) => Promise<string[]>;
  /** Test-only trust anchor; verification and hostname checks stay enabled. */
  ca?: string;
} = {}) {
  const log = options.log ?? scopedLog('lookups');
  const next = new Map<string, number>();
  options.state?.declare('net.maxRedirects', {
    type: 'integer',
    default: 5,
    minimum: 0,
    maximum: 20,
  });
  const streamDeclarations = {
    streamOpenTimeoutSeconds: {
      type: 'number',
      default: 10,
      minimum: 0.001,
      maximum: 600,
    },
    streamBodyIdleSeconds: {
      type: 'number',
      default: 10,
      minimum: 0.001,
      maximum: 600,
    },
    streamBufferBytes: {
      type: 'integer',
      default: 65536,
      minimum: 1,
      maximum: 1048576,
    },
  };
  for (const [key, schema] of Object.entries(streamDeclarations)) {
    options.state?.declare(`net.${key}`, schema);
  }
  const declarations = {
    requestTimeoutSeconds: {
      type: 'number',
      default: 10,
      minimum: 0.001,
      maximum: 600,
    },
    bodyIdleSeconds: {
      type: 'number',
      default: 10,
      minimum: 0.001,
      maximum: 600,
    },
    requestAttempts: {
      type: 'integer',
      default: 2,
      minimum: 1,
      maximum: 10,
    },
  };
  for (const [key, schema] of Object.entries(declarations)) {
    options.state?.declare(`lookups.${key}`, schema);
  }
  const settings = async () => {
    const read = async (key: keyof typeof declarations) =>
      Number(
        await options.state?.getTyped(`lookups.${key}`) ??
          declarations[key].default,
      );
    return {
      responseMs: await read('requestTimeoutSeconds') * 1000,
      idleMs: await read('bodyIdleSeconds') * 1000,
      attempts: await read('requestAttempts'),
    };
  };
  async function execute(
    authority: Authority,
    input: string,
    init: RequestInit,
    limits: Limits,
    destination?: string,
    stream?: { idleMs: number; bufferBytes: number },
  ): Promise<{ response: Response; size: number; lease?: OwnedResponse }> {
    const caller = 'caller' in authority ? authority.caller : authority.plugin;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      authority.signal,
      ...(init.signal ? [init.signal] : []),
      controller.signal,
    ]);
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(
            stream ? 'Stream open timed out' : 'Lookup request timed out',
          ),
        ),
      limits.timeoutMs,
    );
    try {
      let url = new URL(input);
      const initialHost = url.hostname;
      const trustedHosts = 'caller' in authority
        ? authority.trustedHosts
        : authority.hosts;
      const budget = stream
        ? { responseMs: limits.timeoutMs, idleMs: stream.idleMs, attempts: 1 }
        : await settings();
      const maxRedirects = Number(
        await options.state?.getTyped('net.maxRedirects') ?? 5,
      );
      for (let redirects = 0; redirects <= maxRedirects; redirects++) {
        const host = url.hostname;
        for (let attempt = 1; attempt <= budget.attempts; attempt++) {
          let status: string | number = 'error';
          const request = new AbortController();
          const requestSignal = AbortSignal.any([signal, request.signal]);
          let phaseTimer: ReturnType<typeof setTimeout> | undefined;
          const arm = (ms: number, phase: string) => {
            clearTimeout(phaseTimer);
            phaseTimer = setTimeout(
              () => request.abort(new Error(`Lookup ${phase} timed out`)),
              ms,
            );
          };
          let transportFailure = false;
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
          let transport: Awaited<ReturnType<typeof pinnedRequest>> | undefined;
          let file: Deno.FsFile | undefined;
          let partial: string | undefined;
          let transferred = false;
          const release = async () => {
            clearTimeout(phaseTimer);
            request.abort();
            try {
              await reader?.cancel();
            } catch {
              // The original fetch/read failure (or abort reason) owns the
              // outcome; an already-errored stream cannot be cancelled again.
            } finally {
              reader?.releaseLock();
              file?.close();
              if (partial) await Deno.remove(partial);
              await transport?.close();
              log.event('lookup_request', { plugin: caller, host, status });
            }
          };
          try {
            signal.throwIfAborted();
            if (
              !['http:', 'https:'].includes(url.protocol) || url.username ||
              url.password || !(typeof authority.hosts === 'function'
                ? authority.hosts(url)
                : authority.hosts.some((p) =>
                  matchesHost(p, host)
                ))
            ) throw new Error(`Host not granted: ${host}`);
            const start = Math.max(
              Date.now(),
              next.get(caller) ?? 0,
            );
            next.set(
              caller,
              start + 60000 / authority.ratePerMinute,
            );
            // Every attempt/hop reserves a slot. Rate waits are bounded by the
            // caller/job budget, not by the time allowed for a server response.
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
            arm(budget.responseMs, 'response');
            transportFailure = true;
            const addresses = await abortable(
              (options.resolve ?? resolveAddresses)(target.hostname),
              requestSignal,
            );
            transportFailure = false;
            // Redirects do not extend the user's trust to a new host. Trust
            // belongs to the original context, not to an address's DNS answer.
            const trusted = trustedHosts.some((pattern) =>
              matchesHost(pattern, host)
            ) &&
              (redirects === 0 || host === initialHost);
            if (
              !addresses.length ||
              addresses.some(unspecifiedAddress) ||
              !trusted && !endpoint &&
                addresses.some((address) => !publicAddress(address))
            ) {
              throw new Error(
                `Private or non-public destination refused: ${host}`,
              );
            }
            signal.throwIfAborted();
            transportFailure = true;
            transport = await pinnedRequest(
              target,
              addresses[(attempt - 1) % addresses.length],
              {
                ...init,
                headers,
              },
              requestSignal,
              options.ca,
              stream?.bufferBytes,
            );
            const response = transport.response;
            transportFailure = false;
            clearTimeout(phaseTimer);
            status = response.status;
            if (
              [301, 302, 303, 307, 308].includes(response.status) &&
              response.headers.has('location')
            ) {
              await response.body?.cancel();
              url = new URL(response.headers.get('location')!, url);
              break;
            }
            if (stream) {
              signal.throwIfAborted();
              const lease = await ownResponse(
                response,
                url.href,
                requestSignal,
                () => arm(stream.idleMs, 'body idle'),
                () => clearTimeout(phaseTimer),
                release,
              );
              transferred = true;
              return { response: lease.response, size: 0, lease };
            }
            reader = response.body?.getReader();
            const chunks: Uint8Array[] = [];
            let length = 0;
            if (
              Number(response.headers.get('content-length')) > limits.maxBytes
            ) {
              throw new Error('Lookup response exceeds size cap');
            }
            if (destination) {
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              partial = `${destination}.${crypto.randomUUID()}.part`;
              file = await Deno.open(partial, { createNew: true, write: true });
            }
            while (reader) {
              arm(budget.idleMs, 'body idle');
              transportFailure = true;
              const part = await reader.read();
              transportFailure = false;
              clearTimeout(phaseTimer);
              if (part.done) break;
              length += part.value.length;
              if (length > limits.maxBytes) {
                throw new Error('Lookup response exceeds size cap');
              }
              if (file) {
                let offset = 0;
                while (offset < part.value.length) {
                  signal.throwIfAborted();
                  offset += await file.write(part.value.subarray(offset));
                }
              } else chunks.push(part.value);
            }
            signal.throwIfAborted();
            if (file) {
              file.close();
              file = undefined;
              await Deno.rename(partial!, destination!);
              partial = undefined;
              return {
                response: new Response(null, {
                  status: response.status,
                  headers: response.headers,
                }),
                size: length,
              };
            }
            const bytes = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.length;
            }
            return {
              response: new Response(
                [204, 205, 304].includes(response.status) ? null : bytes,
                {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                },
              ),
              size: length,
            };
          } catch (error) {
            // Caller cancellation/revocation is never retried. HTTP status,
            // grants, redirect policy and size caps are not transport failures.
            signal.throwIfAborted();
            if (!transportFailure || attempt === budget.attempts) {
              throw request.signal.aborted ? request.signal.reason : error;
            }
          } finally {
            if (!transferred) await release();
          }
        }
      }
      throw new Error('Too many lookup redirects');
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    /** Core-only streaming lease. Published body failures are never retried. */
    async stream(
      authority: CoreNetworkAuthority,
      input: string,
      init: RequestInit = {},
      limits?: StreamLimits,
    ): Promise<OwnedResponse> {
      const read = async (key: keyof typeof streamDeclarations) =>
        Number(
          await options.state?.getTyped(`net.${key}`) ??
            streamDeclarations[key].default,
        );
      const openMs = limits?.openTimeoutMs ??
        await read('streamOpenTimeoutSeconds') * 1000;
      const idleMs = limits?.idleTimeoutMs ??
        await read('streamBodyIdleSeconds') * 1000;
      const bufferBytes = await read('streamBufferBytes');
      if (
        ![openMs, idleMs].every((value) => Number.isFinite(value) && value > 0)
      ) {
        throw new Error('Stream timeouts must be positive and finite');
      }
      const result = await execute(
        authority,
        input,
        init,
        {
          timeoutMs: openMs,
          maxBytes: Infinity,
        },
        undefined,
        { idleMs, bufferBytes },
      );
      return result.lease!;
    },
    async fetch(
      authority: Authority,
      input: string,
      init: RequestInit = {},
      limits: Limits,
    ): Promise<Response> {
      return (await execute(authority, input, init, limits)).response;
    },
    async toFile(
      authority: Authority,
      input: string,
      destination: string,
      limits: Limits,
    ): Promise<{ size: number; contentType: string | null }> {
      const { response, size } = await execute(
        authority,
        input,
        {},
        limits,
        destination,
      );
      return { size, contentType: response.headers.get('content-type') };
    },
  };
}
export const createNetwork = createLookupNetwork;
export type LookupNetwork = ReturnType<typeof createLookupNetwork>;
