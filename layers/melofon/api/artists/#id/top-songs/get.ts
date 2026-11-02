import type { HatContext, HatRequest, SongRow } from '#melofon/types.ts';
import { artistReferenceQuery } from '#melofon/artist-reference.ts';
import { songDetail } from '#melofon/browse-payloads.ts';

export default async function (request: HatRequest, context: HatContext) {
  const { artist, folderId, limit } = await artistReferenceQuery(
    request,
    context,
  );
  const ids = artist.kind === 'artist'
    ? await context.app.reference.topTracks(
      artist.id!,
      limit,
      context.state.user.username,
      folderId,
    )
    : [];
  const songs: SongRow[] = [];
  for (const id of ids) {
    const song = await context.app.library.getSong(id);
    if (song && (folderId === undefined || song.libraryId === folderId)) {
      songs.push(song);
    }
  }
  return Response.json({ songs: songs.map(songDetail), limit }, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
