// layers/opensubsonic/rest/search2/get.ts — GET /rest/search2 (pre-ID3
// search; albums carry the legacy v1 fields).
import { ok } from '#opensubsonic/envelope.ts';
import { albumV1Of, artistId3Of, childOf } from '#opensubsonic/id3.ts';
import {
  folderIdParam,
  intParam,
  requiredParam,
} from '#opensubsonic/params.ts';
import { loadPersonal } from '#opensubsonic/personal.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const params = context.state.params!;
  const query = requiredParam(context, 'query');
  if (query instanceof Response) return query;
  const result = await context.app.library.search3(query, {
    artistCount: intParam(params, 'artistCount', 20),
    artistOffset: intParam(params, 'artistOffset', 0),
    albumCount: intParam(params, 'albumCount', 20),
    albumOffset: intParam(params, 'albumOffset', 0),
    songCount: intParam(params, 'songCount', 20),
    songOffset: intParam(params, 'songOffset', 0),
    folderId: await folderIdParam(context),
  });
  const p = await loadPersonal(context, {
    artists: result.artists.map((artist) => artist.id),
    albums: result.albums.map((album) => album.id),
    songs: result.songs.map((song) => song.id),
  });
  return ok(context, {
    searchResult2: {
      artist: result.artists.map((artist) => artistId3Of(artist, p)),
      album: result.albums.map((album) => albumV1Of(album, p)),
      song: result.songs.map((song) => childOf(song, p)),
    },
  });
};
