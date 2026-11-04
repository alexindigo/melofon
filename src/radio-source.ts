import type {
  CoreNetworkAuthority,
  LookupNetwork,
  OwnedResponse,
} from './lookups/net.ts';
import type { State } from './state.ts';

export class RadioSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RadioSourceError';
  }
}

type Playlist = 'pls' | 'm3u';
type Candidate = { url: string; ancestors: string[]; depth: number };

function address(input: string, base?: string): string {
  const url = new URL(input, base);
  if (
    !['http:', 'https:'].includes(url.protocol) || url.username || url.password
  ) {
    throw new RadioSourceError(
      'Radio sources require HTTP(S) without userinfo',
    );
  }
  url.hash = '';
  return url.href;
}

function playlistType(lease: OwnedResponse): Playlist | undefined {
  const path = new URL(lease.url).pathname.toLowerCase();
  const mime = (lease.response.headers.get('content-type') ?? '').split(';')[0]
    .trim().toLowerCase();
  if (
    path.endsWith('.m3u8') || mime === 'application/vnd.apple.mpegurl' ||
    mime === 'audio/vnd.apple.mpegurl'
  ) throw new RadioSourceError('HLS radio is not supported');
  if (path.endsWith('.pls') || mime === 'audio/x-scpls') return 'pls';
  if (
    path.endsWith('.m3u') ||
    ['audio/mpegurl', 'audio/x-mpegurl', 'application/x-mpegurl'].includes(mime)
  ) return 'm3u';
}

function entries(text: string, type: Playlist, max: number): string[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) =>
    line.trim()
  );
  if (lines.some((line) => /^#EXT-X-/i.test(line))) {
    throw new RadioSourceError('HLS radio is not supported');
  }
  let result: string[];
  if (type === 'pls') {
    if (!lines.some((line) => /^\[playlist\]$/i.test(line))) {
      throw new RadioSourceError('Invalid PLS playlist');
    }
    const files = new Map<number, string>();
    for (const line of lines) {
      const match = /^File(\d+)\s*=(.*)$/i.exec(line);
      if (!match) continue;
      const index = Number(match[1]);
      if (!Number.isSafeInteger(index) || index < 1 || files.has(index)) {
        throw new RadioSourceError('Invalid PLS file index');
      }
      files.set(index, match[2].trim());
      if (files.size > max) {
        throw new RadioSourceError('Radio playlist entry limit exceeded');
      }
    }
    result = [...files].sort(([a], [b]) => a - b).map(([, url]) => url);
  } else {
    result = [];
    for (const line of lines) {
      if (!line || line.startsWith('#')) continue;
      result.push(line);
      if (result.length > max) {
        throw new RadioSourceError('Radio playlist entry limit exceeded');
      }
    }
  }
  if (!result.length || result.some((url) => !url)) {
    throw new RadioSourceError('Radio playlist has no usable entries');
  }
  return result;
}

/** Replay the bounded inspection prefix, then transfer pulls to the net lease.
 * Abort/close also revoke an unread prefix, not only a future upstream read. */
