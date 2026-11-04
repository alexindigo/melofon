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
import type { State } from './state.ts';
import { SpeakerError } from './speaker-errors.ts';
import { type Log, scopedLog } from './logging.ts';
import {
  CONNECTION_STRATEGIES,
  CONNECTION_STRATEGY_DEFAULT_KEY,
  type ConnectionStrategy,
  DEFAULT_CONNECTION_STRATEGY,
  requireConnectionStrategy,
} from './connection-strategy.ts';

export interface QueueEntry {
  /** Queue-local int id (monotonic within the process, never reused). */
  id: number;
  song: SongRow;
}

export type PlayerState = 'play' | 'pause' | 'stop';
export type RepeatMode = 'off' | 'all' | 'single';

/** Provenance for an engine-affecting command (plan command-provenance):
 * who asked, from where. 'http' for hat/core requests; 'internal' for
 * core-driven mutations (boot, retry, restore) with `via` naming who. */
export interface CommandSource {
  kind: 'http' | 'internal';
  /** internal only: which core component drove it ('airplay-boot', …). */
  via?: string;
  peer?: string;
  userAgent?: string;
  user?: string;
  /** X-Melofon-Client when the caller names itself (plan
   * command-provenance-wire-fix) — a Melofon header, logged as client=,
   * never an OwnTone wire field. */
  client?: string;
}

/** Internal retained provenance/intent record, never an OwnTone wire field. */
export interface LastCommand {
  /** 'seek' | 'play' | 'pause' | 'queueAdd' | 'volume' | 'restore' | … */
  kind: string;
  /** e.g. 'position_ms=30504000' — never credentials. */
  detail?: string;
  source: CommandSource;
  atMs: number;
  intent: 'play' | 'pause' | 'stop' | 'none';
  queueCleared: boolean;
}

/** Build a CommandSource from a pathfinder request view (peer +
 * user-agent + X-Melofon-Client). Core endpoints use this; the owntone
 * hat mirrors it structurally (hats never import src/). */
export function sourceFromRequest(request: {
  headers?: { get(name: string): string | null };
  remoteAddr?: { hostname?: string };
}): CommandSource {
  const userAgent = request.headers?.get('user-agent') ?? undefined;
  const client = request.headers?.get('x-melofon-client')?.trim();
  return {
    kind: 'http',
    ...(request.remoteAddr?.hostname !== undefined
      ? { peer: request.remoteAddr.hostname }
      : {}),
    ...(userAgent !== undefined ? { userAgent: userAgent.slice(0, 80) } : {}),
    ...(client ? { client: client.slice(0, 80) } : {}),
  };
}

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
  /** Retained engine clock facts, absent when stopped. A restored run's
   * historical start is unknown; reportedAtMs is the observed transition,
   * never the time of a status read. Progress still uses a monotonic clock. */
  clock: { startedAtMs: number | null; reportedAtMs: number } | null;
}

/** The persisted engine snapshot (player_state row, minus updated_at). */
export interface PlayerStateSnapshot {
  state: PlayerState;
  /** Queue position of the current entry; null when none. */
  currentIndex: number | null;
  positionMs: number;
  repeat: RepeatMode;
  shuffle: boolean;
  consume: boolean;
}

/** Persistence port for restart transparency (plan restart-transparency).
 * The engine is synchronous, so saves are fire-and-forget — the adapter
 * (src/persistence.ts) serializes and logs failures. Implemented by the
 * DuckDB store; playback drives the cadence (flush on every state change,
 * 1 Hz position tick while playing). */
export interface PlayerPersistence {
  /** Rewrite the persisted queue (pos-ordered library song ids). */
  saveQueue(songIds: string[]): void;
  /** Upsert the singleton player_state row (updated_at = now). */
  saveState(snapshot: PlayerStateSnapshot): void;
}

/** What restore() loads at boot: the rehydrated queue plus the snapshot. */
export interface RestoreSnapshot extends PlayerStateSnapshot {
  queue: SongRow[];
}

/** Auto-resume PLAY only when the save is fresh and the environment still
 * matches (plan restart-transparency): last persist within the window in
 * both directions (a wall-clock jump makes updated_at stale or future),
 * the current track survived, and a saved-selected output exists. Anything
 * else restores PAUSE at the saved place — no 3am speaker. */
