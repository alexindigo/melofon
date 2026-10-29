// layers/owntone/api/library/get.ts — GET /api/library: stats. db_playtime
// is SECONDS (probed httpd_jsonapi.c: fci.length / 1000 at both call sites —
// the doc table's "milliseconds" is wrong). updated_at omitted before the
// first scan completes.
import type { HatContext } from '#owntone/types.ts';

export default async (_request: unknown, context: HatContext) => {
  const status = await context.app.scan.status();
  const { statistics } = await context.app.library.statistics();
  return {
    songs: statistics.songCount,
    db_playtime: Math.trunc(statistics.durationMs / 1000),
    artists: statistics.browseArtistCount,
    albums: statistics.albumCount,
    started_at: context.app.startedAt ?? '',
    ...(status.lastScanMs !== null && {
      updated_at: new Date(status.lastScanMs).toISOString(),
    }),
    updating: status.scanning,
  };
};
