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
import {
  type CommandSource,
  type LastCommand,
  logCmd,
  type Player,
  type PlayerPersistence,
  type PlayerStatus,
  type QueueEntry,
  type RepeatMode,
  type RestoreSnapshot,
} from './player.ts';

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

  /** Mutating commands take an optional provenance source (plan
   * command-provenance): hats pass the request's peer/user-agent; omitted
   * means an internal driver (boot, retry, restore). Every mutation is
   * recorded as lastCommand and logged as one [cmd] line. */
  play(source?: CommandSource): void;
  pause(source?: CommandSource): void;
  stop(source?: CommandSource): void;
  toggle(source?: CommandSource): void;
  next(source?: CommandSource): void;
  previous(source?: CommandSource): void;
  setShuffle(on: boolean, source?: CommandSource): void;
  setConsume(on: boolean, source?: CommandSource): void;
  setRepeat(mode: RepeatMode, source?: CommandSource): void;
  setVolume(
    opts: { volume?: number; step?: number },
    source?: CommandSource,
  ): void;
  seek(
    opts: { positionMs?: number; seekMs?: number },
    source?: CommandSource,
  ): boolean;
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
    source?: CommandSource,
  ): QueueEntry[];
  queueClear(source?: CommandSource): void;

  /** The engine's clock: end-of-item transition when progress reached the
   * item length (main.ts drives it on an interval; tests drive it directly).
   * Emits player (+queue when consume dropped the finished item). */
  advanceEnded(): void;

  /** Boot-time restore (main.ts): delegates to player.restore and records
   * it with source internal:restore. Emits and persists nothing — the
   * values came from the store. */
  restore(snapshot: RestoreSnapshot): void;

  playerView(): PlayerStatus;
  queueView(): { version: number; items: QueueEntry[] };
  nowPlayingView(): Promise<NowPlayingViewRow[]>;
  /** The last recorded engine mutation (null before the first). */
  lastCommand(): LastCommand | null;
  /** Stop the position-persistence tick (tests; main.ts never closes). */
  close(): void;
}

export function createPlayback(deps: {
  player: Player;
  nowPlaying: NowPlaying;
  library: Library;
  cfg: { user?: string };
  notify?: Notify;
  /** Restart transparency (plan restart-transparency): when present, every
   * state change flushes the engine snapshot and queue, and a 1 Hz tick
   * keeps position_ms current while playing. */
  persistence?: PlayerPersistence;
}): Playback {
  const { player, nowPlaying, library, cfg, notify, persistence } = deps;
  const emit = (types: string[]) => notify?.emit(types);

  // Provenance (plan command-provenance): every mutation is recorded and
  // logged with its source. Unsourced callers are internal drivers.
  let last: LastCommand | null = null;
  const record = (
    kind: string,
    detail: string | undefined,
    source?: CommandSource,
  ): void => {
    const src = source ?? { kind: 'internal' as const };
    last = {
      kind,
      ...(detail !== undefined ? { detail } : {}),
      source: src,
      atMs: Date.now(),
    };
    logCmd(kind, detail, src);
  };

  // Persistence flushes: the same paths that emit. Fire-and-forget — the
  // adapter serializes writes; the engine stays synchronous.
  const flushQueue = () =>
    persistence?.saveQueue(player.queue().items.map((e) => e.song.id));
  const flushState = () => {
    if (persistence === undefined) return;
    const status = player.status();
    const currentIndex = status.current === null
      ? null
      : player.queue().items.findIndex((e) => e.id === status.current!.id);
    persistence.saveState({
      state: status.state,
      currentIndex: currentIndex === -1 ? null : currentIndex,
      positionMs: status.itemProgressMs,
      repeat: status.repeat,
      shuffle: status.shuffle,
      consume: status.consume,
    });
  };
  // The position tick: writes only while the engine plays ("on while play,
  // off otherwise"), so a restored play needs no extra wiring. SIGKILL
  // loses at most ~1 s of position.
  const tick = persistence === undefined ? null : setInterval(() => {
    if (player.status().state === 'play') flushState();
  }, 1000);
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

    play(source) {
      player.play();
      record('play', undefined, source);
      flushState();
      emit(['player']);
    },
    pause(source) {
      player.pause();
      record('pause', undefined, source);
      flushState();
      emit(['player']);
    },
    stop(source) {
      player.stop();
      record('stop', undefined, source);
      flushState();
      emit(['player']);
    },
    toggle(source) {
      player.toggle();
      record('toggle', undefined, source);
      flushState();
      emit(['player']);
    },
    next(source) {
      player.next();
      record('next', undefined, source);
      flushState();
      emit(['player']);
    },
    previous(source) {
      player.previous();
      record('previous', undefined, source);
      flushState();
      emit(['player']);
    },
    setShuffle(on, source) {
      player.setShuffle(on);
      record('shuffle', `shuffle=${on}`, source);
      flushState();
      emit(['options']);
    },
    setConsume(on, source) {
      player.setConsume(on);
      record('consume', `consume=${on}`, source);
      flushState();
      emit(['options']);
    },
    setRepeat(mode, source) {
      player.setRepeat(mode);
      record('repeat', `repeat=${mode}`, source);
      flushState();
      emit(['options']);
    },
    setVolume(opts, source) {
      if (opts.volume === undefined && opts.step === undefined) return;
      player.setVolume(opts);
      record(
        'volume',
        opts.volume !== undefined
          ? `volume=${opts.volume}`
          : `step=${opts.step}`,
        source,
      );
      emit(['volume']);
    },
    seek(opts, source) {
      const ok = player.seek(opts);
      if (ok) {
        record(
          'seek',
          opts.positionMs !== undefined
            ? `position_ms=${Math.trunc(opts.positionMs)}`
            : `seek_ms=${opts.seekMs ?? 0}`,
          source,
        );
        flushState();
        emit(['player']);
      }
      return ok;
    },
    queueAdd(songs, opts = {}, source) {
      if (opts.clear) player.queueClear();
      const added = player.queueAdd(songs, opts.position);
      if (opts.shuffle !== undefined) player.setShuffle(opts.shuffle);
      if (opts.play) player.play(opts.playbackFromPosition);
      record(
        'queueAdd',
        `songs=${songs.length}` +
          (opts.clear ? ' clear' : '') +
          (opts.play ? ' play' : '') +
          (opts.position !== undefined ? ` position=${opts.position}` : ''),
        source,
      );
      // An insert can shift the current index, so the state row flushes
      // with the queue even when playback did not start or stop.
      flushQueue();
      flushState();
      const types = ['queue'];
      if (opts.clear || opts.play) types.push('player');
      if (opts.shuffle !== undefined) types.push('options');
      emit(types);
      return added;
    },
    queueClear(source) {
      player.queueClear();
      record('queueClear', undefined, source);
      flushQueue();
      flushState();
      // The clear also stopped the engine — both reads changed.
      emit(['queue', 'player']);
    },

    advanceEnded() {
      const result = player.advanceEnded();
      if (result === 'none') return;
      if (result === 'player+queue') flushQueue();
      flushState();
      emit(result === 'player+queue' ? ['queue', 'player'] : ['player']);
    },

    restore(snapshot) {
      player.restore(snapshot);
      record('restore', undefined, { kind: 'internal', via: 'restore' });
    },

    playerView: () => player.status(),
    queueView: () => player.queue(),
    lastCommand: () => last,

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

    close() {
      if (tick !== null) clearInterval(tick);
    },
  };
}
