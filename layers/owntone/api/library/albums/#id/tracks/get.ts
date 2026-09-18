// layers/owntone/api/library/albums/#id/tracks/get.ts — GET
// /api/library/albums/<id>/tracks: { items, total, offset, limit }.
import {
  badRequest,
  findAlbumByWire,
  intParam,
  notFound,
  trackPayload,
} from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  if (!/^\d+$/.test(request.params.id)) return badRequest();
  const album = await findAlbumByWire(context.app, request.params.id);
  if (album === null) return notFound();
  const got = await context.app.library.getAlbum(album.id);
  if (got === null) return notFound();
  const rawOffset = request.query.get('offset');
  const rawLimit = request.query.get('limit');
  const offset = rawOffset === null ? 0 : intParam(rawOffset);
  const limit = rawLimit === null ? -1 : intParam(rawLimit);
  if (offset === null || limit === null || offset < 0 || limit < -1) {
    return badRequest();
  }
  const albumArtist = { id: got.album.artistId, name: got.album.artistName };
  const page = limit === -1
    ? got.songs.slice(offset)
    : got.songs.slice(offset, offset + limit);
  return {
    items: page.map((song) => trackPayload(song, albumArtist)),
    total: got.songs.length,
    offset,
    limit,
  };
};
