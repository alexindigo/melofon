import type { HatContext, HatRequest } from '#melofon/types.ts';
import { searchPageQuery } from '#melofon/browse.ts';
import { browseArtwork } from '#melofon/browse-payloads.ts';
import { catalogResponse } from '#melofon/cache.ts';
import { core } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  const query = await searchPageQuery(request, context);
  const pages = await core(() =>
    context.app.library.searchPages(query.query, query)
  );
  const payload = browseArtwork(context);
  return catalogResponse(request, pages.revision, ['search', 1, query], {
    artists: {
      artists: await Promise.all(pages.artists.rows.map(payload.artist)),
      total: pages.artists.total,
      ...query.artists,
    },
    albums: {
      albums: await Promise.all(pages.albums.rows.map(payload.album)),
      total: pages.albums.total,
      ...query.albums,
    },
    songs: {
      songs: await Promise.all(pages.songs.rows.map(payload.song)),
      total: pages.songs.total,
      ...query.songs,
    },
  });
}
