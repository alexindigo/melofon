// layers/owntone/api/library/get.ts — GET /api/library: stats. db_playtime
// is SECONDS (probed httpd_jsonapi.c: fci.length / 1000 at both call sites —
// the doc table's "milliseconds" is wrong). updated_at omitted before the
// first scan completes.
import type { HatContext } from '#owntone/types.ts';

export default async (_request: unknown, context: HatContext) => {
  const status = await context.app.scan.status();
  const albums = await context.app.library.listAlbums({
    sort: 'name',
    size: Number.MAX_SAFE_INTEGER,
    offset: 0,
  });
  const artists = await context.app.library.listArtists();
  const playtimeMs = albums.reduce((n, a) => n + a.durationMs, 0);
  return {
    songs: status.count,
    db_playtime: Math.trunc(playtimeMs / 1000),
    artists: artists.length,
    albums: albums.length,
    started_at: context.app.startedAt ?? '',
    ...(status.lastScanMs !== null && {
      updated_at: new Date(status.lastScanMs).toISOString(),
    }),
    updating: status.scanning,
  };
};
