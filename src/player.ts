// src/player.ts — app.player / app.outputs: the server-side player engine
// (the OwnTone control plane). One in-memory queue (restart-lossy is fine),
// play/pause/stop state, master volume, and the outputs list. M5 ships one
// dummy output ({ id: "0", type: "fifo", name: "this server" }) — selecting
// it is a no-op; no audio leaves the box until M6 boots register real
// outputs. Hats (OwnTone JSON, later the Melofon UI) drive this engine; they
// never hold player state themselves.
//
// No audio means progress is wall-clock: while state is 'play' the position
// advances in real time from the last seek/start base, clamped at the item
// length. There is no auto-advance at the end of a track — the repeat /
// consume / shuffle modes are stored and reported on the wire, but their
// playback-order effects arrive with real playback (M6).
import type { SongRow } from './library.ts';

export interface QueueEntry {
  /** Queue-local int id (monotonic within the process, never reused). */
  id: number;
  song: SongRow;
}

export type PlayerState = 'play' | 'pause' | 'stop';
export type RepeatMode = 'off' | 'all' | 'single';

export interface PlayerStatus {
  state: PlayerState;
  repeat: RepeatMode;
  consume: boolean;
  shuffle: boolean;
  /** Master volume, 0–100. */
  volume: number;
  /** Entry the wire reports: the current one while playing/paused; the first
   * queued one when stopped (OwnTone's status fallback); null when empty. */
  current: QueueEntry | null;
  itemLengthMs: number;
  itemProgressMs: number;
}

export interface Player {
  status(): PlayerStatus;
  /** No-op on an empty queue (state stays 'stop'). */
  play(): void;
  pause(): void;
  stop(): void;
  toggle(): void;
  /** Move within the queue and start playback (OwnTone semantics); next past
   * the last item stops. */
  next(): void;
  previous(): void;
  setShuffle(on: boolean): void;
  setConsume(on: boolean): void;
  setRepeat(mode: RepeatMode): void;
  /** Absolute `volume` wins over relative `step`; clamped 0–100. */
  setVolume(opts: { volume?: number; step?: number }): void;
  /** Absolute `positionMs` wins over relative `seekMs`; clamped to the item.
   * Targets the entry the wire reports (current, else the queue head) and
   * starts playback (OwnTone semantics). False when the queue is empty. */
  seek(opts: { positionMs?: number; seekMs?: number }): boolean;
  queue(): { version: number; items: QueueEntry[] };
  queueAdd(songs: SongRow[]): QueueEntry[];
  /** Clears the queue and stops playback. */
  queueClear(): void;
}

export interface Output {
  id: string;
  name: string;
  type: string;
  selected: boolean;
  volume: number;
}

export interface Outputs {
  list(): Output[];
  get(id: string): Output | null;
  /** Enables exactly the given ids; false when any id is unknown. */
  setEnabled(ids: string[]): boolean;
  toggle(id: string): Output | null;
  update(
    id: string,
    opts: { selected?: boolean; volume?: number },
  ): Output | null;
}

function clampVolume(n: number): number {
  return Math.min(100, Math.max(0, Math.trunc(n)));
}

