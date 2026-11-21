// Core composition of a queue activation and its owned byte/decoder lifetime.
// One stream caller reports copied frames; reads never imply sink acceptance.
import { separateIcy } from './icy.ts';
import type { InputPcm, Media, PcmOptions } from './media.ts';
import { pcmOrigin } from './pcm-origin.ts';
import type { QueueMedia, SourceMetadata } from './queue-source.ts';
import type { createRadioSource } from './radio-source.ts';
import type { State } from './state.ts';
import type { SourceOutcome } from './player.ts';
import type { createRadio } from './radio.ts';
import { createOperationScope } from './operations.ts';
import { createReleaseSet, releaseOrThrow } from './releases.ts';

export interface PlaybackPcm extends AsyncIterableIterator<Uint8Array> {
  readonly originFrame: bigint;
  readonly acceptedFrames: bigint;
  readonly eof: boolean;
  /** Cleanup settlement only, never decoder EOF or scheduled sink completion. */
  readonly completion: Promise<void>;
  /** Report only the copied whole-frame prefix of this exact outstanding chunk.
   * A later attempt cannot accept a receipt belonging to an earlier read. */
  accept(chunk: Uint8Array, frames: bigint): void;
  return(): Promise<IteratorResult<Uint8Array>>;
}

function ownPlaybackPcm(options: {
  originFrame: bigint;
  signal: AbortSignal;
  acquire(signal: AbortSignal, originFrame: bigint): Promise<
    {
      pcm: InputPcm;
      close(): Promise<void>;
    } | null
  >;
  close(): Promise<void>;
  cancel?(): void;
  finite: boolean;
  failureReason(): SourceOutcome;
  retry?: (reason: SourceOutcome, signal: AbortSignal) => Promise<boolean>;
  retrying(): void;
  decoded?(frames: bigint): void;
}) {
  const operations = createOperationScope('Playback PCM');
  const shutdown = new AbortController();
  const signal = AbortSignal.any([options.signal, shutdown.signal]);
  const releases = createReleaseSet();
  const settled = Promise.withResolvers<void>();
  let attempt: Awaited<ReturnType<typeof options.acquire>>;
  let offered: Uint8Array | undefined, outstanding = 0n;
  let acceptedFrames = 0n, decodedFrames = 0n, eof = false;
  let cleanup: Promise<void> | undefined, retiring: Promise<void> | undefined;
  releases.add('source session', options.close, 1);
  const finish = () =>
    cleanup ??= (async () => {
      try {
        await releaseOrThrow(releases, 'Playback source cleanup failed');
      } finally {
        options.signal.removeEventListener('abort', abort);
        settled.resolve();
      }
    })();
  const acquire = async () => {
    signal.throwIfAborted();
    attempt = await options.acquire(
      signal,
      options.originFrame +
        (options.finite ? acceptedFrames : 0n),
    );
    if (attempt) {
      releases.add('decoder attempt', attempt.close);
      signal.throwIfAborted();
      if (
        attempt.pcm.originFrame !== options.originFrame +
            (options.finite ? acceptedFrames : 0n)
      ) {
        throw new Error('Decoder returned a different PCM origin');
      }
    }
    return !!attempt;
  };
  const releaseAttempt = async () => {
    offered = undefined;
    outstanding = 0n;
    await releaseOrThrow(
      releases,
      'Playback attempt cleanup failed',
      undefined,
      [
        'decoder attempt',
      ],
    );
    attempt = null;
  };
  const result: PlaybackPcm = Object.freeze({
    originFrame: options.originFrame,
    get acceptedFrames() {
      return acceptedFrames;
    },
    get eof() {
      return eof;
    },
    completion: settled.promise,
    [Symbol.asyncIterator]() {
      return this;
    },
    accept(chunk: Uint8Array, frames: bigint) {
      if (
        offered !== chunk || typeof frames !== 'bigint' || frames < 0n ||
        frames > outstanding || cleanup || retiring
      ) {
        throw new RangeError('Invalid or stale PCM acceptance receipt');
      }
      outstanding -= frames;
      acceptedFrames += frames;
    },
    async next(): Promise<IteratorResult<Uint8Array>> {
      if (cleanup || retiring) return { done: true, value: undefined };
      return await operations.run(async () => {
        offered = undefined;
        outstanding = 0n;
        try {
          while (true) {
            let reason: SourceOutcome = 'decode-error', failure: unknown;
            let natural = false;
            try {
              if (!attempt && !await acquire()) {
                await finish();
                return { done: true, value: undefined };
              }
              const read = await attempt!.pcm.next();
              signal.throwIfAborted();
              if (!read.done) {
                if (read.value.length % 4) {
                  throw new Error('Incomplete PCM frame');
                }
                offered = read.value;
                outstanding = BigInt(read.value.length / 4);
                decodedFrames += outstanding;
                options.decoded?.(decodedFrames);
                return read;
              }
              if (!attempt!.pcm.eof) {
                throw new Error('Decoder closed before EOF');
              }
              if (options.retry && decodedFrames === 0n) {
                throw new Error('Empty decoder stream');
              }
              natural = true;
            } catch (error) {
              failure = error;
              reason = options.failureReason();
            }
            // Cleanup failures are terminal, not another retryable decode error.
            await releaseAttempt();
            if (natural && options.finite) {
              eof = true;
              await finish();
              return { done: true, value: undefined };
            }
            if (natural) {
              reason = 'eof';
              failure = new Error('Live source ended');
            }
            signal.throwIfAborted();
            options.retrying();
            const retry = await options.retry?.(reason, signal);
            signal.throwIfAborted();
            if (!retry) throw failure;
          }
        } catch (error) {
          await finish();
          throw error;
        }
      });
    },
    async return(): Promise<IteratorResult<Uint8Array>> {
      if (!retiring) {
        const done = Promise.withResolvers<void>();
        retiring = done.promise;
        shutdown.abort(
          new DOMException('Playback source returned', 'AbortError'),
        );
        options.cancel?.();
        void (async () => {
          await operations.close();
          await finish();
        })().then(done.resolve, done.reject);
      }
      await retiring;
      return { done: true, value: undefined };
    },
  });
  function abort() {
    void result.return().catch(() => {});
  }
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  return {
    pcm: result,
    async ready() {
      try {
        return await operations.run(acquire);
      } catch (error) {
        await result.return();
        throw error;
      }
    },
  };
}

