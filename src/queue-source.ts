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

export function queueDisplay(media: QueueMedia) {
  return media.facts.kind === 'song' ? media.facts.song : media.facts;
}
