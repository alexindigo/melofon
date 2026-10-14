// layers/opensubsonic/rest/getNowPlaying/get.ts — GET /rest/getNowPlaying.
// Server-wide current plays (Subsonic: "all users") from
// app.playback.nowPlayingView() — THE shared read: client-reported rows plus
// the server engine's current item (so an OwnTone/HA play shows on /rest
// too). The hat encodes; it does not merge stores. Entries are the Child
// payload plus username/minutesAgo/playerId/playerName — the OpenSubsonic
// playbackReport fields (state/positionMs/playbackRate) stay out: that
// extension is not advertised.
import { ok } from '#opensubsonic/envelope.ts';
import { childOf } from '#opensubsonic/id3.ts';
import { loadPersonal } from '#opensubsonic/personal.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const rows = await context.app.playback.nowPlayingView();
  const p = await loadPersonal(context, {
    songs: rows.map((row) => row.song.id),
  });
  const entries = rows.map((row) => ({
    ...childOf(row.song, p),
    username: row.username,
    minutesAgo: Math.max(
      0,
      Math.floor((Date.now() - row.startedAtMs) / 60000),
    ),
    playerId: 0,
    playerName: row.client,
  }));
  return ok(context, { nowPlaying: { entry: entries } });
};
