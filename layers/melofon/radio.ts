import type { HatContext, HatRequest, SongRow } from './types.ts';
import { browseInteger, browseLibrary, browseQuery } from './browse.ts';
import { artistReference, browseArtwork } from './browse-payloads.ts';
import { core, fail } from './errors.ts';

/** Typed catalog mixes use the reference owner, separate from saved stations. */
export async function radioResponse(
  request: HatRequest,
  context: HatContext,
  type: 'song' | 'album' | 'artist',
) {
  const params = browseQuery(request, ['library', 'limit']);
  const folderId = browseLibrary(params);
  const max = Number(
    await context.app.state.getTyped('melofon.browseMaxPageRecords'),
  );
  const fallback = Math.min(
    max,
    Number(await context.app.state.getTyped('melofon.browsePageRecords')),
  );
  const limit = browseInteger(params, 'limit', fallback, 1, max);
  if (
    folderId !== undefined &&
    !(await context.app.libraries.list()).some((l) => l.id === folderId)
  ) {
    fail(404, 'not_found', 'Library not found');
  }
  let ids: string[] | null;
  if (type === 'artist') {
    const { artist } = await core(() =>
      context.app.library.getArtistSnapshot(
        artistReference(request.params.id),
        folderId,
      )
    );
    if (artist === null) fail(404, 'not_found', 'Artist not found');
    ids = artist.kind === 'artist'
      ? await context.app.reference.radio(
        artist.id!,
        limit,
        context.state.user.username,
        { type, folderId },
      )
      : [];
  } else {
    ids = await context.app.reference.radio(
      request.params.id,
      limit,
      context.state.user.username,
      { type, folderId },
    );
  }
  if (ids === null) fail(404, 'not_found', 'Radio seed not found');
  const songs: SongRow[] = [];
  for (const id of ids) {
    const song = await context.app.library.getSong(id);
    if (song && (folderId === undefined || song.libraryId === folderId)) {
      songs.push(song);
    }
  }
  return Response.json({
    songs: await Promise.all(songs.map(browseArtwork(context).song)),
    limit,
  }, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
