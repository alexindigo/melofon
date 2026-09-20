// src/playback.ts — app.playback: THE playback core. Two planes
// (ARCHITECTURE §4): A, the server engine (one queue, real item ids — drives
// boots in M6); B, client sessions (the app plays; rows in app.nowPlaying).
// Hats parse inbound protocol into ONE command here and encode views back
// out. They keep no playback state, never merge stores, never emit — core
// mutates, then emits on app.notify after every successful command.
//
// Commands:
//   reportPlaying / reportStopped      plane B session writes
//   play/pause/stop/toggle/next/       plane A engine writes
//   previous/seek/setVolume/setShuffle/setRepeat/setConsume
//   queueAdd/queueClear
// Views:
//   playerView()      engine only (HA/OwnTone media_player; stop ⇒ no current)
//   queueView()       the engine queue (real queue-local ids)
//   nowPlayingView()  all B sessions + the engine's current when play/pause
import type { Library, SongRow } from './library.ts';
import type { NowPlaying } from './nowplaying.ts';
import type { Notify } from './notify.ts';
import type { Player, PlayerStatus, QueueEntry, RepeatMode } from './player.ts';

export interface ReportPlaying {
  username: string;
  client: string;
  trackId: string;
  /** The stream/report minting this session — reportStopped only clears a
   * session whose streamId is still current (an older Range completing must
   * not clear a newer stream). */
  streamId: string;
  positionMs?: number;
}

export interface NowPlayingViewRow {
  username: string;
  client: string;
  song: SongRow;
  positionMs: number | null;
  startedAtMs: number;
}

export interface Playback {
  reportPlaying(report: ReportPlaying): Promise<void>;
  reportStopped(opts: { streamId: string }): Promise<void>;

  play(): void;
  pause(): void;
  stop(): void;
  toggle(): void;
  next(): void;
  previous(): void;
  setShuffle(on: boolean): void;
  setConsume(on: boolean): void;
  setRepeat(mode: RepeatMode): void;
  setVolume(opts: { volume?: number; step?: number }): void;
  seek(opts: { positionMs?: number; seekMs?: number }): boolean;
  /** OwnTone queue add: `clear` first, then insert at `position` (omit =
   * append), `shuffle` mode set when given, and `play` starts playback (at
   * `playbackFromPosition` when given). One command, one emit. */
  queueAdd(
    songs: SongRow[],
    opts?: {
      position?: number;
      playbackFromPosition?: number;
      play?: boolean;
      clear?: boolean;
      shuffle?: boolean;
    },
  ): QueueEntry[];
  queueClear(): void;

  playerView(): PlayerStatus;
  queueView(): { version: number; items: QueueEntry[] };
  nowPlayingView(): Promise<NowPlayingViewRow[]>;
}

export function createPlayback(deps: {
  player: Player;
  nowPlaying: NowPlaying;
  library: Library;
  cfg: { user?: string };
  notify?: Notify;
}): Playback {
  const { player, nowPlaying, library, cfg, notify } = deps;
  const emit = (types: string[]) => notify?.emit(types);
  return {
    async reportPlaying(report) {
      await nowPlaying.set(
        report.username,
        report.client,
        report.trackId,
        report.streamId,
        report.positionMs,
      );
      emit(['player']);
    },

    async reportStopped({ streamId }) {
      // Clears only when this streamId is still the session's current one.
      if (await nowPlaying.clearByStreamId(streamId)) emit(['player']);
    },

    play() {
      player.play();
      emit(['player']);
    },
    pause() {
      player.pause();
      emit(['player']);
    },
    stop() {
      player.stop();
      emit(['player']);
    },
    toggle() {
      player.toggle();
      emit(['player']);
    },
    next() {
      player.next();
      emit(['player']);
    },
    previous() {
      player.previous();
      emit(['player']);
    },
    setShuffle(on) {
      player.setShuffle(on);
      emit(['options']);
    },
    setConsume(on) {
      player.setConsume(on);
      emit(['options']);
    },
    setRepeat(mode) {
      player.setRepeat(mode);
      emit(['options']);
    },
    setVolume(opts) {
      if (opts.volume === undefined && opts.step === undefined) return;
      player.setVolume(opts);
      emit(['volume']);
    },
    seek(opts) {
      const ok = player.seek(opts);
      if (ok) emit(['player']);
      return ok;
    },
    queueAdd(songs, opts = {}) {
      if (opts.clear) player.queueClear();
      const added = player.queueAdd(songs, opts.position);
      if (opts.shuffle !== undefined) player.setShuffle(opts.shuffle);
      if (opts.play) player.play(opts.playbackFromPosition);
      const types = ['queue'];
      if (opts.clear || opts.play) types.push('player');
      if (opts.shuffle !== undefined) types.push('options');
      emit(types);
      return added;
    },
    queueClear() {
      player.queueClear();
      // The clear also stopped the engine — both reads changed.
      emit(['queue', 'player']);
    },

    playerView: () => player.status(),
    queueView: () => player.queue(),

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
        if (song === null) continue; // track vanished since the report
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
