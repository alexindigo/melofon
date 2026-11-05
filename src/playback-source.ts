// Core composition of a queue activation and its owned byte/decoder lifetime.
// The boot elects one caller; networking and native decoding keep their owners.
import { separateIcy } from './icy.ts';
import type { Media } from './media.ts';
import type { QueueMedia } from './queue-source.ts';
import type { createRadioSource } from './radio-source.ts';

export function createPlaybackSource(deps: {
  media: Pick<Media, 'decodePcm' | 'decodeInputPcm'>;
  radio?: ReturnType<typeof createRadioSource>;
}) {
  return {
    async open(
      media: QueueMedia,
      options: { signal: AbortSignal; startMs: number },
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
      try {
        const lease = await session.open();
        options.signal.throwIfAborted();
        return await deps.media.decodeInputPcm({
          body: separateIcy(
            lease.response.body!,
            lease.response.headers,
            () => {},
          ),
          close: () => session.close(),
        }, { signal: options.signal });
      } catch (error) {
        await session.close();
        throw error;
      }
    },
  };
}

export type PlaybackSources = ReturnType<typeof createPlaybackSource>;
