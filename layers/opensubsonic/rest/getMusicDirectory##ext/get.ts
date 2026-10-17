// layers/opensubsonic/rest/getMusicDirectory/get.ts — GET
// /rest/getMusicDirectory: artist id → album dirs, album id → song children.
// The directory carries its own artist/album facts (Directory rules); album
// children are Children (Child rules).
import { notFound, ok } from '#opensubsonic/envelope.ts';
import {
  albumArtistLabel,
  albumLabel,
  albumsByLabel,
  albumV1Of,
  childOf,
  resolveArtist,
} from '#opensubsonic/id3.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import { directoryFields, loadPersonal } from '#opensubsonic/personal.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const resolved = await resolveArtist(context, id);
  if (resolved !== null) {
    const { artist, albums } = resolved;
    const p = await loadPersonal(context, {
      artists: [artist.id],
      albums: albums.map((album) => album.id),
    });
    return ok(context, {
      directory: {
        id: artist.id,
        name: artist.name,
        ...directoryFields(p.artist(artist.id)),
        child: albumsByLabel(albums).map((album) => albumV1Of(album, p)),
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
        name: albumLabel(got.album),
        parent: albumArtistLabel(got.album).id,
        ...directoryFields(p.album(got.album.id)),
        child: got.songs.map((song) => childOf(song, p)),
      },
    });
  }
  return notFound(context);
};
