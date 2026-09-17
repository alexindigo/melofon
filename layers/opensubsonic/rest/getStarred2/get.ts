// layers/opensubsonic/rest/getStarred2/get.ts — GET /rest/getStarred2.
import { ok } from '#opensubsonic/envelope.ts';
import { albumId3Of, artistId3Of, childOf } from '#opensubsonic/id3.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const rows = await context.app.annotation.starred(
    context.state.user!.username,
  );
  const artists: Record<string, unknown>[] = [];
  const albums: Record<string, unknown>[] = [];
  const songs: Record<string, unknown>[] = [];
  for (const row of rows) {
    const starred = new Date(row.starredAtMs).toISOString();
    if (row.targetType === 'song') {
      const song = await context.app.library.getSong(row.targetId);
      if (song !== null) {
        songs.push({
          ...childOf(song),
          starred,
        });
      }
    } else if (row.targetType === 'album') {
      const got = await context.app.library.getAlbum(row.targetId);
      if (got !== null) albums.push({ ...albumId3Of(got.album), starred });
    } else if (row.targetType === 'artist') {
      const artist = await context.app.library.getArtist(row.targetId);
      if (artist !== null) {
        artists.push({ ...artistId3Of(artist), starred });
      }
    }
  }
  return ok(context, {
    starred2: { artist: artists, album: albums, song: songs },
  });
};
