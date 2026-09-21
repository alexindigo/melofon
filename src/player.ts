// src/player.ts — app.player / app.outputs: the server-side player engine
// (the OwnTone control plane). One in-memory queue (restart-lossy is fine),
// play/pause/stop state, master volume, and the outputs list. The outputs
// list starts EMPTY — no dummy sink; a boot registers real outputs
// (app.outputs.register, M6: Chromecast / AirPlay / FS) and an empty list is
// the truth, not a placeholder. Hats (OwnTone JSON, later the Melofon UI)
// drive this engine; they never hold player state themselves. The engine
// emits nothing itself — app.playback commands do (core owns the hub).
//
// No audio means progress is wall-clock: while state is 'play' the position
// advances in real time from the last seek/start base, clamped at the item
// length. Progress reaching the item length ENDS the item: advanceEnded()
// (driven by the playback core's clock) replays/advances/drops/stops per the
// repeat/consume modes — "no auto-advance" was fine for a queue-less mirror,
// it is a lie with boots attached (HA extrapolates past the end).
import type { SongRow } from './library.ts';
import type { Notify } from './notify.ts';

export interface QueueEntry {
  /** Queue-local int id (monotonic within the process, never reused). */
  id: number;
  song: SongRow;
}

export type PlayerState = 'play' | 'pause' | 'stop';
export type RepeatMode = 'off' | 'all' | 'single';

/** What an end-of-item transition touched (the playback core emits on it). */
export type AdvanceResult = 'none' | 'player' | 'player+queue';

export interface PlayerStatus {
  state: PlayerState;
  repeat: RepeatMode;
  consume: boolean;
  shuffle: boolean;
  /** Master volume, 0–100. */
  volume: number;
  /** Entry the wire reports: the current one while playing/paused; null
   * when stopped (no queue-head fallback) or the queue is empty. */
  current: QueueEntry | null;
  itemLengthMs: number;
  itemProgressMs: number;
}

export interface Player {
  status(): PlayerStatus;
  /** No-op on an empty queue (state stays 'stop'). `fromPosition` starts
   * the queue item at that 0-based index (OwnTone playback_from_position),
   * clamped into range; omitted → current (or queue head after stop). */
  play(fromPosition?: number): void;
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
  /** Appends — or inserts at 0-based `position` (OwnTone queue add
   * semantics: omit = append). Inserting at/before the current item shifts
   * it so it stays current. */
  queueAdd(songs: SongRow[], position?: number): QueueEntry[];
  /** Clears the queue and stops playback. */
  queueClear(): void;
  /** End-of-item transition (the engine's clock — driven by the playback
   * core): progress at item length means the item ENDED. repeat `single`
   * replays; `all` wraps to the head past the last item; consume drops the
   * finished item and the next plays; otherwise next, stopping past the
   * last. Unknown length (null duration) never ends. */
  advanceEnded(): AdvanceResult;
}

export interface Output {
  id: string;
  name: string;
  type: string;
  selected: boolean;
  volume: number;
  /** Boot address (e.g. an AirPlay device's IP) — internal boot config,
   * never part of the OwnTone wire payload. */
  host?: string;
  /** Boot port (RAOP defaults to 7000). */
  port?: number;
  /** RAOP device type token (appletv/apex1/...; from mDNS `am`) — passed to
   * the helper's start. */
  devtype?: string;
  /** Encrypt the RTP stream (mDNS `ek=1`). */
  encrypt?: boolean;
  /** The device wants a PIN/password (OwnTone needs_auth_key on the wire);
   * set by the boot when its helper reports the auth/verification path. */
  needsAuthKey?: boolean;
}

export interface Outputs {
  list(): Output[];
  get(id: string): Output | null;
  /** Adds a boot's output; last-wins when the id is already registered. */
  register(output: Output): void;
  /** Removes a registered output; false when the id was never registered. */
  unregister(id: string): boolean;
  /** Enables exactly the given ids; false when any id is unknown. */
  setEnabled(ids: string[]): boolean;
  toggle(id: string): Output | null;
  /** selected/volume/needsAuthKey are state (stored, emitted); pin is a
   * command — delivered synchronously to onCommand listeners (the boots),
   * never stored. */
  update(
    id: string,
    opts: {
      selected?: boolean;
      volume?: number;
      pin?: string;
      needsAuthKey?: boolean;
    },
  ): Output | null;
  /** Boots subscribe here for pin commands routed through update(). */
  onCommand(fn: (id: string, cmd: { pin?: string }) => void): void;
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

