// layers/opensubsonic/rest/getNowPlaying/get.ts — GET /rest/getNowPlaying.
// Server-wide current plays (Subsonic: "all users"), newest first. Entries
// are the Child payload plus username/minutesAgo/playerId/playerName — the
// OpenSubsonic playbackReport fields (state/positionMs/playbackRate) stay
// out: that extension is not advertised.
import { ok } from '#opensubsonic/envelope.ts';
import { childOf } from '#opensubsonic/id3.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const rows = await context.app.nowPlaying.list();
  const entries: Record<string, unknown>[] = [];
  for (const row of rows) {
    const song = await context.app.library.getSong(row.trackId);
    if (song === null) continue; // track vanished since the notification
    entries.push({
      ...childOf(song),
      username: row.username,
      minutesAgo: Math.max(
        0,
        Math.floor((Date.now() - row.startedAtMs) / 60000),
      ),
      playerId: 0,
      playerName: row.client,
    });
  }
  return ok(context, { nowPlaying: { entry: entries } });
};
