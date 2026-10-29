// layers/owntone/api/library/count/get.ts — GET /api/library/count.
// db_playtime in SECONDS (same probe as /api/library). expression: only
// `data_kind is pipe` (→ zeros — we have no pipes); anything else → 400.
import { badRequest } from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  const expression = request.query.get('expression');
  if (expression !== null) {
    if (expression.trim().toLowerCase() === 'data_kind is pipe') {
      return { tracks: 0, artists: 0, albums: 0, db_playtime: 0 };
    }
    return badRequest();
  }
  const { statistics } = await context.app.library.statistics();
  return {
    tracks: statistics.songCount,
    artists: statistics.browseArtistCount,
    albums: statistics.albumCount,
    db_playtime: Math.trunc(statistics.durationMs / 1000),
  };
};