  const doPlay = (fromPosition?: number) => {
    if (items.length === 0) return; // empty queue: 204, state stays stop
    if (fromPosition !== undefined) {
      const at = Math.min(
        Math.max(0, Math.trunc(fromPosition)),
        items.length - 1,
      );
      startAt(at);
      return;
    }
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
      // Stopped means no current — not the queue head. A queue-head-as-
      // current fallback makes a stale item look played everywhere the
      // status is read (and made the now-playing mirror immortal).
      const entry = state === 'stop' ? null : currentEntry();
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

    play(fromPosition?: number) {
      doPlay(fromPosition);
    },

    pause() {
      if (state !== 'play') return;
      doPause();
    },

    stop() {
      doStop();
    },

    toggle() {
      if (items.length === 0) return;
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
      } else return;
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

    queueAdd(songs, position) {
      const added = songs.map((song) => ({ id: nextId++, song }));
      if (position === undefined || position >= items.length) {
        items = [...items, ...added];
      } else {
        const at = Math.max(0, Math.trunc(position));
        items = [...items.slice(0, at), ...added, ...items.slice(at)];
        // Inserted at/before the current item: shift so it stays current.
        if (currentIndex !== null && at <= currentIndex) {
          currentIndex += added.length;
        }
      }
      version++;
      return added;
    },

    queueClear() {
      items = [];
      version++;
      doStop();
      // The clear also stopped playback — both reads changed.
    },

    advanceEnded() {
      if (state !== 'play') return 'none';
      const entry = currentEntry();
      if (entry === null) return 'none';
      const length = entry.song.durationMs ?? 0;
      if (length <= 0 || progressMs() < length) return 'none';

      if (repeat === 'single') {
        // Replay the same item: reset the clock, keep playing.
        startAt(currentIndex!);
        return 'player';
      }
      if (repeat === 'all') {
        // Next, wrapping to the head past the last item.
        startAt((currentIndex! + 1) % items.length);
        return 'player';
      }
      if (consume) {
        // Drop the finished item; whatever lands at the index plays.
        const at = currentIndex!;
        items = [...items.slice(0, at), ...items.slice(at + 1)];
        version++;
        if (at >= items.length) {
          doStop();
          return 'player+queue';
        }
        startAt(at);
        return 'player+queue';
      }
      // repeat off: next; past the last item stops (next() semantics).
      if (currentIndex! + 1 >= items.length) {
        doStop();
        return 'player';
      }
      startAt(currentIndex! + 1);
      return 'player';
    },
  };
}

export function createOutputs({ notify }: { notify?: Notify } = {}): Outputs {
  const emit = (types: string[]) => notify?.emit(types);
  // Empty until a boot registers a real output — no dummy row.
  const outputs: Output[] = [];
  const find = (id: string) => outputs.find((o) => o.id === id) ?? null;
  const commandListeners = new Set<
    (id: string, cmd: { pin?: string }) => void
  >();

  return {
    list: () => outputs.map((o) => ({ ...o })),
    get: (id) => {
      const found = find(id);
      return found === null ? null : { ...found };
    },
    register(output) {
      const idx = outputs.findIndex((o) => o.id === output.id);
      if (idx === -1) outputs.push({ ...output });
      else outputs[idx] = { ...output };
      emit(['outputs']);
    },
    unregister(id) {
      const idx = outputs.findIndex((o) => o.id === id);
      if (idx === -1) return false;
      outputs.splice(idx, 1);
      emit(['outputs']);
      return true;
    },
    setEnabled(ids) {
      if (ids.some((id) => find(id) === null)) return false;
      for (const o of outputs) o.selected = ids.includes(o.id);
      emit(['outputs']);
      return true;
    },
    toggle(id) {
      const found = find(id);
      if (found === null) return null;
      found.selected = !found.selected;
      emit(['outputs']);
      return { ...found };
    },
    update(id, opts) {
      const found = find(id);
      if (found === null) return null;
      if (opts.selected !== undefined) found.selected = opts.selected;
      if (opts.volume !== undefined) found.volume = clampVolume(opts.volume);
      if (opts.needsAuthKey !== undefined) {
        found.needsAuthKey = opts.needsAuthKey;
      }
      if (opts.pin !== undefined) {
        // A command, not state: straight to the boot, never stored.
        for (const fn of [...commandListeners]) {
          try {
            fn(id, { pin: opts.pin });
          } catch (err) {
            console.debug('[melofon] outputs command listener threw:', err);
          }
        }
      }
      emit(opts.volume === undefined ? ['outputs'] : ['outputs', 'volume']);
      return { ...found };
    },
    onCommand(fn) {
      commandListeners.add(fn);
    },
  };
}
