// layers/owntone/api/library/artists/#id/albums/get.ts — GET
// /api/library/artists/<id>/albums (paged album objects).
import {
  albumPayload,
  albumsByLabel,
  artistAlbums,
  badRequest,
  findArtistByWire,
  notFound,
  paged,
  pagingParams,
} from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  if (!/^\d+$/.test(request.params.id)) return badRequest();
  const artist = await findArtistByWire(context.app, request.params.id);
  if (artist === null) return notFound();
  const paging = pagingParams(request.query);
  if (paging instanceof Response) return paging;
  const albums = await artistAlbums(context.app, artist.id);
  return paged(
    albumsByLabel(albums).map(albumPayload),
    paging.offset,
    paging.limit,
  );
};
