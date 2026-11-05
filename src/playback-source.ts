// Core composition of a queue activation and its owned byte/decoder lifetime.
// The boot elects one caller; networking and native decoding keep their owners.
import { separateIcy } from './icy.ts';
import type { Media } from './media.ts';
import type { QueueMedia, SourceMetadata } from './queue-source.ts';
import type { createRadioSource } from './radio-source.ts';
import type { State } from './state.ts';
import type { SourceOutcome } from './player.ts';

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
        startMs: number;
        onMetadata?: (metadata: SourceMetadata) => void;
        retry?: (reason: SourceOutcome) => Promise<boolean>;
      },
    ): Promise<AsyncIterable<Uint8Array> | null> {
      options.signal.throwIfAborted();
      if (media.facts.kind === 'song') {
        return await deps.media.decodePcm(
          media.facts.song.path,
          options.startMs > 0 ? { startMs: options.startMs } : undefined,
        );
      }
      if (!deps.radio) throw new Error('Web source playback is not available');
      // Station facts were resolved at activation. Never resolve again midway
      // through a run or grant trust to a playlist/redirect's derived address.
      const enteredUrl = media.reference.kind === 'url'
        ? media.reference.url
        : media.facts.url;
      const session = deps.radio.session(enteredUrl, options.signal);
      const finite = media.facts.mode === 'finite';
      let deliveredMs = 0;
      const decode = async (onResponse?: () => void) => {
        const lease = await session.open();
        onResponse?.();
        let active = true;
        const metadata = (facts: SourceMetadata) => {
          if (active && !options.signal.aborted) options.onMetadata?.(facts);
        };
        try {
          options.signal.throwIfAborted();
          const title = lease.response.headers.get('icy-name');
          if (title && media.reference.kind === 'url') metadata({ title });
          const pcm = await deps.media.decodeInputPcm({
            body: separateIcy(
              lease.response.body!,
              lease.response.headers,
              metadata,
            ),
            close: () => options.retry ? lease.close() : session.close(),
          }, {
            signal: options.signal,
            startMs: finite ? options.startMs + deliveredMs : 0,
          });
          return {
            pcm,
            close: async () => {
              active = false;
              await pcm.return();
              await pcm.completion;
              await lease.close();
            },
          };
        } catch (error) {
          active = false;
          await lease.close();
          throw error;
        }
      };
      if (!options.retry) {
        try {
          return (await decode()).pcm;
        } catch (error) {
          await session.close();
          throw error;
        }
      }
      // Acquisition stays lazy within the elected lease. Each attempt owns a
      // fresh decoder; the session retains ordered playlist alternatives and
      // the original trust context. It never concatenates compressed responses.
      const iterate = async function* () {
        try {
          while (true) {
            let reason: SourceOutcome = 'transport-error';
            let failure: unknown;
            try {
              const attempt = await decode(() => reason = 'decode-error');
              let chunks = 0;
              try {
                for await (const chunk of attempt.pcm) {
                  chunks++;
                  yield chunk;
                  // The elected consumer resumes only after its sink write and
                  // sourceAudio report. A cancelled/failed write cannot count.
                  deliveredMs += chunk.length / 176400 * 1000;
                }
              } finally {
                await attempt.close();
              }
              if (!chunks && deliveredMs === 0) {
                throw new Error('Empty decoder stream');
              }
              if (finite || !options.retry) return;
              reason = 'eof';
              failure = new Error('Live source ended');
            } catch (error) {
              failure = error;
            }
            options.signal.throwIfAborted();
            options.onMetadata?.({ streamTitle: null, streamUrl: null });
            if (!options.retry || !await options.retry(reason)) throw failure;
            options.signal.throwIfAborted();
          }
        } finally {
          await session.close();
        }
      };
      return iterate();
    },
  };
}

export type PlaybackSources = Pick<
  ReturnType<typeof createPlaybackSource>,
  'open'
>;
