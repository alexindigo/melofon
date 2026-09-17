// layers/opensubsonic/rest/getAlbumList/get.ts — GET /rest/getAlbumList
// (pre-ID3 album shape).
import { ok } from '#opensubsonic/envelope.ts';
import { albumListAlbums, albumV1Of } from '#opensubsonic/id3.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const albums = await albumListAlbums(context);
  if (albums instanceof Response) return albums;
  return ok(context, { albumList: { album: albums.map(albumV1Of) } });
};
