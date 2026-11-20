// A single bounded owner of speculative decoder reads. The boundary takes only
// already decoded PCM; it never waits for another chunk just to obtain a fade.
import type { PlaybackPcm } from './playback-source.ts';

export function createPlaybackHead(
  pcm: PlaybackPcm,
  first: IteratorResult<Uint8Array>,
  requestedFrames: bigint,
  run: (work: () => Promise<void>) => Promise<void>,
) {
  const parts: Uint8Array[] = [];
  let frames = 0n;
  let head: IteratorResult<Uint8Array> | null = first;
  let frozen = false, failed = false, finished = false, error: unknown;
  let changed = Promise.withResolvers<void>();
  const notify = () => {
    changed.resolve();
    changed = Promise.withResolvers<void>();
  };
  const completion = run(async () => {
    try {
      while (!frozen && head && !head.done && frames <= requestedFrames) {
        const bytes = head.value;
        pcm.accept(bytes, BigInt(bytes.length / 4));
        parts.push(bytes.slice());
        frames += BigInt(bytes.length / 4);
        notify();
        head = null;
        head = await pcm.next();
      }
    } catch (cause) {
      failed = true;
      error = cause;
    } finally {
      finished = true;
      notify();
    }
  });
  return {
    completion,
    get frames() {
      return frames;
    },
    get finished() {
      return finished;
    },
    get changed() {
      return changed.promise;
    },
    /** Stop extending the head and transfer exactly what is ready now. A pending
     * next() stays owned here and becomes the first remainder read. */
    freeze() {
      frozen = true;
      const bytes = new Uint8Array(Number(frames) * 4);
      let at = 0;
      for (const part of parts.splice(0)) {
        bytes.set(part, at);
        at += part.length;
      }
      const available = frames;
      frames = 0n;
      return {
        bytes,
        frames: available,
        ended: !!head?.done && pcm.eof,
        failed,
        error,
      };
    },
    async next(): Promise<IteratorResult<Uint8Array>> {
      if (!frozen) {
        throw new Error(
          'Freeze the speculative head before reading its remainder',
        );
      }
      await completion;
      if (failed) throw error;
      if (head) {
        const next = head;
        head = null;
        return next;
      }
      return await pcm.next();
    },
  };
}