export function shouldAutoResume(opts: {
  savedState: PlayerState;
  updatedAtMs: number;
  nowMs: number;
  maxAgeMs: number;
  currentTrackPresent: boolean;
  selectedOutputPresent: boolean;
}): boolean {
  if (opts.savedState !== 'play') return false;
  const ageMs = opts.nowMs - opts.updatedAtMs;
  if (ageMs > opts.maxAgeMs || ageMs < -opts.maxAgeMs) return false;
  return opts.currentTrackPresent && opts.selectedOutputPresent;
}

/** Build the boot-time RestoreSnapshot from the persisted rows: rehydrate
 * the queue via the library (missing tracks drop with a warn), map the
 * persisted current index onto the kept songs, and decide play-vs-pause
 * per shouldAutoResume. Null when there is nothing to restore. */
export async function planRestore(opts: {
  queueIds: string[];
  saved: (PlayerStateSnapshot & { updatedAtMs: number }) | null;
  getSong: (id: string) => Promise<SongRow | null>;
  nowMs: number;
  maxAgeMs: number;
  selectedOutputPresent: boolean;
  log?: Log;
}): Promise<RestoreSnapshot | null> {
  const log = opts.log ?? scopedLog('player');
  const queue: SongRow[] = [];
  const keptPositions: number[] = []; // original queue pos per kept song
  for (const [pos, id] of opts.queueIds.entries()) {
    const song = await opts.getSong(id);
    if (song === null) {
      log.event('restore_missing', { track: id });
      continue;
    }
    keptPositions.push(pos);
    queue.push(song);
  }
  const { saved } = opts;
  if (saved === null && queue.length === 0) return null;
  // Map the persisted current index onto the rehydrated queue: subtract
  // the missing tracks before it. The current track itself missing leaves
  // the engine at the entry that shifted into its place, position 0.
  let currentIndex: number | null = null;
  let currentTrackPresent = false;
  if (saved?.currentIndex !== null && saved?.currentIndex !== undefined) {
    const keptBefore = keptPositions.filter(
      (pos) => pos < saved.currentIndex!,
    ).length;
    currentTrackPresent = keptPositions.includes(saved.currentIndex);
    currentIndex = currentTrackPresent
      ? keptBefore
      : Math.min(keptBefore, Math.max(0, queue.length - 1));
  }
  const resume = saved !== null && shouldAutoResume({
    savedState: saved.state,
    updatedAtMs: saved.updatedAtMs,
    nowMs: opts.nowMs,
    maxAgeMs: opts.maxAgeMs,
    currentTrackPresent,
    selectedOutputPresent: opts.selectedOutputPresent,
  });
  return {
    queue,
    state: saved === null || saved.state === 'stop'
      ? 'stop'
      : resume
      ? 'play'
      : 'pause',
    currentIndex,
    positionMs: currentTrackPresent ? saved?.positionMs ?? 0 : 0,
    repeat: saved?.repeat ?? 'off',
    shuffle: saved?.shuffle ?? false,
    consume: saved?.consume ?? false,
  };
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
  /** Boot-time restore (plan restart-transparency): load the rehydrated
   * queue plus the persisted snapshot in one shot. main.ts decides
   * play-vs-pause per shouldAutoResume. Emits nothing and persists nothing
   * — the values came from the store, so updated_at must not bump here. */
  restore(snapshot: RestoreSnapshot): void;
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
  /** The raw device model string (TXT `am`, e.g. 'AppleTV3,1') — identity,
   * not a session knob: persisted, preserved across model-less
   * re-registration, and what the boot's affected-model predicate matches
   * (plan atv3-session-recycle). */
  model?: string;
  /** Adapter-acquired stable receiver identity, never an address or live fact. */
  receiverIdentity?: string;
  /** TXT `sf` bit 9: device verification. OwnTone `requires_auth`. */
  requiresAuth?: boolean;
  /** The device wants a PIN/password (OwnTone needs_auth_key on the wire);
   * set by the boot when its helper reports the auth/verification path. */
  needsAuthKey?: boolean;
  connectionStrategy: ConnectionStrategy;
}

