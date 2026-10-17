// layers/opensubsonic/rest/getArtist/get.ts — GET /rest/getArtist.
import { notFound, ok } from '#opensubsonic/envelope.ts';
import {
  albumId3Of,
  artistAlbumsOrder,
  artistId3Of,
  resolveArtist,
} from '#opensubsonic/id3.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import { loadPersonal } from '#opensubsonic/personal.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const resolved = await resolveArtist(context, id);
  if (resolved === null) return notFound(context);
  const { artist } = resolved;
  const albums = artistAlbumsOrder(resolved.albums);
  const p = await loadPersonal(context, {
    artists: [artist.id],
    albums: albums.map((album) => album.id),
  });
  return ok(context, {
    artist: {
      ...artistId3Of(artist, p),
      album: albums.map((album) => albumId3Of(album, p)),
    },
  });
};