function responseSize(headers: Headers): number | undefined {
  const text = headers.get('content-length');
  if (!text || !/^\d+$/.test(text)) return;
  const size = Number(text);
  return Number.isSafeInteger(size) && size > 0 ? size : undefined;
}

export function createPlaybackSource(deps: {
  media:
    & Pick<Media, 'decodePcm' | 'decodeInputPcm'>
    & Partial<Pick<Media, 'probeInputDuration'>>;
  radio?: ReturnType<typeof createRadioSource>;
  artwork?: Pick<ReturnType<typeof createRadio>, 'streamArtwork'>;
  state?: Pick<State, 'declare' | 'getTyped'>;
}) {
  const limits = {
    prepareBytes: {
      type: 'integer',
      default: 1048576,
      minimum: 2048,
      maximum: 16777216,
    },
    prepareTimeoutMs: {
      type: 'integer',
      default: 2000,
      minimum: 1,
      maximum: 60000,
    },
  };
  for (const [name, schema] of Object.entries(limits)) {
    deps.state?.declare(`playback.source.${name}`, schema);
  }
  return {
    /** Bounded, disposable inspection; no files/cache or catalog imports. The
     * queue command owns publication, after every input has prepared. */
    async prepare(media: QueueMedia, signal: AbortSignal): Promise<QueueMedia> {
      signal.throwIfAborted();
      if (media.facts.kind === 'song' || media.reference.kind !== 'url') {
        return media;
      }
      if (!deps.radio) throw new Error('Web source playback is not available');
      const maxBytes = Number(
        await deps.state?.getTyped('playback.source.prepareBytes') ??
          limits.prepareBytes.default,
      );
      const timeoutMs = Number(
        await deps.state?.getTyped('playback.source.prepareTimeoutMs') ??
          limits.prepareTimeoutMs.default,
      );
      const session = deps.radio.session(media.reference.url, signal);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let complete = false, limited = false, size = 0;
      const parts: Uint8Array[] = [];
      let live = false, url = media.facts.url;
      let sourceSize: number | undefined;
      try {
        const lease = await session.open();
        url = lease.url;
        live = [...lease.response.headers.keys()].some((key) =>
          key.startsWith('icy-')
        );
        if (!live) sourceSize = responseSize(lease.response.headers);
        reader = separateIcy(
          lease.response.body!,
          lease.response.headers,
          () => {},
        ).getReader();
        timer = setTimeout(() => {
          limited = true;
          void reader!.cancel().catch(() => {});
        }, timeoutMs);
        while (size < maxBytes) {
          const part = await reader.read();
          signal.throwIfAborted();
          if (part.done) {
            complete = !limited;
            break;
          }
          const count = Math.min(part.value.length, maxBytes - size);
          parts.push(part.value.slice(0, count));
          size += count;
        }
      } finally {
        clearTimeout(timer);
        try {
          await reader?.cancel();
        } finally {
          reader?.releaseLock();
          await session.close();
        }
      }
      signal.throwIfAborted();
      // Feed the bounded prefix through the same restricted native boundary as
      // playback. A budget EOF is inspection-only, never a playback outcome.
      const decode = new AbortController();
      const decodeSignal = AbortSignal.any([signal, decode.signal]);
      const decodeTimer = setTimeout(() =>
        decode.abort(
          new DOMException('URL preparation decode timed out', 'TimeoutError'),
        ), timeoutMs);
      let at = 0;
      try {
        let headerDuration: number | null = null;
        if (!complete && !live && sourceSize && deps.media.probeInputDuration) {
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const part of parts) {
            bytes.set(part, offset);
            offset += part.length;
          }
          headerDuration = await deps.media.probeInputDuration(
            bytes,
            sourceSize,
            decodeSignal,
          );
        }
        const pcm = await deps.media.decodeInputPcm({
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              if (at === parts.length) controller.close();
              else controller.enqueue(parts[at++]);
            },
          }, { highWaterMark: 0 }),
          close: () => Promise.resolve(),
        }, { signal: decodeSignal });
        let decodedBytes = 0;
        try {
          for await (const chunk of pcm) {
            decodeSignal.throwIfAborted();
            decodedBytes += chunk.length;
            if (!complete || live) break;
          }
          if (!decodedBytes) {
            throw new Error('URL preparation produced no audio');
          }
        } finally {
          await pcm.return();
          await pcm.completion;
        }
        const durationMs = live
          ? null
          : complete
          ? Math.round(decodedBytes / (44100 * 4) * 1000)
          : headerDuration ?? pcm.durationMs;
        const finite = durationMs !== null && durationMs > 0;
        return {
          reference: { ...media.reference },
          facts: {
            ...media.facts,
            url,
            mode: finite ? 'finite' : 'live',
            durationMs: finite ? durationMs : null,
            seekable: finite,
          },
        };
      } finally {
        clearTimeout(decodeTimer);
      }
    },
    async open(
      media: QueueMedia,
      options: {
        signal: AbortSignal;
        onMetadata?: (metadata: SourceMetadata, sourceFrame: bigint) => void;
        retry?: (
          reason: SourceOutcome,
          signal: AbortSignal,
        ) => Promise<boolean>;
      } & PcmOptions,
    ): Promise<PlaybackPcm | null> {
      options.signal.throwIfAborted();
      const originFrame =
        media.facts.kind === 'web' && media.facts.mode !== 'finite'
          ? 0n
          : pcmOrigin(options);
      if (media.facts.kind === 'song') {
        const path = media.facts.song.path;
        const owner = ownPlaybackPcm({
          originFrame,
          signal: options.signal,
          finite: true,
          acquire: async (signal, startFrame) => {
            const pcm = await deps.media.decodePcm(path, {
              signal,
              ...(options.startFrame === undefined
                ? { startMs: options.startMs ?? 0 }
                : { startFrame }),
            });
            return pcm && {
              pcm,
              close: async () => {
                try {
                  await pcm.return();
                } finally {
                  await pcm.completion;
                }
              },
            };
          },
          close: () => Promise.resolve(),
          failureReason: () => 'decode-error',
          retrying: () => {},
        });
        if (await owner.ready()) return owner.pcm;
        await owner.pcm.return();
        return null;
      }
      if (!deps.radio) throw new Error('Web source playback is not available');
      // Station facts were resolved at activation. Never resolve again midway
      // through a run or grant trust to a playlist/redirect's derived address.
      const enteredUrl = media.reference.kind === 'url'
        ? media.reference.url
        : media.facts.url;
      const lifetime = new AbortController();
      const session = deps.radio.session(
        enteredUrl,
        AbortSignal.any([
          options.signal,
          lifetime.signal,
        ]),
      );
      const finite = media.facts.mode === 'finite';
      let decodedBoundary = 0n;
      let reason: SourceOutcome = 'transport-error';
      const decode = async (signal: AbortSignal, startFrame: bigint) => {
        reason = 'transport-error';
        const lease = await session.open();
        reason = 'decode-error';
        let active = true;
        const releases = createReleaseSet();
        releases.add('response', () => lease.close(), 2);
        let artwork:
          | ReturnType<NonNullable<typeof deps.artwork>['streamArtwork']>
          | undefined;
        const metadata = (facts: SourceMetadata) => {
          if (active && !signal.aborted) {
            options.onMetadata?.(facts, decodedBoundary);
            artwork?.observe(facts.streamUrl);
          }
        };
        try {
          if (media.reference.kind === 'station') {
            artwork = deps.artwork?.streamArtwork(
              media.reference.id,
              enteredUrl,
              signal,
            );
            if (artwork) releases.add('artwork', () => artwork!.close(), 1);
          }
          signal.throwIfAborted();
          const title = lease.response.headers.get('icy-name');
          if (title && media.reference.kind === 'url') metadata({ title });
          const pcm = await deps.media.decodeInputPcm({
            body: separateIcy(
              lease.response.body!,
              lease.response.headers,
              metadata,
            ),
            close: async () => {
              active = false;
              await releaseOrThrow(
                releases,
                'Web input cleanup failed',
                undefined,
                ['artwork', 'response'],
              );
            },
          }, {
            signal,
            startFrame,
          });
          releases.add('decoder', async () => {
            try {
              await pcm.return();
            } finally {
              await pcm.completion;
            }
          });
          return {
            pcm,
            close: async () => {
              active = false;
              await releaseOrThrow(releases, 'Web decoder cleanup failed');
            },
          };
        } catch (error) {
          active = false;
          await releaseOrThrow(releases, 'Web acquisition cleanup failed', {
            error,
          });
          throw error;
        }
      };
      const owner = ownPlaybackPcm({
        originFrame,
        signal: options.signal,
        finite: finite || !options.retry,
        acquire: decode,
        cancel: () => lifetime.abort(),
        close: async () => {
          lifetime.abort();
          await session.close();
        },
        failureReason: () => reason,
        retry: options.retry,
        decoded: (frames) => decodedBoundary = frames,
        retrying: () =>
          options.onMetadata?.(
            { streamTitle: null, streamUrl: null },
            decodedBoundary,
          ),
      });
      // Preserve eager no-retry validation and lazy retry acquisition, but both
      // paths have an owner before their first await, including unread return.
      if (!options.retry) await owner.ready();
      return owner.pcm;
    },
  };
}

export type PlaybackSources = Pick<
  ReturnType<typeof createPlaybackSource>,
  'open'
>;
