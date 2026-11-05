// Queue identity belongs to the occurrence, not the referenced media. These
// plain facts own no open reader/decoder; those lifetimes belong to playback.
import type { SongRow } from './library.ts';

export type QueueReference =
  | { kind: 'song'; id: string }
  | { kind: 'station'; id: string }
  | { kind: 'url'; url: string };

export interface WebPlaybackFacts {
  kind: 'web';
  /** Resolved playback address; the reference retains the entered identity. */
  url: string;
  title: string | null;
  artistName: string | null;
  durationMs: number | null;
  mode: 'live' | 'finite' | 'unknown';
  seekable: boolean;
  /** Raw ICY facts, separate from the station title and hat interpretations. */
  streamTitle: string | null;
  streamUrl: string | null;
}

/** Source observations, not display labels or catalog metadata. Omitted fields
 * leave the prior fact alone; an empty string is an explicit broadcast update. */
export type SourceMetadata = Partial<
  Pick<WebPlaybackFacts, 'title' | 'streamTitle' | 'streamUrl'>
>;

export type QueueMedia =
  | {
    reference: Extract<QueueReference, { kind: 'song' }>;
    facts: { kind: 'song'; song: SongRow };
  }
  | {
    reference: Exclude<QueueReference, { kind: 'song' }>;
    facts: WebPlaybackFacts;
  };

export type QueueEntry = QueueMedia & {
  /** Occurrence id, independent of source identity (including duplicates). */
  id: number;
};

/** Durable identity only. Resolved URLs, decoder facts and broadcast metadata
 * belong to an activation, never to the saved queue. */
export interface QueueSnapshot {
  items: { id: number; reference: QueueReference }[];
  nextId: number;
  version: number;
}

export function createQueueResolver(deps: {
  getSong(id: string): Promise<SongRow | null>;
  getStation(id: string): Promise<{ name: string; streamUrl: string } | null>;
}) {
  return async (reference: QueueReference): Promise<QueueMedia | null> => {
    if (reference.kind === 'song') {
      const song = await deps.getSong(reference.id);
      return song ? catalogMedia(song) : null;
    }
    const station = reference.kind === 'station'
      ? await deps.getStation(reference.id)
      : null;
    if (reference.kind === 'station' && !station) return null;
    const url = reference.kind === 'url' ? reference.url : station!.streamUrl;
    return {
      reference: { ...reference },
      facts: {
        kind: 'web',
        url,
        title: station?.name ?? null,
        artistName: null,
        durationMs: null,
        mode: station ? 'live' : 'unknown',
        seekable: false,
        streamTitle: null,
        streamUrl: null,
      },
    };
  };
}

/** Compatibility adapter for existing catalog enqueue callers. */
export function catalogMedia(song: SongRow): QueueMedia {
  return {
    reference: { kind: 'song', id: song.id },
    facts: { kind: 'song', song },
  };
}

export function queueSong(media: QueueMedia | null): SongRow | null {
  return media?.facts.kind === 'song' ? media.facts.song : null;
}

export function queueDuration(media: QueueMedia): number | null {
  return media.facts.kind === 'song'
    ? media.facts.song.durationMs
    : media.facts.durationMs;
}

export function queueCapabilities(media: QueueMedia | null) {
  return {
    live: media?.facts.kind === 'web' && media.facts.mode === 'live',
    seekable: media?.facts.kind === 'song' ||
      media?.facts.kind === 'web' && media.facts.mode === 'finite' &&
        media.facts.seekable,
  };
}

export function queueDisplay(media: QueueMedia) {
  return media.facts.kind === 'song' ? media.facts.song : media.facts;
}