export function createPlayer(): Player {
  let items: QueueEntry[] = [];
  let version = 0;
  let nextId = 1;
  let state: PlayerState = 'stop';
  let repeat: RepeatMode = 'off';
  let consume = false;
  let shuffle = false;
  let volume = 50;
  let currentIndex: number | null = null;
  // Wall-clock progress: base is the frozen position; when playing, progress
  // is base + (now - startedAt).
  let baseProgressMs = 0;
  let startedAt = 0;

  const currentEntry = (): QueueEntry | null =>
    currentIndex === null ? null : items[currentIndex] ?? null;

  const progressMs = (): number => {
    const entry = currentEntry();
    if (entry === null) return 0;
    const length = entry.song.durationMs ?? 0;
    const elapsed = state === 'play'
      ? baseProgressMs + (performance.now() - startedAt)
      : baseProgressMs;
    return Math.min(Math.max(0, Math.round(elapsed)), length);
  };

  // Play from the current index (or the queue head), resetting the clock.
  const startAt = (index: number) => {
    currentIndex = index;
    baseProgressMs = 0;
    startedAt = performance.now();
    state = 'play';
  };

  const doPlay = () => {
    if (items.length === 0) return; // empty queue: 204, state stays stop
    if (state === 'pause') {
      // Resume from the frozen position.
      baseProgressMs = progressMs();
      startedAt = performance.now();
      state = 'play';
      return;
    }
    if (state === 'stop') startAt(currentIndex ?? 0);
  };

  const doPause = () => {
    if (state !== 'play') return;
    baseProgressMs = progressMs();
    state = 'pause';
  };

  const doStop = () => {
    state = 'stop';
    currentIndex = null;
    baseProgressMs = 0;
  };

  return {
    status(): PlayerStatus {
      const entry = state === 'stop' ? items[0] ?? null : currentEntry();
      return {
        state,
        repeat,
        consume,
        shuffle,
        volume,
        current: entry,
        itemLengthMs: entry?.song.durationMs ?? 0,
        itemProgressMs: state === 'stop' ? 0 : progressMs(),
      };
    },

    play: doPlay,
    pause: doPause,
    stop: doStop,

    toggle() {
      if (state === 'play') doPause();
      else doPlay();
    },

    next() {
      if (items.length === 0) return;
      const index = (currentIndex ?? -1) + 1;
      if (index >= items.length) {
        doStop();
        return;
      }
      startAt(index);
    },

    previous() {
      if (items.length === 0) return;
      startAt(Math.max(0, (currentIndex ?? 0) - 1));
    },

    setShuffle(on) {
      shuffle = on;
    },

    setConsume(on) {
      consume = on;
    },

    setRepeat(mode) {
      repeat = mode;
    },

    setVolume(opts) {
      if (opts.volume !== undefined) volume = clampVolume(opts.volume);
      else if (opts.step !== undefined) {
        volume = clampVolume(volume + opts.step);
      }
    },

    seek(opts) {
      const index = currentIndex ?? (items.length > 0 ? 0 : null);
      if (index === null) return false;
      const entry = items[index];
      const length = entry.song.durationMs ?? 0;
      const target = opts.positionMs !== undefined
        ? opts.positionMs
        : progressMs() + (opts.seekMs ?? 0);
      currentIndex = index;
      baseProgressMs = Math.min(Math.max(0, Math.round(target)), length);
      startedAt = performance.now();
      state = 'play'; // OwnTone starts playback after a seek
      return true;
    },

    queue() {
      return { version, items: [...items] };
    },

    queueAdd(songs) {
      const added = songs.map((song) => ({ id: nextId++, song }));
      items = [...items, ...added];
      version++;
      return added;
    },

    queueClear() {
      items = [];
      version++;
      doStop();
    },
  };
}

export function createOutputs(): Outputs {
  // The one M5 output: a dummy fifo that swallows nothing (no audio yet).
  const outputs: Output[] = [
    { id: '0', name: 'this server', type: 'fifo', selected: true, volume: 100 },
  ];
  const find = (id: string) => outputs.find((o) => o.id === id) ?? null;

  return {
    list: () => outputs.map((o) => ({ ...o })),
    get: (id) => {
      const found = find(id);
      return found === null ? null : { ...found };
    },
    setEnabled(ids) {
      if (ids.some((id) => find(id) === null)) return false;
      for (const o of outputs) o.selected = ids.includes(o.id);
      return true;
    },
    toggle(id) {
      const found = find(id);
      if (found === null) return null;
      found.selected = !found.selected;
      return { ...found };
    },
    update(id, opts) {
      const found = find(id);
      if (found === null) return null;
      if (opts.selected !== undefined) found.selected = opts.selected;
      if (opts.volume !== undefined) found.volume = clampVolume(opts.volume);
      return { ...found };
    },
  };
}