export type OutputRegistration = Omit<Output, 'connectionStrategy'> & {
  connectionStrategy?: ConnectionStrategy;
};
export interface OutputCommand {
  kind: 'register' | 'unregister' | 'setEnabled' | 'toggle' | 'update';
  source: CommandSource;
  selection?: { id: string; selected: boolean }[];
}

export interface Outputs {
  list(options?: { includeIgnored?: boolean }): Output[];
  get(id: string, options?: { includeIgnored?: boolean }): Output | null;
  ignored(): string[];
  ignore(id: string): Promise<void>;
  unignore(id: string): Promise<void>;
  /** Adds a boot's output; last-wins when the id is already registered.
   * Mutations take a provenance source like the player commands (plan
   * command-provenance): [cmd]-logged, no wire surface this round. */
  register(
    output: OutputRegistration,
    source?: CommandSource,
    lifetime?: 'observation' | 'restore',
  ): void;
  /** Restore identity/preferences without claiming a current observation. */
  restore(output: OutputRegistration, source?: CommandSource): void;
  /** Explicit configuration, never implied by selection or observation. */
  adopt(id: string): Promise<Output | null>;
  /** Cancel use and durably remove configuration. Observations may return later. */
  forget(id: string, source?: CommandSource): Promise<void>;
  /** Fences async work across removal/re-registration, not preference edits. */
  revision(id: string): number;
  lifetime(id: string): { adopted: boolean; discovered: boolean };
  /** Withdraw presence; adopted or selected identity/preferences remain.
   * A withdrawn temporary row is released when its last control reference ends. */
  withdraw(id: string, source?: CommandSource): void;
  ready(): Promise<void>;
  lastCommand(): OutputCommand | null;
  /** Removes a registered output; false when the id was never registered. */
  unregister(id: string, source?: CommandSource): boolean;
  /** Enables exactly the given ids; false when any id is unknown. */
  setEnabled(ids: string[], source?: CommandSource): boolean;
  toggle(id: string, source?: CommandSource): Output | null;
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
      requiresAuth?: boolean;
      connectionStrategy?: ConnectionStrategy;
    },
    source?: CommandSource,
  ): Output | null;
  /** Boots receive transient PIN commands and awaited forget cancellation. */
  onCommand(
    fn: (
      id: string,
      cmd: { pin?: string; forget?: true; ignore?: true },
    ) => unknown,
  ): void;
}

/** The adopted output remote (output_state row). Discovered-only devices
 * are session-local. Session knobs (devtype/encrypt/…) are not persisted —
 * discovery re-derives them from TXT. The model IS persisted: it is
 * identity, and the ATV3 recycle policy must survive a restart. */
export interface PersistedOutput {
  id: string;
  host?: string;
  port?: number;
  name: string;
  type: string;
  selected: boolean;
  volume: number;
  model?: string;
  receiverIdentity?: string;
  connectionStrategy?: ConnectionStrategy;
}

/** Only adopted preferences may be saved. Explicit adoption is awaited;
 * ordinary preference updates are serialized like the player port. */
export interface OutputPersistence {
  saveOutput(row: PersistedOutput): void;
  adoptOutput?(row: PersistedOutput): Promise<void>;
  deleteOutput?(id: string): Promise<void>;
  savedOutput?(id: string): PersistedOutput | undefined;
  ignoredOutputs?(): string[];
  setOutputIgnored?(id: string, value: boolean): Promise<void>;
}

function clampVolume(n: number): number {
  return Math.min(100, Math.max(0, Math.trunc(n)));
}

