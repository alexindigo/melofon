// layers/opensubsonic/rest/getAlbumList2/get.ts — GET /rest/getAlbumList2
// (ID3 album shape).
import { ok } from '#opensubsonic/envelope.ts';
import { albumId3Of, albumListAlbums } from '#opensubsonic/id3.ts';
import { loadPersonal } from '#opensubsonic/personal.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const albums = await albumListAlbums(context);
  if (albums instanceof Response) return albums;
  const p = await loadPersonal(context, {
    albums: albums.map((album) => album.id),
  });
  return ok(context, {
    albumList2: { album: albums.map((album) => albumId3Of(album, p)) },
  });
};
