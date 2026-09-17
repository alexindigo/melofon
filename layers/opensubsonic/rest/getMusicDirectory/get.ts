// layers/opensubsonic/rest/getMusicDirectory/get.ts — GET
// /rest/getMusicDirectory: artist id → album dirs, album id → song children.
import { notFound, ok } from '#opensubsonic/envelope.ts';
import { childOf } from '#opensubsonic/id3.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const artist = await context.app.library.getArtist(id);
  if (artist !== null) {
    const albums = await context.app.library.albumsByArtist(id);
    return ok(context, {
      directory: {
        id: artist.id,
        name: artist.name,
        child: albums.map((album) => ({
          id: album.id,
          isDir: true,
          title: album.name,
          album: album.name,
          artist: album.artistName,
          artistId: album.artistId,
          coverArt: album.id,
          parent: artist.id,
        })),
      },
    });
  }
  const got = await context.app.library.getAlbum(id);
  if (got !== null) {
    return ok(context, {
      directory: {
        id: got.album.id,
        name: got.album.name,
        parent: got.album.artistId,
        child: got.songs.map((song) => ({
          ...childOf(song),
          parent: got.album.id,
        })),
      },
    });
  }
  return notFound(context);
};
