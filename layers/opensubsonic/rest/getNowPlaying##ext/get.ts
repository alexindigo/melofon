// layers/opensubsonic/rest/getNowPlaying/get.ts — GET /rest/getNowPlaying.
// Server-wide current plays (Subsonic: "all users") from
// app.playback.nowPlayingView() — THE shared read: client-reported rows plus
// the server engine's current item (so an OwnTone/HA play shows on /rest
// too). The hat encodes; it does not merge stores. Entries are the Child
// payload plus username/minutesAgo/playerId/playerName and playbackReport fields.
import { ok } from '#opensubsonic/envelope.ts';
import { childOf } from '#opensubsonic/id3.ts';
import { loadPersonal } from '#opensubsonic/personal.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  // NowPlayingEntry extends Child, whose id is a media id. Radio/URL plays
  // have no catalog Child to stream or personalize; do not invent one.
  const rows = (await context.app.playback.nowPlayingView()).flatMap((row) =>
    row.facts.kind === 'song' ? [{ ...row, song: row.facts.song }] : []
  );
  const p = await loadPersonal(context, {
    songs: rows.map((row) => row.song.id),
  });
  const entries = rows.map((row) => ({
    ...childOf(row.song, p),
    // Subsonic requires a string; a server label is not a core user identity.
    username: row.kind === 'server' ? row.label : row.username,
    minutesAgo: Math.max(
      0,
      Math.floor((Date.now() - row.reportedAtMs) / 60000),
    ),
    playerId: row.kind === 'server' ? 0 : row.appPlayerId,
    playerName: row.kind === 'server' ? row.label : row.client,
    state: row.state,
    positionMs: row.positionMs,
    playbackRate: row.playbackRate,
  }));
  return ok(context, { nowPlaying: { entry: entries } });
};
