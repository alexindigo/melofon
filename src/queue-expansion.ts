// Core collection expansion, including caller-owned playlist visibility. Hats
// translate their reference language; saved occurrences retain leaf identities.
import type { Library } from './library.ts';
import type { Playlists } from './playlists.ts';
import type { createFolders } from './folders.ts';
import type { QueueAddReference, QueueReference } from './queue-source.ts';
import { PlaybackError, QueueLimitError } from './playback-errors.ts';

export function createQueueExpansion(deps: {
  library: Library;
  playlists: Pick<Playlists, 'get'>;
  folders: ReturnType<typeof createFolders>;
}) {
  return async (
    reference: QueueAddReference,
    username: string | undefined,
    limit: number,
  ): Promise<QueueReference[]> => {
    const references: QueueReference[] = [];
    const append = (ids: string[]) => {
      if (references.length + ids.length > limit) {
        throw new QueueLimitError(limit);
      }
      references.push(...ids.map((id) => ({ kind: 'song' as const, id })));
    };
    const missing = () => {
      throw new PlaybackError('missing_reference', 'Media not found');
    };
    const album = async (id: string) => {
      const row = await deps.library.getAlbum(id);
      if (!row) return missing();
      append(row.songs.map((song) => song.id));
    };
    if (reference.kind === 'album') {
      await album(reference.id);
    } else if (reference.kind === 'artist') {
      const page = await deps.library.artistAlbumsPage(
        { kind: 'artist', id: reference.id },
        { offset: 0, limit: limit + 1 },
      );
      if (!page.artist) return missing();
      // Each indexed album has at least one song; avoid unbounded expansion.
      if (page.total > limit) throw new QueueLimitError(limit);
      for (const row of page.rows) await album(row.id);
    } else if (reference.kind === 'playlist') {
      const row = username
        ? await deps.playlists.get(username, reference.id)
        : null;
      if (!row) return missing();
      // Playlist reads already discard missing songs and keep duplicate order.
      append(row.trackIds);
    } else if (reference.kind === 'folder') {
      const visit = async (path: string): Promise<void> => {
        const page = await deps.folders.browse({
          libraryId: reference.libraryId,
          path,
          folders: { offset: 0, limit: limit + 1 },
          songs: { offset: 0, limit: limit + 1 },
        });
        if (references.length + page.songs.total + page.folders.total > limit) {
          throw new QueueLimitError(limit);
        }
        append(page.songs.rows.map((song) => song.id));
        for (const folder of page.folders.rows) await visit(folder.path);
      };
      await visit(reference.path);
    } else {
      return [reference];
    }
    return references;
  };
}
