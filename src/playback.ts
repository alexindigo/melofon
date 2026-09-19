// src/playback.ts — app.playback: THE shared playback read. Two planes stay
// real (ARCHITECTURE §4): Subsonic clients pull and play themselves (their
// rows live in app.nowPlaying); the server engine (app.player queue + state)
// is for boots. What is shared is the NOW-PLAYING READ — and it lives here,
// in core, because hats never merge stores themselves: they call this and
// encode the result (wire shaping is theirs; deciding what is playing is
// not).
//
// playerView() (OwnTone /api/player): the engine wins whenever it has a
// current item (play/pause, or stop-with-queue-head — today's fallback).
// Else the newest nowPlaying row is mirrored as state 'play' with a
// synthetic current so item_id/progress exist. The queue is NOT mirrored:
// /api/queue stays the server engine's, and a client report never enqueues.
//
// nowPlayingView() (OpenSubsonic getNowPlaying): the client rows plus a
// synthetic entry for the engine's current item, so an OwnTone/HA play is
// visible on /rest too.
import type { Library, SongRow } from './library.ts';
import type { NowPlaying } from './nowplaying.ts';
import type { Player } from './player.ts';

/** item_id for a mirrored client report — never a real queue item id. */
export const SYNTHETIC_ITEM_ID = -1;

export interface PlayerView {
  state: 'play' | 'pause' | 'stop';
  repeat: 'off' | 'all' | 'single';
  consume: boolean;
  shuffle: boolean;
  volume: number;
  /** Engine entry, or { id: SYNTHETIC_ITEM_ID, song } for a mirrored client
   * report; null when neither plane has anything. */
  current: { id: number; song: SongRow } | null;
  itemLengthMs: number;
  itemProgressMs: number;
}

export interface NowPlayingViewRow {
  username: string;
  client: string;
  song: SongRow;
  positionMs: number | null;
  startedAtMs: number;
}

export interface Playback {
  playerView(): Promise<PlayerView>;
  nowPlayingView(): Promise<NowPlayingViewRow[]>;
}

export function createPlayback(deps: {
  player: Player;
  nowPlaying: NowPlaying;
  library: Library;
  cfg: { user?: string };
}): Playback {
  const { player, nowPlaying, library, cfg } = deps;
  return {
    async playerView() {
      const status = player.status();
      if (status.current !== null) {
        return { ...status, current: status.current };
      }
      // Engine idle: mirror the newest client report that still resolves.
      for (const row of await nowPlaying.list()) {
        const song = await library.getSong(row.trackId);
        if (song === null) continue; // track vanished since the report
        return {
          state: 'play',
          repeat: status.repeat,
          consume: status.consume,
          shuffle: status.shuffle,
          volume: status.volume,
          current: { id: SYNTHETIC_ITEM_ID, song },
          itemLengthMs: song.durationMs ?? 0,
          itemProgressMs: row.positionMs ?? 0,
        };
      }
      return { ...status, current: null };
    },

    async nowPlayingView() {
      const out: NowPlayingViewRow[] = [];
      const status = player.status();
      if (status.current !== null) {
        out.push({
          username: cfg.user ?? 'melofon',
          client: 'melofon',
          song: status.current.song,
          positionMs: status.itemProgressMs,
          startedAtMs: Date.now(),
        });
      }
      for (const row of await nowPlaying.list()) {
        const song = await library.getSong(row.trackId);
        if (song === null) continue;
        out.push({
          username: row.username,
          client: row.client,
          song,
          positionMs: row.positionMs,
          startedAtMs: row.startedAtMs,
        });
      }
      return out;
    },
  };
}
