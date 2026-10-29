import type { HatContext, HatRequest } from '#melofon/types.ts';
import { searchPageQuery } from '#melofon/browse.ts';
import {
  albumSummary,
  artistSummary,
  songDetail,
} from '#melofon/browse-payloads.ts';
import { catalogResponse } from '#melofon/cache.ts';
import { core } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  const query = await searchPageQuery(request, context);
  const pages = await core(() =>
    context.app.library.searchPages(query.query, query)
  );
  return catalogResponse(request, pages.revision, ['search', 1, query], {
    artists: {
      artists: pages.artists.rows.map(artistSummary),
      total: pages.artists.total,
      ...query.artists,
    },
    albums: {
      albums: pages.albums.rows.map(albumSummary),
      total: pages.albums.total,
      ...query.albums,
    },
    songs: {
      songs: pages.songs.rows.map(songDetail),
      total: pages.songs.total,
      ...query.songs,
    },
  });
}