function replay(
  lease: OwnedResponse,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  prefix: Uint8Array[],
  signal: AbortSignal,
): OwnedResponse {
  let output: ReadableStreamDefaultController<Uint8Array>;
  let finished = false;
  let closing: Promise<void> | undefined;
  const finish = () => {
    if (closing) return closing;
    finished = true;
    prefix = [];
    signal.removeEventListener('abort', abort);
    closing = (async () => {
      try {
        await reader.cancel();
      } catch {
        /* Preserve the original source failure. */
      } finally {
        reader.releaseLock();
        await lease.close();
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
        if (prefix.length) {
          controller.enqueue(prefix.shift()!);
          return;
        }
        const part = await reader.read();
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
    url: lease.url,
    response: new Response(body, {
      status: lease.response.status,
      statusText: lease.response.statusText,
      headers: lease.response.headers,
    }),
    close() {
      if (!finished) {
        output.error(new DOMException('Radio source closed', 'AbortError'));
      }
      return finish();
    },
  };
}

export interface RadioSource {
  /** One caller-budgeted attempt. Success retains a single final response;
   * failure consumes that alternative, never silently attempts another one.
   * Subsequent calls try remaining alternatives depth-first in playlist order,
   * then re-resolve the entered URL. No retry count, backoff or queue mutation. */
  open(): Promise<OwnedResponse>;
  /** Revokes the session, including pending resolution and unread audio. */
  close(): Promise<void>;
}

export function createRadioSource(options: {
  network: Pick<LookupNetwork, 'stream'>;
  state?: Pick<State, 'declare' | 'getTyped'>;
}) {
  const declarations = {
    resolveTimeoutSeconds: {
      type: 'number',
      default: 10,
      minimum: 0.001,
      maximum: 600,
    },
    playlistMaxBytes: {
      type: 'integer',
      default: 65536,
      minimum: 1,
      maximum: 1048576,
    },
    playlistMaxDepth: { type: 'integer', default: 4, minimum: 1, maximum: 32 },
    playlistMaxDocuments: {
      type: 'integer',
      default: 16,
      minimum: 1,
      maximum: 1024,
    },
    playlistMaxEntries: {
      type: 'integer',
      default: 128,
      minimum: 1,
      maximum: 8192,
    },
    playlistProbeBytes: {
      type: 'integer',
      default: 512,
      minimum: 16,
      maximum: 65536,
    },
    sourceRequestsPerMinute: {
      type: 'number',
      default: 600,
      minimum: 1,
      maximum: 600000,
    },
  };
  for (const [key, schema] of Object.entries(declarations)) {
    options.state?.declare(`radio.${key}`, schema);
  }
  return {
    /** Only this explicitly entered URL grants host trust. Neither the final
     * redirect URL nor any parsed entry can enlarge that context. */
    session(enteredUrl: string, signal: AbortSignal): RadioSource {
      const root = address(enteredUrl);
      const shutdown = new AbortController();
      const lifetime = AbortSignal.any([signal, shutdown.signal]);
      let pending: Candidate[] = [];
      let documents = 0;
      let count = 0;
      let opening = false;
      let active: OwnedResponse | undefined;
      let operation: Promise<OwnedResponse> | undefined;
      const open = async () => {
        lifetime.throwIfAborted();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let lease: OwnedResponse | undefined;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          await active?.close();
          active = undefined;
          const settings = {} as Record<keyof typeof declarations, number>;
          for (
            const key of Object.keys(
              declarations,
            ) as (keyof typeof declarations)[]
          ) {
            settings[key] = Number(
              await options.state?.getTyped(`radio.${key}`) ??
                declarations[key].default,
            );
          }
          const deadline = new AbortController();
          const attempt = AbortSignal.any([lifetime, deadline.signal]);
          timer = setTimeout(() =>
            deadline.abort(
              new RadioSourceError('Radio source resolution timed out'),
            ), settings.resolveTimeoutSeconds * 1000);
          const authority: CoreNetworkAuthority = {
            caller: 'core.radio-source',
            hosts: (url) => ['http:', 'https:'].includes(url.protocol),
            trustedHosts: [new URL(root).hostname],
            ratePerMinute: settings.sourceRequestsPerMinute,
            signal: attempt,
          };
          if (!pending.length) {
            pending = [{ url: root, ancestors: [], depth: 0 }];
            documents = count = 0;
          }
          while (pending.length) {
            attempt.throwIfAborted();
            const candidate = pending.shift()!;
            const url = address(candidate.url);
            if (candidate.ancestors.includes(url)) {
              throw new RadioSourceError('Radio playlist cycle detected');
            }
            lease = await options.network.stream(authority, url, {
              headers: { 'Icy-MetaData': '1', 'Accept-Encoding': 'identity' },
            });
            if (!lease.response.ok) {
              throw new RadioSourceError(
                `Radio source HTTP ${lease.response.status}`,
              );
            }
            const finalUrl = address(lease.url);
            if (candidate.ancestors.includes(finalUrl)) {
              throw new RadioSourceError('Radio playlist cycle detected');
            }
            let type = playlistType(lease);
            if (!lease.response.body) {
              throw new RadioSourceError('Radio source has no body');
            }
            reader = lease.response.body.getReader();
            const prefix: Uint8Array[] = [];
            if (!type) {
              // MIME/path can be missing or wrong. Inspect only enough prefix
              // to distinguish a text wrapper, retaining every byte for audio.
              const probe = new Uint8Array(settings.playlistProbeBytes);
              let used = 0;
              while (used < probe.length) {
                const part = await reader.read();
                attempt.throwIfAborted();
                if (part.done) break;
                prefix.push(part.value);
                const n = Math.min(part.value.length, probe.length - used);
                probe.set(part.value.subarray(0, n), used);
                used += n;
                const text = new TextDecoder().decode(probe.subarray(0, used), {
                  stream: true,
                })
                  .trimStart().toLowerCase();
                if (text.startsWith('#')) {
                  type = 'm3u';
                  break;
                }
                if (text.startsWith('[playlist]')) {
                  type = 'pls';
                  break;
                }
                if (text.startsWith('http://') || text.startsWith('https://')) {
                  type = 'm3u';
                  break;
                }
                if (
                  text &&
                  !['[playlist]', 'http://', 'https://'].some((s) =>
                    s.startsWith(text)
                  )
                ) break;
              }
            }
            if (!type) {
              attempt.throwIfAborted();
              active = replay(lease, reader, prefix, attempt);
              reader = undefined;
              lease = undefined;
              return active;
            }
            if (
              candidate.depth >= settings.playlistMaxDepth ||
              ++documents > settings.playlistMaxDocuments
            ) {
              throw new RadioSourceError(
                'Radio playlist nesting/document limit exceeded',
              );
            }
            let size = 0;
            const parts: Uint8Array[] = [];
            const add = (bytes: Uint8Array) => {
              size += bytes.length;
              if (size > settings.playlistMaxBytes) {
                throw new RadioSourceError(
                  'Radio playlist byte limit exceeded',
                );
              }
              parts.push(bytes);
            };
            if (
              Number(lease.response.headers.get('content-length')) >
                settings.playlistMaxBytes
            ) {
              throw new RadioSourceError('Radio playlist byte limit exceeded');
            }
            for (const part of prefix) add(part);
            while (true) {
              const part = await reader.read();
              attempt.throwIfAborted();
              if (part.done) break;
              add(part.value);
            }
            reader.releaseLock();
            reader = undefined;
            await lease.close();
            lease = undefined;
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const part of parts) {
              bytes.set(part, offset);
              offset += part.length;
            }
            const urls = entries(
              new TextDecoder().decode(bytes),
              type,
              settings.playlistMaxEntries - count,
            );
            count += urls.length;
            // Keep both requested and final URLs to catch redirect aliases.
            const ancestors = [...candidate.ancestors, url, finalUrl];
            pending.unshift(...urls.map((entry) => ({
              url: new URL(entry, finalUrl).href,
              ancestors,
              depth: candidate.depth + 1,
            })));
          }
          throw new RadioSourceError('Radio playlist has no usable entries');
        } catch (error) {
          try {
            await reader?.cancel();
          } catch { /* Keep the resolution error. */ }
          reader?.releaseLock();
          await lease?.close();
          lifetime.throwIfAborted();
          throw error;
        } finally {
          clearTimeout(timer);
        }
      };
      return {
        open() {
          if (opening) {
            return Promise.reject(
              new RadioSourceError('Radio source is already opening'),
            );
          }
          opening = true;
          operation = open().finally(() => {
            opening = false;
          });
          return operation;
        },
        async close() {
          shutdown.abort(
            new DOMException('Radio source session closed', 'AbortError'),
          );
          await active?.close();
          try {
            await operation;
          } catch { /* Closing a failed/opening source. */ }
        },
      };
    },
  };
}
