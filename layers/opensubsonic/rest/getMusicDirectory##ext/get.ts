// layers/opensubsonic/rest/getMusicDirectory/get.ts — GET
// /rest/getMusicDirectory: artist id → album dirs, album id → song children.
// The directory carries its own artist/album facts (Directory rules); album
// children are Children (Child rules).
import { notFound, ok } from '#opensubsonic/envelope.ts';
import { childOf } from '#opensubsonic/id3.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import {
  childFields,
  directoryFields,
  loadPersonal,
} from '#opensubsonic/personal.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const artist = await context.app.library.getArtist(id);
  if (artist !== null) {
    const albums = await context.app.library.albumsByArtist(id);
    const p = await loadPersonal(context, {
      artists: [artist.id],
      albums: albums.map((album) => album.id),
    });
    return ok(context, {
      directory: {
        id: artist.id,
        name: artist.name,
        ...directoryFields(p.artist(artist.id)),
        child: albums.map((album) => ({
          id: album.id,
          isDir: true,
          title: album.name,
          album: album.name,
          artist: album.artistName,
          artistId: album.artistId,
          coverArt: album.id,
          parent: artist.id,
          ...childFields(p.album(album.id)),
        })),
      },
    });
  }
  const got = await context.app.library.getAlbum(id);
  if (got !== null) {
    const p = await loadPersonal(context, {
      albums: [got.album.id],
      songs: got.songs.map((song) => song.id),
    });
    return ok(context, {
      directory: {
        id: got.album.id,
        name: got.album.name,
        parent: got.album.artistId,
        ...directoryFields(p.album(got.album.id)),
        child: got.songs.map((song) => ({
          ...childOf(song, p),
          parent: got.album.id,
        })),
      },
    });
  }
  return notFound(context);
};