export function createPlayer(options: {
  now?: () => number;
  monotonicNow?: () => number;
} = {}): Player {
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
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
  let clock: PlayerStatus['clock'] = null;
  const anchor = (restart = false) => {
    const at = now();
    clock = {
      startedAtMs: restart ? at : clock?.startedAtMs ?? null,
      reportedAtMs: at,
    };
  };

  const currentEntry = (): QueueEntry | null =>
    currentIndex === null ? null : items[currentIndex] ?? null;

  const progressMs = (): number => {
    const entry = currentEntry();
    if (entry === null) return 0;
    const length = entry.song.durationMs ?? 0;
    const elapsed = state === 'play'
      ? baseProgressMs + (monotonicNow() - startedAt)
      : baseProgressMs;
    return Math.min(Math.max(0, Math.round(elapsed)), length);
  };

  // Play from the current index (or the queue head), resetting the clock.
  const startAt = (index: number) => {
    currentIndex = index;
    baseProgressMs = 0;
    startedAt = monotonicNow();
    state = 'play';
    anchor(true);
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
      startedAt = monotonicNow();
      state = 'play';
      anchor();
      return;
    }
    if (state === 'stop') startAt(currentIndex ?? 0);
  };

  const doPause = () => {
    if (state !== 'play') return;
    baseProgressMs = progressMs();
    state = 'pause';
    anchor();
  };

  const doStop = () => {
    state = 'stop';
    currentIndex = null;
    baseProgressMs = 0;
    clock = null;
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
        clock: clock === null ? null : { ...clock },
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
      const restart = state === 'stop';
      currentIndex = index;
      baseProgressMs = Math.min(Math.max(0, Math.round(target)), length);
      startedAt = monotonicNow();
      state = 'play'; // OwnTone starts playback after a seek
      anchor(restart);
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

    restore(snapshot) {
      items = snapshot.queue.map((song) => ({ id: nextId++, song }));
      if (items.length > 0) version++;
      repeat = snapshot.repeat;
      consume = snapshot.consume;
      shuffle = snapshot.shuffle;
      const index = snapshot.currentIndex;
      if (snapshot.state === 'stop' || index === null || items.length === 0) {
        // Stopped (or nothing to point at): queue restored, playback not.
        state = 'stop';
        currentIndex = null;
        baseProgressMs = 0;
        clock = null;
        return;
      }
      currentIndex = Math.min(Math.max(0, index), items.length - 1);
      const length = items[currentIndex].song.durationMs ?? 0;
      baseProgressMs = Math.min(
        Math.max(0, Math.round(snapshot.positionMs)),
        length,
      );
      startedAt = monotonicNow();
      state = snapshot.state;
      // The snapshot stores position/state, not the original start time.
      clock = { startedAtMs: null, reportedAtMs: now() };
    },
  };
}

