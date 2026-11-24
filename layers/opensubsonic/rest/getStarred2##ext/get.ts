// layers/opensubsonic/rest/getStarred2/get.ts — GET /rest/getStarred2: the
// user's favourites in ID3 shapes, newest like first, musicFolderId-aware.
import { ok } from '#opensubsonic/envelope.ts';
import {
  albumId3Of,
  artistId3Of,
  childOf,
  starredLists,
} from '#opensubsonic/id3.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const lists = await starredLists(context);
  if (lists instanceof Response) return lists;
  const { artists, albums, songs, personal: p } = lists;
  return ok(context, {
    starred2: {
      artist: artists.map((artist) => artistId3Of(artist, p)),
      album: albums.map((album) => albumId3Of(album, p)),
      song: songs.map((song) => childOf(song, p)),
    },
  });
};
