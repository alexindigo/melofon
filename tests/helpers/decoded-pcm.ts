// Typed lifecycle-only wrappers for decoder instrumentation/synthetic fixtures.
// Real origin/PCM evidence uses createMedia, never this fixture producer.
import type { InputPcm, PcmOptions } from '../../src/media.ts';
import { pcmOrigin } from '../../src/pcm-origin.ts';
import type { PlaybackPcm } from '../../src/playback-source.ts';

/** Lifecycle-only source fixture; not evidence for decoded origins or retries. */
export function fixturePlaybackPcm(
  iterable: AsyncIterable<Uint8Array>,
): PlaybackPcm {
  const pcm = fixturePcm(iterable);
  let accepted = 0n;
  return {
    ...pcm,
    get eof() {
      return pcm.eof;
    },
    get acceptedFrames() {
      return accepted;
    },
    accept(_chunk, frames) {
      accepted += frames;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

export function fixturePcm(
  iterable: AsyncIterable<Uint8Array>,
  source?: InputPcm,
  options: PcmOptions = {},
): InputPcm {
  const iterator = iterable[Symbol.asyncIterator]();
  const completed = Promise.withResolvers<void>();
  let eof = false;
  let closing: Promise<void> | undefined;
  const close = () =>
    closing ??= (async () => {
      try {
        await source?.return();
        await source?.completion;
      } finally {
        completed.resolve();
      }
    })();
  return {
    originFrame: source?.originFrame ?? pcmOrigin(options),
    durationMs: source?.durationMs ?? null,
    completion: completed.promise,
    get eof() {
      return eof;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      try {
        const result = await iterator.next();
        if (result.done) {
          eof = true;
          await close();
        }
        return result;
      } catch (error) {
        await close();
        throw error;
      }
    },
    async return() {
      const stopping = source?.return();
      try {
        return await iterator.return?.() ?? { done: true, value: undefined };
      } finally {
        await stopping;
        await close();
      }
    },
  };
}
