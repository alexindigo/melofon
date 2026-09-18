// layers/opensubsonic/rest/search3/get.ts — GET /rest/search3 (ID3 search).
import { ok } from '#opensubsonic/envelope.ts';
import { albumId3Of, artistId3Of, childOf } from '#opensubsonic/id3.ts';
import {
  folderIdParam,
  intParam,
  requiredParam,
} from '#opensubsonic/params.ts';
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
  return ok(context, {
    searchResult3: {
      artist: result.artists.map(artistId3Of),
      album: result.albums.map(albumId3Of),
      song: result.songs.map((song) => childOf(song)),
    },
  });
};