export function createOutputs(
  { notify, persistence, state, log = scopedLog('outputs') }: {
    notify?: Notify;
    persistence?: OutputPersistence;
    state?: State;
    log?: Log;
  } = {},
): Outputs {
  state?.declare(CONNECTION_STRATEGY_DEFAULT_KEY, {
    type: 'string',
    enum: Object.keys(CONNECTION_STRATEGIES),
    default: DEFAULT_CONNECTION_STRATEGY,
    description: 'Connection strategy assigned to new AirPlay outputs',
  });
  const emit = (types: string[]) => notify?.emit(types, undefined, 'all');
  // Empty until a boot registers a real output — no dummy row.
  const outputs: Output[] = [];
  const adopted = new Set<string>();
  const discovered = new Set<string>();
  const withdrawn = new Set<string>();
  const forgetting = new Set<string>();
  const ignored = new Set<string>();
  const ignoring = new Map<string, Promise<void>>();
  const adopting = new Map<string, number>();
  const ignoredIds = () => persistence?.ignoredOutputs?.() ?? [...ignored];
  const isIgnored = (id: string) => ignoredIds().includes(id);
  const blocked = (id: string) => isIgnored(id) || ignoring.has(id);
  const revisions = new Map<string, number>();
  const revision = (id: string) => revisions.get(id) ?? 0;
  const bump = (id: string) => revisions.set(id, revision(id) + 1);
  const isAdopted = (id: string) =>
    persistence?.savedOutput
      ? persistence.savedOutput(id) !== undefined
      : adopted.has(id);
  const find = (id: string) => outputs.find((o) => o.id === id) ?? null;
  let last: OutputCommand | null = null;
  const record = (
    kind: OutputCommand['kind'],
    source?: CommandSource,
    selection?: OutputCommand['selection'],
  ) => {
    last = {
      kind,
      source: source ?? { kind: 'internal' },
      ...(selection === undefined ? {} : { selection }),
    };
  };
  let defaultStrategy = DEFAULT_CONNECTION_STRATEGY;
  let initialized = state === undefined;
  let defaultRevision = 0;
  state?.onChange((key, value) => {
    if (key !== CONNECTION_STRATEGY_DEFAULT_KEY) return;
    defaultStrategy = requireConnectionStrategy(value);
    defaultRevision++;
  });
  const initialization = state === undefined
    ? Promise.resolve()
    : (async () => {
      const before = defaultRevision;
      let readRevision: number | undefined;
      try {
        readRevision = defaultRevision;
        const value = await state.getTyped(CONNECTION_STRATEGY_DEFAULT_KEY);
        if (defaultRevision === readRevision) {defaultStrategy =
            requireConnectionStrategy(value);}
        initialized = true;
      } catch (error) {
        if (defaultRevision > (readRevision ?? before)) initialized = true;
        else throw error;
      }
    })();
  // The ready() caller owns the rejection; prevent an unobserved startup task.
  void initialization.catch(() => {});
  const commandListeners = new Set<
    (id: string, cmd: { pin?: string; forget?: true; ignore?: true }) => unknown
  >();
  const snapshot = (o: Output): PersistedOutput => ({
    id: o.id,
    host: o.host,
    port: o.port,
    name: o.name,
    type: o.type,
    selected: o.selected,
    volume: o.volume,
    model: o.model,
    receiverIdentity: o.receiverIdentity,
    connectionStrategy: o.connectionStrategy,
  });
  const saveRow = (o: Output) => {
    if (isAdopted(o.id)) persistence?.saveOutput(snapshot(o));
  };
  // Observation and selection are independent runtime references. Losing the
  // former cannot erase the latter, nor can either grant durable ownership.
  const releaseWithdrawn = () => {
    let changed = false;
    for (const id of withdrawn) {
      const row = find(id);
      if (row?.selected || isAdopted(id) || adopting.has(id)) continue;
      const idx = outputs.findIndex((o) => o.id === id);
      if (idx !== -1) {
        outputs.splice(idx, 1);
        bump(id);
        changed = true;
      }
      withdrawn.delete(id);
    }
    return changed;
  };
  const changeIgnored = (id: string, value: boolean): Promise<void> => {
    const previous = ignoring.get(id) ?? Promise.resolve();
    // Every marker mutation has its own result; a rejected predecessor must not
    // poison subsequent undo/retry. The reservation also fences control writes.
    const write = previous.catch(() => {}).then(async () => {
      if (value) {
        if (isAdopted(id) || adopting.has(id)) {
          throw new SpeakerError(
            'already_adopted',
            'Forget the adopted speaker before ignoring it',
          );
        }
        if (isIgnored(id)) return;
        const row = find(id);
        if (!row) throw new SpeakerError('not_found', 'Speaker not found');
        if (row.selected) {
          throw new SpeakerError(
            'speaker_in_use',
            'Deselect the speaker before ignoring it',
          );
        }
      } else if (!isIgnored(id)) {
        throw new SpeakerError('not_found', 'Ignored speaker not found');
      }
      if (persistence && !persistence.setOutputIgnored) {
        throw new Error('speaker ignore persistence unavailable');
      }
      await persistence?.setOutputIgnored?.(id, value);
      if (value) {
        ignored.add(id);
        // A catalog lookup begun before ignore cannot later replace the marker
        // through implicit completion of an older add-by-address operation.
        bump(id);
        await Promise.all(
          [...commandListeners].map((fn) => fn(id, { ignore: true })),
        );
      } else ignored.delete(id);
      emit(['outputs']);
    }).finally(() => {
      if (ignoring.get(id) === write) ignoring.delete(id);
    });
    ignoring.set(id, write);
    return write;
  };

  const api: Outputs = {
    ready: () => initialization,
    revision,
    lastCommand: () => last,
    list: (options) =>
      outputs.filter((o) => options?.includeIgnored || !isIgnored(o.id)).map((
        o,
      ) => ({ ...o })),
    get: (id, options) => {
      if (!options?.includeIgnored && isIgnored(id)) return null;
      const found = find(id);
      return found === null ? null : { ...found };
    },
    ignored: ignoredIds,
    ignore: (id) => changeIgnored(id, true),
    unignore: (id) => changeIgnored(id, false),
    lifetime: (id) => ({
      adopted: isAdopted(id),
      discovered: discovered.has(id),
    }),
    restore(output, source) {
      // Restoration uses the adopted cache, never caller-supplied live facts.
      api.register(output, source, 'restore');
    },
    async adopt(id) {
      let row = find(id);
      if (row === null || forgetting.has(id)) return null;
      if (ignoring.has(id)) {
        throw new SpeakerError('speaker_busy', 'Speaker ignore is in progress');
      }
      adopting.set(id, (adopting.get(id) ?? 0) + 1);
      try {
        const current = revision(id);
        if (persistence && !persistence.adoptOutput) {
          throw new Error('speaker adoption persistence unavailable');
        }
        // A control change during the write must also be durable on return.
        let saved: PersistedOutput;
        do {
          saved = snapshot(row);
          await persistence?.adoptOutput?.(saved);
          if (revision(id) !== current || forgetting.has(id)) return null;
          row = find(id);
        } while (
          row !== null &&
          JSON.stringify(snapshot(row)) !== JSON.stringify(saved)
        );
        if (row === null) return null;
        if (!persistence?.savedOutput) adopted.add(id);
        ignored.delete(id);
        emit(['outputs']);
        return { ...row };
      } finally {
        const count = adopting.get(id)! - 1;
        if (count) adopting.set(id, count);
        else adopting.delete(id);
        if (releaseWithdrawn()) emit(['outputs']);
      }
    },
    async forget(id, source) {
      const row = find(id);
      if (!row || forgetting.has(id)) throw new Error('speaker not found');
      if (persistence && !persistence.deleteOutput) {
        throw new Error('speaker deletion persistence unavailable');
      }
      forgetting.add(id);
      bump(id);
      // Revoke boot authority before publishing removal. Both command listeners
      // and the unregister notification see this incarnation as no longer usable.
      row.selected = false;
      const cancellations = [...commandListeners].map((fn) => {
        try {
          return Promise.resolve(fn(id, { forget: true }));
        } catch (error) {
          return Promise.reject(error);
        }
      });
      api.unregister(id, source);
      try {
        await Promise.all(cancellations);
        await persistence?.deleteOutput?.(id);
        adopted.delete(id);
      } catch (error) {
        // A failed forget is retryable, but must never resume the old session.
        outputs.push({ ...row });
        saveRow(row);
        throw error;
      } finally {
        forgetting.delete(id);
        emit(['outputs']);
      }
    },
    withdraw(id, source) {
      discovered.delete(id);
      if (!find(id)) return;
      withdrawn.add(id);
      if (isAdopted(id) || find(id)?.selected || adopting.has(id)) {
        emit(['outputs']);
      } else api.unregister(id, source);
    },
    register(output, source, lifetime = 'observation') {
      if (forgetting.has(output.id)) return;
      if (output.connectionStrategy !== undefined) {
        requireConnectionStrategy(output.connectionStrategy);
      }
      if (!initialized) {
        throw new Error(
          'output strategy default not initialized; await outputs.ready()',
        );
      }
      const idx = outputs.findIndex((o) => o.id === output.id);
      const saved = persistence?.savedOutput?.(output.id);
      const connectionStrategy = output.connectionStrategy ??
        find(output.id)?.connectionStrategy ??
        (saved === undefined
          ? defaultStrategy
          : saved.connectionStrategy ?? DEFAULT_CONNECTION_STRATEGY);
      requireConnectionStrategy(connectionStrategy);
      if (lifetime === 'observation') {
        discovered.add(output.id);
        withdrawn.delete(output.id);
      }
      if (idx === -1) {
        bump(output.id);
        outputs.push({
          ...output,
          connectionStrategy,
          ...(blocked(output.id) ? { selected: false } : {}),
        });
      } else {
        // Model is identity, not a session knob: a model-less same-id
        // re-registration (resolve timeout, TXT without `am`) keeps the
        // known model — only an explicit different model replaces it. No
        // other transient field is merged forward. The acquired receiver
        // binding is identity too and must not be erased by preference restores.
        const model = output.model ?? outputs[idx].model;
        const receiverIdentity = output.receiverIdentity ??
          outputs[idx].receiverIdentity;
        outputs[idx] = {
          ...output,
          connectionStrategy,
          ...(blocked(output.id) ? { selected: false } : {}),
          ...(model === undefined ? {} : { model }),
          ...(receiverIdentity === undefined ? {} : { receiverIdentity }),
        };
      }
      if (lifetime === 'observation') saveRow(find(output.id)!);
      record('register', source);
      log.event('command', {
        command: 'output.register',
        facts: { output: output.id },
        source: source ?? { kind: 'internal' },
      });
      emit(['outputs']);
    },
    unregister(id, source) {
      const idx = outputs.findIndex((o) => o.id === id);
      if (idx === -1) return false;
      outputs.splice(idx, 1);
      bump(id);
      discovered.delete(id);
      withdrawn.delete(id);
      record('unregister', source);
      // The persisted row stays: last-seen state for a re-announcement.
      log.event('command', {
        command: 'output.unregister',
        facts: { output: id },
        source: source ?? { kind: 'internal' },
      });
      emit(['outputs']);
      return true;
    },
    setEnabled(ids, source) {
      if (ids.some((id) => find(id) === null || blocked(id))) return false;
      for (const o of outputs) o.selected = ids.includes(o.id);
      for (const o of outputs) saveRow(o);
      releaseWithdrawn();
      record(
        'setEnabled',
        source,
        outputs.map((o) => ({ id: o.id, selected: ids.includes(o.id) })),
      );
      log.event('command', {
        command: 'output.setEnabled',
        facts: { outputs: ids },
        source: source ?? { kind: 'internal' },
      });
      emit(['outputs']);
      return true;
    },
    toggle(id, source) {
      if (blocked(id)) return null;
      const found = find(id);
      if (found === null) return null;
      found.selected = !found.selected;
      saveRow(found);
      releaseWithdrawn();
      record('toggle', source, [{ id, selected: found.selected }]);
      log.event('command', {
        command: 'output.toggle',
        facts: { output: id },
        source: source ?? { kind: 'internal' },
      });
      emit(['outputs']);
      return { ...found };
    },
    update(id, opts, source) {
      if (blocked(id)) return null;
      if (opts.connectionStrategy !== undefined) {
        requireConnectionStrategy(opts.connectionStrategy);
      }
      const found = find(id);
      if (found === null) return null;
      if (opts.selected !== undefined) found.selected = opts.selected;
      if (opts.volume !== undefined) found.volume = clampVolume(opts.volume);
      if (opts.connectionStrategy !== undefined) {
        found.connectionStrategy = opts.connectionStrategy;
      }
      record(
        'update',
        source,
        opts.selected === undefined
          ? undefined
          : [{ id, selected: opts.selected }],
      );
      if (
        opts.selected !== undefined || opts.volume !== undefined ||
        opts.connectionStrategy !== undefined
      ) {
        saveRow(found);
        log.event('command', {
          command: 'output.update',
          facts: {
            output: id,
            selected: opts.selected,
            volume: opts.volume,
            connectionStrategy: opts.connectionStrategy,
          },
          source: source ?? { kind: 'internal' },
        });
      }
      if (opts.needsAuthKey !== undefined) {
        found.needsAuthKey = opts.needsAuthKey;
      }
      if (opts.requiresAuth !== undefined) {
        found.requiresAuth = opts.requiresAuth;
      }
      if (opts.pin !== undefined) {
        // A command, not state: straight to the boot, never stored.
        for (const fn of [...commandListeners]) {
          try {
            fn(id, { pin: opts.pin });
          } catch (err) {
            log.event('output_listener_failed', { error: err });
          }
        }
      }
      releaseWithdrawn();
      emit(opts.volume === undefined ? ['outputs'] : ['outputs', 'volume']);
      return { ...found };
    },
    onCommand(fn) {
      commandListeners.add(fn);
    },
  };
  return api;
}
