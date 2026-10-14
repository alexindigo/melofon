// layers/opensubsonic/rest/getStarred/get.ts — GET /rest/getStarred: the
// legacy (folder-style) favourites — Artist, album-as-Child and Child
// entries — from the same lists as getStarred2.
import { ok } from '#opensubsonic/envelope.ts';
import {
  albumV1Of,
  artistOf,
  childOf,
  starredLists,
} from '#opensubsonic/id3.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const { artists, albums, songs, personal: p } = await starredLists(context);
  return ok(context, {
    starred: {
      artist: artists.map((artist) => artistOf(artist, p)),
      album: albums.map((album) => albumV1Of(album, p)),
      song: songs.map((song) => childOf(song, p)),
    },
  });
};
