// layers/owntone/api/library/albums/#id/tracks/get.ts — GET
// /api/library/albums/<id>/tracks: { items, total, offset, limit }.
import {
  albumArtistLabel,
  badRequest,
  findAlbumByWire,
  notFound,
  paged,
  pagingParams,
  trackPayload,
} from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  if (!/^\d+$/.test(request.params.id)) return badRequest();
  const album = await findAlbumByWire(context.app, request.params.id);
  if (album === null) return notFound();
  const got = await context.app.library.getAlbum(album.id);
  if (got === null) return notFound();
  const paging = pagingParams(request.query);
  if (paging instanceof Response) return paging;
  const albumArtist = albumArtistLabel(got.album);
  return paged(
    got.songs.map((song) => trackPayload(song, albumArtist)),
    paging.offset,
    paging.limit,
  );
};
