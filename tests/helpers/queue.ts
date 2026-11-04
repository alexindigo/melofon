import {
  catalogMedia,
  type QueueReference,
  type QueueSnapshot,
} from '../../src/queue-source.ts';
import type { SongRow } from '../../src/library.ts';
import type { QueueEntry } from '../../src/queue-source.ts';

export function songEntries(songs: SongRow[]): QueueEntry[] {
  return songs.map((song, i) => ({ ...catalogMedia(song), id: i + 1 }));
}

export function songQueue(ids: string[]): QueueSnapshot {
  return {
    items: ids.map((id, i) => ({ id: i + 1, reference: { kind: 'song', id } })),
    nextId: ids.length + 1,
    version: ids.length ? 1 : 0,
  };
}
export function songResolver(getSong: (id: string) => Promise<SongRow | null>) {
  return async (reference: QueueReference) => {
    const song = reference.kind === 'song' ? await getSong(reference.id) : null;
    return song ? catalogMedia(song) : null;
  };
}
export const stopped = {
  state: 'stop' as const,
  currentIndex: null,
  positionMs: 0,
  repeat: 'off' as const,
  shuffle: false,
  consume: false,
};
