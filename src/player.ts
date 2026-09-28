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

/** The last engine mutation, for the /api/player last_command surface. */
export interface LastCommand {
  /** 'seek' | 'play' | 'pause' | 'queueAdd' | 'volume' | 'restore' | … */
  kind: string;
  /** e.g. 'position_ms=30504000' — never credentials. */
  detail?: string;
  source: CommandSource;
  atMs: number;
}

/** One greppable line per engine mutation (plan command-provenance) — the
 * 2026-09-24 ghost-writer incident would have been one such line each. */
export function logCmd(
  kind: string,
  detail: string | undefined,
  source: CommandSource,
): void {
  const by = source.kind === 'http'
    ? `http ${source.peer ?? '?'}` +
      (source.user ? ` user=${source.user}` : '') +
      (source.client ? ` client=${source.client}` : '') +
      (source.userAgent ? ` (${source.userAgent})` : '')
    : `internal:${source.via ?? 'core'}`;
  console.log(
    `[cmd] ${kind}${detail !== undefined ? ` ${detail}` : ''} by ${by}`,
  );
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
  warn?: (msg: string) => void;
}): Promise<RestoreSnapshot | null> {
  const warn = opts.warn ??
    ((msg: string) => console.warn(`[melofon] ${msg}`));
  const queue: SongRow[] = [];
  const keptPositions: number[] = []; // original queue pos per kept song
  for (const [pos, id] of opts.queueIds.entries()) {
    const song = await opts.getSong(id);
    if (song === null) {
      warn(`restore: track ${id} no longer in the library, dropped`);
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
  /** RAOP device type token (appletv/apex1/...; from mDNS `am`) — passed to
   * the helper's start. */
  devtype?: string;
  /** Encrypt the RTP stream (mDNS `ek=1`). */
  encrypt?: boolean;
  /** OwnTone raop_device_cb wanted_metadata bitmask from TXT `md`
   * (1=text 2=artwork 4=progress). Absent `md` ⇒ 0. */
  wantedMetadata?: number;
  /** TXT `et` contains token 4: the device supports (not requires) auth-setup. */
  supportsAuthSetup?: boolean;
  /** TXT `sf` bit 9: device verification. OwnTone `requires_auth`. */
  requiresAuth?: boolean;
  /** TXT `sr`/`ss`/`ch` when present; the helper defaults 44100/16/2. */
  sampleRate?: number;
  bitsPerSample?: number;
  channels?: number;
  /** The device wants a PIN/password (OwnTone needs_auth_key on the wire);
   * set by the boot when its helper reports the auth/verification path. */
  needsAuthKey?: boolean;
}

export interface Outputs {
  list(): Output[];
  get(id: string): Output | null;
  /** Adds a boot's output; last-wins when the id is already registered.
   * Mutations take a provenance source like the player commands (plan
   * command-provenance): [cmd]-logged, no wire surface this round. */
  register(output: Output, source?: CommandSource): void;
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
    },
    source?: CommandSource,
  ): Output | null;
  /** Boots subscribe here for pin commands routed through update(). */
  onCommand(fn: (id: string, cmd: { pin?: string }) => void): void;
}

/** The persisted output remote (output_state row): mDNS-discovered and
 * hand-added alike. Session knobs (devtype/encrypt/…) are not persisted —
 * discovery re-derives them from TXT. */
export interface PersistedOutput {
  id: string;
  host?: string;
  port?: number;
  name: string;
  type: string;
  selected: boolean;
  volume: number;
}

/** Persistence port for output remotes (plan restart-transparency):
 * register/update/setEnabled/toggle upsert the full row; unregister keeps
 * it — the row is the last-seen state a re-announced or rebooted device
 * falls back to. Fire-and-forget like the player port. */
export interface OutputPersistence {
  saveOutput(row: PersistedOutput): void;
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
        return;
      }
      currentIndex = Math.min(Math.max(0, index), items.length - 1);
      const length = items[currentIndex].song.durationMs ?? 0;
      baseProgressMs = Math.min(
        Math.max(0, Math.round(snapshot.positionMs)),
        length,
      );
      startedAt = performance.now();
      state = snapshot.state;
    },
  };
}

export function createOutputs(
  { notify, persistence }: {
    notify?: Notify;
    persistence?: OutputPersistence;
  } = {},
): Outputs {
  const emit = (types: string[]) => notify?.emit(types);
  // Empty until a boot registers a real output — no dummy row.
  const outputs: Output[] = [];
  const find = (id: string) => outputs.find((o) => o.id === id) ?? null;
  const commandListeners = new Set<
    (id: string, cmd: { pin?: string }) => void
  >();
  const saveRow = (o: Output) =>
    persistence?.saveOutput({
      id: o.id,
      host: o.host,
      port: o.port,
      name: o.name,
      type: o.type,
      selected: o.selected,
      volume: o.volume,
    });

  return {
    list: () => outputs.map((o) => ({ ...o })),
    get: (id) => {
      const found = find(id);
      return found === null ? null : { ...found };
    },
    register(output, source) {
      const idx = outputs.findIndex((o) => o.id === output.id);
      if (idx === -1) outputs.push({ ...output });
      else outputs[idx] = { ...output };
      saveRow(find(output.id)!);
      logCmd('output.register', output.id, source ?? { kind: 'internal' });
      emit(['outputs']);
    },
    unregister(id, source) {
      const idx = outputs.findIndex((o) => o.id === id);
      if (idx === -1) return false;
      outputs.splice(idx, 1);
      // The persisted row stays: last-seen state for a re-announcement.
      logCmd('output.unregister', id, source ?? { kind: 'internal' });
      emit(['outputs']);
      return true;
    },
    setEnabled(ids, source) {
      if (ids.some((id) => find(id) === null)) return false;
      for (const o of outputs) o.selected = ids.includes(o.id);
      for (const o of outputs) saveRow(o);
      logCmd(
        'output.setEnabled',
        ids.join(','),
        source ?? { kind: 'internal' },
      );
      emit(['outputs']);
      return true;
    },
    toggle(id, source) {
      const found = find(id);
      if (found === null) return null;
      found.selected = !found.selected;
      saveRow(found);
      logCmd('output.toggle', id, source ?? { kind: 'internal' });
      emit(['outputs']);
      return { ...found };
    },
    update(id, opts, source) {
      const found = find(id);
      if (found === null) return null;
      if (opts.selected !== undefined) found.selected = opts.selected;
      if (opts.volume !== undefined) found.volume = clampVolume(opts.volume);
      if (opts.selected !== undefined || opts.volume !== undefined) {
        saveRow(found);
        logCmd(
          'output.update',
          id +
            (opts.selected !== undefined ? ` selected=${opts.selected}` : '') +
            (opts.volume !== undefined ? ` volume=${opts.volume}` : ''),
          source ?? { kind: 'internal' },
        );
      }
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
