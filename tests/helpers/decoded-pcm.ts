// Typed lifecycle-only wrappers for decoder instrumentation/synthetic fixtures.
// Real origin/PCM evidence uses createMedia, never this fixture producer.
import type { InputPcm } from '../../src/media.ts';

export function fixturePcm(
  iterable: AsyncIterable<Uint8Array>,
  source?: InputPcm,
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
    originFrame: source?.originFrame ?? 0n,
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
