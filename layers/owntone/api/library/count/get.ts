// layers/owntone/api/library/count/get.ts — GET /api/library/count.
// db_playtime in SECONDS (same probe as /api/library). expression: only
// `data_kind is pipe` (→ zeros — we have no pipes); anything else → 400.
import { badRequest, browseArtists } from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  const expression = request.query.get('expression');
  if (expression !== null) {
    if (expression.trim().toLowerCase() === 'data_kind is pipe') {
      return { tracks: 0, artists: 0, albums: 0, db_playtime: 0 };
    }
    return badRequest();
  }
  const status = await context.app.scan.status();
  const albums = await context.app.library.listAlbums({
    sort: 'name',
    size: Number.MAX_SAFE_INTEGER,
    offset: 0,
  });
  const artists = await browseArtists(context.app);
  const playtimeMs = albums.reduce((n, a) => n + a.durationMs, 0);
  return {
    tracks: status.count,
    artists: artists.length,
    albums: albums.length,
    db_playtime: Math.trunc(playtimeMs / 1000),
  };
};
