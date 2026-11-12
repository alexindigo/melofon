// Engine control facade. Owns this engine's commands, source lifetime and
// persistence; app reports and aggregate now-playing delegate to the household
// report owner. Hats parse one command and encode the result, without keeping
// playback state, merging stores or emitting changes themselves.
//
// Commands:
//   reportPlaying / reportStopped      plane B session writes
//   play/pause/stop/toggle/next/       plane A engine writes
//   previous/seek/setVolume/setShuffle/setRepeat/setConsume
//   queueAdd/queueClear
// Views:
//   playerView()      engine only (HA/OwnTone media_player; stop ⇒ no current)
//   queueView()       this engine's queue (permanent occurrence ids)
//   nowPlayingView()  all B sessions + the engine's current when play/pause
import type { Library, SongRow } from './library.ts';
import type {
  NowPlaying,
  PlaybackReport,
  SessionPlaybackReport,
} from './nowplaying.ts';
import type { Sessions } from './sessions.ts';
import type { Notify } from './notify.ts';
import type { State } from './state.ts';
import {
  createPlaybackReports,
  type NowPlayingViewRow,
  type PlaybackReports,
  type ReportPlaying,
  type ServerNowPlayingRow,
} from './playback-reports.ts';
export type { NowPlayingViewRow, ReportPlaying } from './playback-reports.ts';
import { type Log, scopedLog } from './logging.ts';
import {
  PlaybackError,
  QueueConflictError,
  QueueLimitError,
} from './playback-errors.ts';
import type {
  PlaybackCapacity,
  PlaybackReservation,
} from './playback-capacity.ts';
import { planSourceFailure } from './source-recovery.ts';
import {
  catalogMedia,
  createQueueResolver,
  type QueueAddReference,
  queueCapabilities,
  type QueueMedia,
  type QueueReference,
  type SourceMetadata,
} from './queue-source.ts';
import type {
  CommandSource,
  LastCommand,
  Outputs,
  PlaybackSource,
  Player,
  PlayerPersistence,
  PlayerStatus,
  QueueEntry,
  RepeatMode,
  RestoreSnapshot,
  SourceOutcome,
} from './player.ts';

/** A boot retains its own admission authority across asynchronous preparation.
 * Core checks it again immediately before committing the engine transition. */
export interface PlaybackAuthority {
  signal: AbortSignal;
  isCurrent(): boolean;
}

export interface QueueAddOptions {
  /** Core resolves destinations against the queue at the mutation boundary. */
  where?: 'end' | 'next' | { position: number };
  /** Start the first added occurrence; legacy play/from options stay unchanged. */
  startPlaying?: boolean;
  position?: number;
  playbackFromPosition?: number;
  play?: boolean;
  clear?: boolean;
  shuffle?: boolean;
}

/** Detached queue and bookmark facts, never source ids, clocks or live leases. */
export interface QueueCopySnapshot {
  items: QueueMedia[];
  currentIndex: number | null;
  positionMs: number;
  repeat: RepeatMode;
  consume: boolean;
}

export interface QueueCopyOptions {
  mode: 'replace' | 'add';
  where?: QueueAddOptions['where'];
  startPlaying?: boolean;
  expectedVersion?: number;
}

export interface Playback {
  reportPlaying(report: ReportPlaying): Promise<void>;
  reportStopped(opts: { streamId: string }): Promise<void>;
  reportPlayback(report: PlaybackReport): Promise<boolean>;
  reportSessionPlayback(report: SessionPlaybackReport): Promise<boolean>;

  /** Mutating commands take an optional provenance source (plan
   * command-provenance): hats pass the request's peer/user-agent; omitted
   * means an internal driver (boot, retry, restore). Every mutation is
   * recorded as lastCommand and logged as one [cmd] line. */
  play(
    source?: CommandSource,
    authority?: PlaybackAuthority,
  ): void | Promise<void>;
  pause(source?: CommandSource): void;
  stop(source?: CommandSource): void;
  toggle(source?: CommandSource): void | Promise<void>;
  next(source?: CommandSource): void | Promise<void>;
  previous(source?: CommandSource): void | Promise<void>;
  restart(source?: CommandSource): void | Promise<void>;
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
  ): boolean | Promise<boolean>;
  /** OwnTone queue add: `clear` first, then insert at `position` (omit =
   * append), `shuffle` mode set when given, and `play` starts playback (at
   * `playbackFromPosition` when given). One command, one emit. */
  queueAdd(
    songs: SongRow[],
    opts?: QueueAddOptions,
    source?: CommandSource,
  ): QueueEntry[] | Promise<QueueEntry[]>;
  /** Resolved core media. The composed source owner prepares URL facts before
   * publication; hats still resolve/admit their protocol's reference grammar. */
  queueAddSources(
    media: QueueMedia[],
    opts?: QueueAddOptions,
    source?: CommandSource,
  ): QueueEntry[] | Promise<QueueEntry[]>;
  /** Resolve the whole reference batch and prepare URL facts before mutation. */
  queueAddReferences(
    references: QueueAddReference[],
    opts?: QueueAddOptions,
    source?: CommandSource,
  ): Promise<QueueEntry[]>;
  queueClear(source?: CommandSource, expectedVersion?: number): void;
  queueRemove(
    entryId: number,
    expectedVersion?: number,
    source?: CommandSource,
  ): void | Promise<void>;
  queueMove(
    entryId: number,
    position: number,
    expectedVersion?: number,
    source?: CommandSource,
  ): void;
  queueCopyView(): QueueCopySnapshot;
  /** Source-side receipt only: does not cancel or change playback/queue. */
  queueCopied(targetId: number, source?: CommandSource): void;
  /** Registry supplies the atomic publication, including the source receipt. */
  queueImport(
    snapshot: QueueCopySnapshot,
    opts: QueueCopyOptions,
    source: CommandSource | undefined,
    publish: (change: () => void) => Promise<void>,
  ): Promise<void>;

  /** The engine's clock: end-of-item transition when progress reached the
   * item length (main.ts drives it on an interval; tests drive it directly).
   * Emits player (+queue when consume dropped the finished item). */
  advanceEnded(): void | Promise<void>;
  /** Elected boot source lifetime; engine transitions synchronously revoke it. */
  openSource(entryId: number, generation: number): PlaybackSource | null;
  cancelSource(source: PlaybackSource): void;
  sourceAudio(source: PlaybackSource, durationMs: number): void;
  /** One bounded source retry, cancelled with the lease. Not a speaker retry. */
  retrySource(source: PlaybackSource, reason: SourceOutcome): Promise<boolean>;
  reportSourceOutcome(source: PlaybackSource, outcome: SourceOutcome): boolean;
  /** Raw facts from the currently elected lease; no commands or hat labels. */
  reportSourceMetadata(
    source: PlaybackSource,
    metadata: SourceMetadata,
  ): boolean;

  /** Boot-time restore (main.ts): delegates to player.restore and records
   * it with source internal:restore. Refreshed activation facts can invalidate
   * the queue; other values came from the store. */
  restore(snapshot: RestoreSnapshot): void | Promise<void>;

  playerView(): PlayerStatus;
  queueView(): { version: number; items: QueueEntry[] };
  /** One synchronous snapshot; offsets are relative to the selected view. */
  queuePageView(options: {
    view: 'upNext' | 'all';
    offset: number;
    limit: number;
  }): {
    version: number;
    currentEntryId: number | null;
    startIndex: number;
    total: number;
    items: QueueEntry[];
  };
  nowPlayingView(): Promise<NowPlayingViewRow[]>;
  /** This engine's live aggregate input. App sessions are household-owned. */
  serverNowPlayingView(): ServerNowPlayingRow | null;
  /** The last recorded engine mutation (null before the first). */
  lastCommand(): LastCommand | null;
  /** Flush the current bookmark at a core-owned atomic mutation boundary. */
  checkpoint(): void;
  /** Core lifecycle; also callable with a controlled report clock in tests. */
  expireReports(): Promise<boolean>;
  startReportExpiry(state: State): Promise<void>;
  /** Stop ticks/subscriptions and drain any in-flight expiry before store close. */
  close(): Promise<void>;
}

export function createPlayback(deps: {
  playerId?: number;
  playerName?: () => string;
  capacity?: PlaybackCapacity;
  reserveQueueIds?: (count: number) => Promise<number>;
  player: Player;
  nowPlaying: NowPlaying;
  library: Pick<Library, 'getSong'>;
  cfg: { user?: string };
  outputs?: Pick<Outputs, 'list'>;
  /** Server composition supplies the speaker owner. Engine-only callers can
   * stay synchronous without outbound adapters. */
  targets?: {
    preparePlayback(signal: AbortSignal): Promise<void>;
    hasPlaybackTarget(): boolean;
  };
  notify?: Notify;
  sessions?: Pick<Sessions, 'onSessionsEnded'>;
  /** Server composition owns this once. Standalone callers retain one-player
   * behavior by allowing createPlayback to own a private report service. */
  reports?: PlaybackReports;
  /** Restart transparency (plan restart-transparency): when present, every
   * state change flushes the engine snapshot and queue, and a 1 Hz tick
   * keeps position_ms current while playing. */
  persistence?: PlayerPersistence;
  resolveQueueReference?: (
    reference: QueueReference,
  ) => Promise<QueueMedia | null>;
  expandQueueReference?: (
    reference: QueueAddReference,
    username: string | undefined,
    limit: number,
  ) => Promise<QueueReference[]>;
  prepareQueueMedia?: (
    media: QueueMedia,
    signal: AbortSignal,
  ) => Promise<QueueMedia>;
  state?: Pick<State, 'declare' | 'getTyped'>;
  log?: Log;
}): Playback {
  const { player, library, outputs, notify, persistence } = deps;
  let activeReservation: PlaybackReservation | undefined;
  const needsCapacity = () =>
    deps.capacity &&
    outputs?.list().some((out) =>
      out.selected && out.type === deps.capacity!.protocol
    );
  const releaseInactiveCapacity = () => {
    if (player.status().state !== 'play' || !needsCapacity()) {
      activeReservation?.release();
      activeReservation = undefined;
    }
  };
  const reserveStart = (starts: boolean, controller?: AbortController) => {
    const reservation = starts && needsCapacity()
      ? deps.capacity!.reserve()
      : undefined;
    controller?.signal.addEventListener('abort', () => reservation?.release(), {
      once: true,
    });
    return reservation;
  };
  const commitStart = <T>(
    reservation: PlaybackReservation | undefined,
    commit: () => T,
  ): T => {
    if (reservation && !reservation.isCurrent()) {
      throw new PlaybackError(
        'playback_cancelled',
        'Playback reservation expired',
      );
    }
    const result = commit();
    if (
      reservation?.isCurrent() && player.status().state === 'play' &&
      needsCapacity()
    ) {
      const previous = activeReservation;
      activeReservation = deps.capacity!.reserve();
      previous?.release();
    }
    releaseInactiveCapacity();
    return result;
  };
  const log = deps.log ?? scopedLog('playback');
  const defaultQueueLimit = 8192;
  deps.state?.declare('playback.queueLimit', {
    type: 'integer',
    minimum: 1,
    maximum: 9007199254740990,
    default: defaultQueueLimit,
    description:
      'Maximum queue entries per server player; additions are atomic',
  });
  const queueLimit = async () =>
    Number(
      await deps.state?.getTyped('playback.queueLimit') ?? defaultQueueLimit,
    );
  const checkSize = (count: number, opts: QueueAddOptions, limit: number) => {
    if (count + (opts.clear ? 0 : player.queue().items.length) > limit) {
      throw new QueueLimitError(limit);
    }
  };
  let openedSource: PlaybackSource | null = null;
  const recoverySettings = {
    retryBackoffMs: {
      type: 'array',
      items: { type: 'integer', minimum: 0, maximum: 600000 },
      default: [1000, 2000, 5000],
      description: 'One delay per web source retry; empty disables retries',
    },
    retryResetAudioMs: {
      type: 'integer',
      minimum: 1,
      maximum: 3600000,
      default: 30000,
      description:
        'Delivered audio in one attempt before replenishing source retries',
    },
  };
  for (const [key, schema] of Object.entries(recoverySettings)) {
    deps.state?.declare(`playback.source.${key}`, schema);
  }
  let recovery = { generation: -1, attempts: 0, audioMs: 0 };
  const failedSources = new Set<number>();
  const recoveryForRun = () => {
    const generation = player.status().generation;
    if (recovery.generation !== generation) {
      recovery = { generation, attempts: 0, audioMs: 0 };
    }
    return recovery;
  };
  const ownsSource = (source: PlaybackSource) =>
    !closed && !closing && openedSource === source && !source.signal.aborted;
  let failedSource: PlaybackSource | null = null;
  let failureWork:
    | { source: PlaybackSource; promise: Promise<void> }
    | undefined;
  const selectedSpeakers = () =>
    (outputs?.list() ?? []).filter((o) => o.selected).map(
      ({ id, name }) => ({ id, name }),
    );
  const hasServerRow = () => player.status().current !== null;
  const invalidateNowPlaying = () =>
    notify?.emit(['nowPlaying'], undefined, 'all');

  // Provenance (plan command-provenance): every mutation is recorded and
  // logged with its source. Unsourced callers are internal drivers.
  let last: LastCommand | null = null;
  let commander: string | null = null;
  const serverNowPlayingView = (): ServerNowPlayingRow | null => {
    const status = player.status();
    if (status.current === null || status.clock === null) return null;
    const { id, ...media } = status.current;
    return {
      ...media,
      kind: 'server',
      entryId: id,
      playerId: deps.playerId ?? 1,
      playerName: deps.playerName?.() ?? 'melofon',
      label: 'melofon',
      commander,
      speakers: selectedSpeakers(),
      positionMs: status.itemProgressMs,
      startedAtMs: status.clock.startedAtMs,
      reportedAtMs: status.clock.reportedAtMs,
      state: status.state === 'play' ? 'playing' : 'paused',
      playbackRate: 1,
    };
  };
  let serverPresent = hasServerRow();
  let announcedCommander: string | null = commander;
  let announcedQueueVersion = player.queue().version;
  // Engine events keep their existing vocabulary. The aggregate additionally
  // changes on clock/current transitions and on external attribution changes,
  // including commands (volume/options/queue edits) without a player event.
  const emit = (types: string[]) => {
    const version = player.queue().version;
    if (version !== announcedQueueVersion) {
      announcedQueueVersion = version;
      if (!types.includes('queue')) {
        flushQueue();
        types = [...types, 'queue'];
      }
    }
    const present = hasServerRow();
    const changed = (types.includes('player') && (present || serverPresent)) ||
      (present && commander !== announcedCommander);
    serverPresent = present;
    announcedCommander = commander;
    const engineTypes = types.filter((type) =>
      ['player', 'queue', 'volume', 'options'].includes(type)
    );
    const keys = deps.playerId === undefined ? undefined : Object.fromEntries(
      engineTypes.map((type) => [type, [String(deps.playerId)]]),
    );
    notify?.emit(changed ? [...types, 'nowPlaying'] : types, keys, 'all');
    releaseInactiveCapacity();
  };
  // Playback owns the aggregate dependency on selected target names/ids, not
  // hats or individual output call sites. Ignore volume, admission and other
  // output facts which do not appear in this view. Drop the subscription on close.
  let speakers = JSON.stringify(selectedSpeakers());
  let pendingStart: AbortController | undefined;
  const cancelStart = (expected = pendingStart) => {
    if (pendingStart !== expected) return;
    pendingStart?.abort();
    pendingStart = undefined;
  };
  const targetKey = () =>
    JSON.stringify(
      outputs?.list().filter((o) => o.selected).map((
        o,
      ) => [o.id, o.type, o.host, o.port]),
    );
  let targets = targetKey();
  const transition = <T>(
    starts: boolean,
    commit: (activate: () => void) => T,
    authority?: PlaybackAuthority,
    activation?: {
      index: number;
      items?: QueueMedia[];
      direction?: number;
      wrap?: boolean;
      excluded?: ReadonlySet<number>;
    },
  ): T | Promise<T> => {
    const current = () =>
      !closed && !closing &&
      (!authority || !authority.signal.aborted && authority.isCurrent());
    const cancelled = () =>
      new PlaybackError('playback_cancelled', 'Playback start cancelled');
    if (!current()) throw cancelled();
    cancelStart();
    const before = player.queue().items;
    const items = activation?.items ?? player.queue().items;
    const candidate = activation && items[activation.index];
    const needsPreparation = (item: QueueMedia) =>
      deps.prepareQueueMedia &&
      item.facts.kind === 'web' && item.facts.mode === 'unknown';
    const needsResolution = starts && activation && candidate &&
      (deps.resolveQueueReference && candidate.reference.kind === 'station' ||
        needsPreparation(candidate));
    if (!starts || !deps.targets && !needsResolution) {
      const reservation = reserveStart(starts);
      try {
        return commitStart(reservation, () => commit(() => {}));
      } finally {
        reservation?.release();
      }
    }
    const controller = new AbortController();
    const reservation = reserveStart(starts, controller);
    const abort = () => controller.abort();
    authority?.signal.addEventListener('abort', abort, { once: true });
    pendingStart = controller;
    const prepare = async () => {
      let selected:
        | { index: number; media: QueueMedia; entryId?: number }
        | null
        | undefined;
      if (needsResolution) {
        selected = null;
        let index = activation.index;
        for (let visited = 0; visited < items.length; visited++) {
          if (index < 0 || index >= items.length) break;
          const item = items[index];
          let media = activation.excluded?.has((item as QueueEntry).id)
            ? null
            : item.reference.kind === 'station' && deps.resolveQueueReference
            ? await deps.resolveQueueReference!(item.reference)
            : item;
          if (media && needsPreparation(media)) {
            media = await deps.prepareQueueMedia!(media, controller.signal);
          }
          if (controller.signal.aborted) throw cancelled();
          if (media) {
            selected = { index, media, entryId: (item as QueueEntry).id };
            break;
          }
          index += activation.direction ?? 1;
          if (activation.wrap) index = (index + items.length) % items.length;
        }
      }
      if (selected !== null) {
        await deps.targets?.preparePlayback(controller.signal);
      }
      return selected;
    };
    return prepare().then((selected) => {
      if (
        controller.signal.aborted || pendingStart !== controller || !current()
      ) throw cancelled();
      // A preparation plan refers to occurrences, not reusable ordinals. Queue
      // additions may publish during this await without cancelling the start.
      // Validate the original anchor before the command mutates anything; future
      // queues (consume/add/restore) are installed synchronously by commit.
      const planned = selected ?? candidate;
      const entryId = planned &&
        ('entryId' in planned ? planned.entryId : (planned as QueueEntry).id);
      const originalIndex = before.findIndex((entry) => entry.id === entryId);
      if (
        originalIndex >= 0 &&
        player.queue().items[originalIndex]?.id !== entryId
      ) {
        throw cancelled();
      }
      pendingStart = undefined;
      const result = commitStart(reservation, () =>
        commit(() => {
          if (selected === undefined) return;
          if (selected === null) {
            player.stop();
            return;
          }
          if (
            selected.entryId !== undefined &&
            player.queue().items[selected.index]?.id !== selected.entryId
          ) {
            throw cancelled();
          }
          player.replaceMedia(selected.index, selected.media);
          if (selected.index !== activation!.index) player.play(selected.index);
        }));
      if (selected !== undefined) {
        flushQueue();
        emit(['queue']);
      }
      return result;
    }).catch((error) => {
      // Cancellation is an authority outcome, including aborts rejected by an
      // asynchronous source owner, never a failed restore to publish afterward.
      if (controller.signal.aborted || !current()) throw cancelled();
      throw error;
    }).finally(() => {
      reservation?.release();
      authority?.signal.removeEventListener('abort', abort);
      if (pendingStart === controller) pendingStart = undefined;
    });
  };
  const unsubscribeOutputs = outputs &&
    notify?.subscribe((types, _keys, audience) => {
      if (audience !== 'all' || !types.includes('outputs')) return;
      const next = JSON.stringify(selectedSpeakers());
      const changed = speakers !== next;
      speakers = next;
      const key = targetKey();
      if (key !== targets) {
        targets = key;
        cancelStart();
      }
      if (pendingStart && deps.targets && !deps.targets.hasPlaybackTarget()) {
        cancelStart();
      }
      if (
        deps.targets && player.status().state === 'play' &&
        !deps.targets.hasPlaybackTarget()
      ) {
        cancelStart();
        player.pause();
        record('pause', undefined, {
          kind: 'internal',
          via: 'playback-target-loss',
        }, 'pause');
        flushState();
        emit(['player']);
      }
      if (changed && hasServerRow()) invalidateNowPlaying();
      releaseInactiveCapacity();
      // A playing engine can acquire its first constrained output through a
      // membership command. Registry admission holds a ticket during this
      // synchronous notification, but only playback retains active demand.
      if (
        player.status().state === 'play' && needsCapacity() &&
        !activeReservation
      ) {
        activeReservation = deps.capacity!.reserve();
      }
    });
  const record = (
    kind: string,
    detail: string | undefined,
    source?: CommandSource,
    intent: LastCommand['intent'] = 'none',
    queueCleared = false,
    facts?: Record<string, unknown>,
  ): void => {
    const src = source ?? { kind: 'internal' as const };
    if (intent !== 'none' && src.via !== 'source-outcome') {
      failedSources.clear();
    }
    if (src.kind === 'http') commander = src.user ?? null;
    last = {
      kind,
      ...(detail !== undefined ? { detail } : {}),
      source: src,
      atMs: Date.now(),
      intent,
      queueCleared,
    };
    if (kind !== 'restore') persistence?.saveCommand?.(last.atMs);
    log.event('command', {
      command: kind,
      facts,
      source: src,
      intent,
      queueCleared,
    });
  };

  // Persistence flushes: the same paths that emit. Fire-and-forget — the
  // adapter serializes writes; the engine stays synchronous.
  const stateSnapshot = () => {
    const status = player.status();
    const currentIndex = status.current === null
      ? null
      : player.queue().items.findIndex((e) => e.id === status.current!.id);
    return {
      state: status.state,
      currentIndex: currentIndex === -1 ? null : currentIndex,
      positionMs: status.itemProgressMs,
      repeat: status.repeat,
      shuffle: status.shuffle,
      consume: status.consume,
    };
  };
  const flushQueue = () =>
    persistence?.saveQueue(player.queueSnapshot(), stateSnapshot());
  const flushState = () => persistence?.saveState(stateSnapshot());
  const checkVersion = (expectedVersion?: number) => {
    if (
      expectedVersion !== undefined &&
      expectedVersion !== player.queue().version
    ) {
      throw new QueueConflictError(player.queue().version);
    }
  };
  const requireEntry = (entryId: number) => {
    const index = player.queue().items.findIndex((entry) =>
      entry.id === entryId
    );
    if (index < 0) {
      throw new PlaybackError('missing_entry', 'Queue entry not found');
    }
    return index;
  };
  // The position tick: writes only while the engine plays ("on while play,
  // off otherwise"), so a restored play needs no extra wiring. SIGKILL
  // loses at most ~1 s of position.
  const tick = persistence === undefined ? null : setInterval(() => {
    if (player.status().state === 'play') flushState();
  }, 1000);
  let closed = false;
  let closing = false;
  const reports = deps.reports ?? createPlaybackReports({
    nowPlaying: deps.nowPlaying,
    library,
    sessions: deps.sessions,
    notify,
    log,
    serverRows: () => {
      const row = serverNowPlayingView();
      return row ? [row] : [];
    },
  });
  const commitAdd = (
    media: QueueMedia[],
    opts: QueueAddOptions = {},
    source?: CommandSource,
    firstId?: number,
    limit = defaultQueueLimit,
    replacedStart?: AbortController,
  ): QueueEntry[] | Promise<QueueEntry[]> => {
    checkSize(media.length, opts, limit);
    const size = media.length + (opts.clear ? 0 : player.queue().items.length);
    const future = opts.clear ? [] : player.queue().items;
    const currentIndex = future.findIndex((entry) =>
      entry.id === player.status().current?.id
    );
    const position = opts.where === 'next'
      ? currentIndex + 1
      : typeof opts.where === 'object'
      ? opts.where.position
      : opts.where === 'end'
      ? future.length
      : opts.position;
    const at = Math.min(
      Math.max(0, Math.trunc(position ?? future.length)),
      future.length,
    );
    opts = {
      ...opts,
      position: opts.where === undefined ? opts.position : at,
      play: opts.startPlaying && media.length > 0 || opts.play,
      playbackFromPosition: opts.startPlaying && media.length
        ? at
        : opts.playbackFromPosition,
    };
    // Incoming occurrences are copied as media and receive fresh ids at commit.
    // Only entries already in the destination carry occurrence identity in the
    // activation plan; a source id must never be mistaken for a destination id.
    const items = [
      ...future.slice(0, at),
      ...media.map((item) => ({ ...item, id: undefined })),
      ...future.slice(at),
    ];
    const oldCurrent = player.status().current;
    const index = opts.playbackFromPosition !== undefined
      ? Math.min(Math.max(0, Math.trunc(opts.playbackFromPosition)), size - 1)
      : oldCurrent && !opts.clear
      ? items.indexOf(oldCurrent)
      : 0;
    const commit = (activate: () => void) => {
      checkSize(media.length, opts, limit);
      if (opts.clear) player.queueClear();
      const added = player.queueAddSources(media, at, firstId);
      if (opts.shuffle !== undefined) player.setShuffle(opts.shuffle);
      if (opts.play) player.play(opts.playbackFromPosition);
      activate();
      record(
        'queueAdd',
        `songs=${media.length}` + (opts.clear ? ' clear' : '') +
          (opts.play ? ' play' : '') +
          (opts.position !== undefined ? ` position=${opts.position}` : ''),
        source,
        opts.play ? 'play' : opts.clear ? 'stop' : 'none',
        opts.clear === true,
        {
          songs: media.length,
          clear: opts.clear,
          play: opts.play,
          position: opts.position,
          playbackFromPosition: opts.playbackFromPosition,
          shuffle: opts.shuffle,
        },
      );
      flushQueue();
      const types = ['queue'];
      if (opts.clear || opts.play) types.push('player');
      if (opts.shuffle !== undefined) types.push('options');
      emit(types);
      return added;
    };
    // A clear-only replacement revokes only the start present at submission,
    // never a later command waiting behind this addition's slow work.
    if (!opts.play) {
      if (opts.clear && replacedStart) cancelStart(replacedStart);
      return commit(() => {});
    }
    return transition(
      size > 0,
      commit,
      undefined,
      opts.clear || opts.playbackFromPosition !== undefined ||
        player.status().state !== 'play'
        ? { index, items }
        : undefined,
    );
  };
  const resolveReference = deps.resolveQueueReference ?? createQueueResolver({
    getSong: (id) => library.getSong(id),
    getStation: () => Promise.resolve(null),
  });
  // One ordered mutation lane spans resolution, preparation and allocation.
  // Only add-and-play borrows pendingStart; ordinary adds have their own
  // lifetime, revoked by destructive queue clear/restore or engine disposal.
  let additionTail: Promise<void> | undefined;
  const additions = new Set<AbortController>();
  const cancelAdditions = () => {
    for (const controller of additions) controller.abort();
  };
  const add = (
    resolve: (
      signal: AbortSignal,
      limit: number,
    ) => QueueMedia[] | Promise<QueueMedia[]>,
    opts: QueueAddOptions = {},
    source?: CommandSource,
    prepare = false,
  ): QueueEntry[] | Promise<QueueEntry[]> => {
    requireOpen();
    const replacedStart = pendingStart;
    const controller = new AbortController();
    const starts = opts.startPlaying === true || opts.play === true;
    if (starts) cancelStart();
    const reservation = reserveStart(starts, controller);
    if (starts) pendingStart = controller;
    let limit = defaultQueueLimit;
    additions.add(controller);
    const check = () => {
      if (controller.signal.aborted || closed || closing) {
        throw new PlaybackError(
          'playback_cancelled',
          'Queue addition cancelled',
        );
      }
    };
    const finish = () => {
      additions.delete(controller);
      reservation?.release();
      if (pendingStart === controller) pendingStart = undefined;
    };
    const failed = (error: unknown): never => {
      if (controller.signal.aborted) {
        throw new PlaybackError(
          'playback_cancelled',
          'Queue addition cancelled',
        );
      }
      throw error;
    };
    const allocate = (media: QueueMedia[]) => {
      check();
      const commit = (firstId?: number) => {
        check();
        additions.delete(controller);
        if (pendingStart === controller) pendingStart = undefined;
        const result = commitAdd(
          media,
          opts,
          source,
          firstId,
          limit,
          replacedStart,
        );
        // The transition has acquired its own cancellation and demand now.
        reservation?.release();
        return result;
      };
      return deps.reserveQueueIds && media.length
        ? deps.reserveQueueIds(media.length).then(commit)
        : commit();
    };
    const prepared = (media: QueueMedia[]) => {
      check();
      checkSize(media.length, opts, limit);
      if (!prepare || !deps.prepareQueueMedia) return allocate(media);
      return (async () => {
        const batch: QueueMedia[] = [];
        for (const item of media) {
          batch.push(await deps.prepareQueueMedia!(item, controller.signal));
          check();
        }
        return allocate(batch);
      })();
    };
    const run = () => {
      check();
      const resolved = () => {
        check();
        const media = resolve(controller.signal, limit);
        return media instanceof Promise
          ? media.then(prepared)
          : prepared(media);
      };
      if (!deps.state) return resolved();
      return queueLimit().then((value) => {
        limit = value;
        return resolved();
      });
    };
    try {
      const result = additionTail ? additionTail.then(run) : run();
      if (!(result instanceof Promise)) {
        finish();
        return result;
      }
      const work = result.catch(failed).finally(finish);
      const settled = work.then(() => {}, () => {}).finally(() => {
        if (additionTail === settled) additionTail = undefined;
      });
      additionTail = settled;
      return work;
    } catch (error) {
      finish();
      return failed(error);
    }
  };
  // A terminal observation is retained until its transition commits or its
  // lease is revoked. Non-destructive commands may cancel activation preflight;
  // the engine tick then replans against the new queue instead of stranding it.
  const advanceFailedSource = (): Promise<void> => {
    if (failureWork && !failureWork.source.signal.aborted) {
      return failureWork.promise;
    }
    const source = failedSource;
    if (!source || !ownsSource(source)) {
      failedSource = null;
      return Promise.resolve();
    }
    const view = player.status();
    const plan = planSourceFailure(
      player.queue().items,
      view.current?.id,
      failedSources,
      view.repeat,
      view.consume,
    );
    const commit = (activate: () => void) => {
      if (
        !ownsSource(source) || player.status().generation !== view.generation
      ) return;
      failedSource = null;
      const result = player.advanceFailed(failedSources);
      activate();
      record('sourceSkip', undefined, {
        kind: 'internal',
        via: 'source-outcome',
      }, player.status().state);
      if (result === 'player+queue') flushQueue();
      else flushState();
      emit(result === 'player+queue' ? ['queue', 'player'] : ['player']);
    };
    const work = { source, promise: Promise.resolve() };
    failureWork = work;
    work.promise = (async () => {
      try {
        await transition(
          plan.index !== null,
          commit,
          {
            signal: source.signal,
            isCurrent: () => ownsSource(source),
          },
          plan.index === null ? undefined : {
            index: plan.index,
            items: plan.items,
            wrap: view.repeat === 'all',
            excluded: failedSources,
          },
        );
      } catch (error) {
        if (
          error instanceof PlaybackError && error.code === 'playback_cancelled'
        ) return;
        if (!ownsSource(source)) return;
        failedSource = null;
        log.event('source_exhausted', {
          entry: source.entryId,
          reason: 'activation-failed',
          attempts: recoveryForRun().attempts,
        });
        player.pause();
        record(
          'pause',
          undefined,
          { kind: 'internal', via: 'source-outcome' },
          'pause',
        );
        flushState();
        emit(['player']);
      } finally {
        if (failureWork === work) failureWork = undefined;
      }
    })();
    return work.promise;
  };
  const requireOpen = () => {
    if (closed || closing) {
      throw new PlaybackError('playback_cancelled', 'Player is closed');
    }
  };
  return {
    openSource: (entryId, generation) => {
      if (closed || closing) return null;
      if (needsCapacity() && !deps.capacity!.authority()()) return null;
      const source = player.openSource(entryId, generation);
      if (source) openedSource = source;
      return source;
    },
    cancelSource(source) {
      if (closed || closing) return;
      const version = player.queue().version;
      player.cancelSource(source);
      if (player.queue().version !== version) {
        flushQueue();
        emit(['queue', 'nowPlaying']);
      }
    },
    sourceAudio(source, durationMs) {
      if (player.sourceAudio(source, durationMs)) {
        recoveryForRun().audioMs += durationMs;
      }
    },
    async retrySource(source, reason) {
      if (
        !ownsSource(source) || player.status().current?.facts.kind !== 'web'
      ) return false;
      const run = recoveryForRun();
      const backoff =
        await deps.state?.getTyped('playback.source.retryBackoffMs') ??
          recoverySettings.retryBackoffMs.default;
      const reset = Number(
        await deps.state?.getTyped('playback.source.retryResetAudioMs') ??
          recoverySettings.retryResetAudioMs.default,
      );
      if (!ownsSource(source) || recovery !== run) return false;
      if (run.audioMs >= reset) {
        run.attempts = 0;
        failedSources.clear();
      }
      run.audioMs = 0;
      const delays = backoff as number[];
      if (run.attempts >= delays.length) {
        log.event('source_exhausted', {
          entry: source.entryId,
          reason,
          attempts: run.attempts,
        });
        return false;
      }
      const waitMs = delays[run.attempts++];
      log.event('source_retry', {
        entry: source.entryId,
        reason,
        attempt: run.attempts,
        waitMs,
      });
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          source.signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, waitMs);
        source.signal.addEventListener('abort', finish, { once: true });
        if (source.signal.aborted) finish();
      });
      return ownsSource(source) && recovery === run;
    },
    reportSourceMetadata(source, metadata) {
      if (closed || closing || !player.sourceMetadata(source, metadata)) {
        return false;
      }
      flushQueue();
      emit(['queue', 'nowPlaying']);
      return true;
    },
    reportSourceOutcome(source, outcome) {
      if (closed || !player.sourceOutcome(source, outcome)) return false;
      const view = player.status();
      if (
        outcome !== 'eof' || view.current?.facts.kind === 'web' &&
          view.current.facts.mode !== 'finite'
      ) {
        cancelStart();
        if (view.current?.facts.kind === 'web') {
          failedSources.add(view.current.id);
          failedSource = source;
          void advanceFailedSource();
          return true;
        }
        player.pause();
        record(
          'pause',
          undefined,
          { kind: 'internal', via: 'source-outcome' },
          'pause',
        );
        flushState();
        emit(['player']);
      }
      return true;
    },
    expireReports: reports.expireReports,
    startReportExpiry: reports.startReportExpiry,
    reportPlaying: reports.reportPlaying,
    reportStopped: reports.reportStopped,
    reportPlayback: reports.reportPlayback,
    reportSessionPlayback: reports.reportSessionPlayback,

    play(source, authority) {
      const view = player.status();
      const index = view.current
        ? player.queue().items.findIndex((e) => e.id === view.current!.id)
        : 0;
      return transition(
        player.queue().items.length > 0,
        (activate) => {
          player.play();
          activate();
          record('play', undefined, source, 'play');
          flushState();
          emit(['player']);
        },
        authority,
        view.state === 'play' ? undefined : { index },
      );
    },
    pause(source) {
      requireOpen();
      cancelStart();
      player.pause();
      record('pause', undefined, source, 'pause');
      flushState();
      emit(['player']);
    },
    stop(source) {
      requireOpen();
      cancelStart();
      // Explicit stop releases transport intent, not the bookmark. Engine stop
      // remains the terminal operation for exhaustion and end-of-queue.
      player.pause();
      record('stop', undefined, source, 'stop');
      flushState();
      emit(['player']);
    },
    toggle(source) {
      const view = player.status();
      const index = view.current
        ? player.queue().items.findIndex((e) => e.id === view.current!.id)
        : 0;
      return transition(
        player.status().state !== 'play' && player.queue().items.length > 0,
        (activate) => {
          player.toggle();
          activate();
          record('toggle', undefined, source, player.status().state);
          flushState();
          emit(['player']);
        },
        undefined,
        { index },
      );
    },
    next(source) {
      const queue = player.queue().items;
      const current = player.status().current;
      const next = current
        ? queue.findIndex((row) => row.id === current.id) + 1
        : 0;
      return transition(
        next < queue.length,
        (activate) => {
          player.next();
          activate();
          record('next', undefined, source, player.status().state);
          flushState();
          emit(['player']);
        },
        undefined,
        { index: next },
      );
    },
    previous(source) {
      const view = player.status();
      const index = Math.max(
        0,
        player.queue().items.findIndex((e) => e.id === view.current?.id) - 1,
      );
      return transition(
        player.queue().items.length > 0,
        (activate) => {
          player.previous();
          activate();
          record('previous', undefined, source, player.status().state);
          flushState();
          emit(['player']);
        },
        undefined,
        { index, direction: -1 },
      );
    },
    restart(source) {
      requireOpen();
      const view = player.status();
      if (!view.current) return;
      const index = player.queue().items.findIndex((e) =>
        e.id === view.current!.id
      );
      return transition(
        view.state === 'play',
        (activate) => {
          player.restart();
          activate();
          record('restart', undefined, source, player.status().state);
          flushState();
          emit(['player']);
        },
        undefined,
        { index },
      );
    },
    setShuffle(on, source) {
      requireOpen();
      cancelStart();
      player.setShuffle(on);
      record('shuffle', `shuffle=${on}`, source, 'none', false, {
        shuffle: on,
      });
      flushState();
      emit(['options']);
    },
    setConsume(on, source) {
      requireOpen();
      cancelStart();
      player.setConsume(on);
      record('consume', `consume=${on}`, source, 'none', false, {
        consume: on,
      });
      flushState();
      emit(['options']);
    },
    setRepeat(mode, source) {
      requireOpen();
      cancelStart();
      player.setRepeat(mode);
      record('repeat', `repeat=${mode}`, source, 'none', false, {
        repeat: mode,
      });
      flushState();
      emit(['options']);
    },
    setVolume(opts, source) {
      requireOpen();
      if (opts.volume === undefined && opts.step === undefined) return;
      player.setVolume(opts);
      record(
        'volume',
        opts.volume !== undefined
          ? `volume=${opts.volume}`
          : `step=${opts.step}`,
        source,
        'none',
        false,
        {
          volume: opts.volume,
          step: opts.volume === undefined ? opts.step : undefined,
        },
      );
      emit(['volume']);
    },
    seek(opts, source) {
      requireOpen();
      const view = player.status();
      const entry = view.current ?? player.queue().items[0];
      // A non-seekable source is a true no-op, including while paused/stopped:
      // no target preparation, intent change, source reopen or notification.
      if (entry && !queueCapabilities(entry).seekable) return true;
      const index = view.current
        ? player.queue().items.findIndex((e) => e.id === view.current!.id)
        : 0;
      return transition(
        player.queue().items.length > 0,
        (activate) => {
          const ok = player.seek(opts);
          activate();
          if (ok) {
            record(
              'seek',
              opts.positionMs !== undefined
                ? `position_ms=${Math.trunc(opts.positionMs)}`
                : `seek_ms=${opts.seekMs ?? 0}`,
              source,
              'play',
              false,
              {
                position_ms: opts.positionMs === undefined
                  ? undefined
                  : Math.trunc(opts.positionMs),
                seek_ms: opts.positionMs === undefined
                  ? opts.seekMs ?? 0
                  : undefined,
              },
            );
            flushState();
            emit(['player']);
          }
          return ok;
        },
        undefined,
        view.state === 'stop' ? { index } : undefined,
      );
    },
    queueAdd(songs, opts = {}, source) {
      return add(() => songs.map(catalogMedia), opts, source, !!deps.state);
    },
    queueAddSources(media, opts, source) {
      return add(
        () => media,
        opts,
        source,
        !!deps.state || media.some((item) => item.facts.kind === 'web'),
      );
    },
    async queueAddReferences(references, opts, source) {
      return await add(
        async (signal, limit) => {
          const media: QueueMedia[] = [];
          for (const input of references) {
            const expanded = deps.expandQueueReference
              ? await deps.expandQueueReference(input, source?.user, limit)
              : input.kind === 'song' || input.kind === 'station' ||
                  input.kind === 'url'
              ? [input]
              : [];
            if (!expanded.length && !deps.expandQueueReference) {
              throw new PlaybackError('missing_reference', 'Media not found');
            }
            checkSize(media.length + expanded.length, opts ?? {}, limit);
            for (const reference of expanded) {
              if (reference.kind === 'url') {
                let url: URL;
                try {
                  url = new URL(reference.url);
                } catch {
                  throw new PlaybackError(
                    'invalid_reference',
                    'Invalid media URL',
                  );
                }
                if (
                  !['http:', 'https:'].includes(url.protocol) || url.username ||
                  url.password
                ) {
                  throw new PlaybackError(
                    'invalid_reference',
                    'Invalid media URL',
                  );
                }
              }
              const item = await resolveReference(reference);
              signal.throwIfAborted();
              if (!item) {
                throw new PlaybackError(
                  'missing_reference',
                  'Media not found',
                );
              }
              media.push(item);
            }
          }
          return media;
        },
        opts,
        source,
        true,
      );
    },
    queueRemove(entryId, expectedVersion, source) {
      requireOpen();
      checkVersion(expectedVersion);
      const index = requireEntry(entryId);
      const view = player.status();
      const current = view.current?.id === entryId;
      const future = player.queue().items.filter((entry) =>
        entry.id !== entryId
      );
      return transition(
        current && view.state === 'play' && index < future.length,
        (activate) => {
          // Preparation may await receiver/source facts; the observed revision
          // is checked again at the actual mutation, before any state changes.
          checkVersion(expectedVersion);
          requireEntry(entryId);
          player.queueRemove(entryId);
          activate();
          record(
            'queueRemove',
            `entryId=${entryId}`,
            source,
            current ? player.status().state : 'none',
            false,
            { entryId },
          );
          flushQueue();
          emit(current ? ['queue', 'player'] : ['queue']);
        },
        undefined,
        { index, items: future },
      );
    },
    queueMove(entryId, position, expectedVersion, source) {
      requireOpen();
      checkVersion(expectedVersion);
      requireEntry(entryId);
      cancelStart();
      player.queueMove(entryId, position);
      record(
        'queueMove',
        `entryId=${entryId} position=${position}`,
        source,
        'none',
        false,
        { entryId, position },
      );
      flushQueue();
      emit(['queue']);
    },
    queueClear(source, expectedVersion) {
      requireOpen();
      checkVersion(expectedVersion);
      cancelStart();
      cancelAdditions();
      player.queueClear();
      record('queueClear', undefined, source, 'stop', true);
      flushQueue();
      // The clear also stopped the engine — both reads changed.
      emit(['queue', 'player']);
    },

    queueCopyView() {
      const view = player.status();
      const items = player.queue().items;
      return structuredClone({
        items: items.map((entry) => {
          const { id: _id, ...media } = entry;
          return media;
        }),
        currentIndex: view.current
          ? items.findIndex((entry) => entry.id === view.current!.id)
          : null,
        positionMs: view.itemProgressMs,
        repeat: view.repeat,
        consume: view.consume,
      });
    },
    queueCopied(targetId, source) {
      requireOpen();
      record('queueCopy', `targetId=${targetId}`, source);
      flushState();
      emit(['player']);
    },
    async queueImport(snapshot, opts, source, publish) {
      requireOpen();
      checkVersion(opts.expectedVersion);
      cancelStart();
      const controller = new AbortController();
      const replace = opts.mode === 'replace';
      const starts = snapshot.items.length > 0 &&
        (opts.startPlaying === true ||
          replace && player.status().state === 'play');
      const reservation = reserveStart(starts, controller);
      pendingStart = controller;
      try {
        const limit = await queueLimit();
        controller.signal.throwIfAborted();
        checkSize(snapshot.items.length, { clear: replace }, limit);
        const firstId = snapshot.items.length && deps.reserveQueueIds
          ? await deps.reserveQueueIds(snapshot.items.length)
          : undefined;
        controller.signal.throwIfAborted();
        if (pendingStart !== controller) controller.abort();
        controller.signal.throwIfAborted();
        checkVersion(opts.expectedVersion);
        const previous = player.status();
        const future = replace ? [] : player.queue().items;
        const currentIndex = future.findIndex((entry) =>
          entry.id === previous.current?.id
        );
        const position = opts.where === 'next'
          ? currentIndex + 1
          : typeof opts.where === 'object'
          ? opts.where.position
          : future.length;
        const at = Math.min(Math.max(0, Math.trunc(position)), future.length);
        const items = [
          ...future.slice(0, at),
          ...snapshot.items,
          ...future.slice(at),
        ];
        const index = replace ? snapshot.currentIndex ?? 0 : at;
        pendingStart = undefined;
        const work = transition(
          starts,
          (activate) => {
            checkVersion(opts.expectedVersion);
            checkSize(snapshot.items.length, { clear: replace }, limit);
            return publish(() => {
              if (replace) player.queueClear();
              const added = snapshot.items.length
                ? player.queueAddSources(snapshot.items, at, firstId)
                : [];
              if (replace) {
                player.restore({
                  queue: added,
                  version: player.queue().version,
                  currentIndex: snapshot.currentIndex ?? (starts ? 0 : null),
                  positionMs: snapshot.positionMs,
                  state: starts
                    ? 'play'
                    : snapshot.currentIndex === null
                    ? 'stop'
                    : 'pause',
                  repeat: snapshot.repeat,
                  consume: snapshot.consume,
                  shuffle: previous.shuffle,
                });
              } else if (opts.startPlaying && added.length) player.play(at);
              activate();
              record(
                'queueCopy',
                `mode=${opts.mode}`,
                source,
                replace || opts.startPlaying ? player.status().state : 'none',
                replace,
              );
              flushQueue();
              emit(
                replace
                  ? ['queue', 'player', 'options']
                  : opts.startPlaying
                  ? ['queue', 'player']
                  : ['queue'],
              );
            });
          },
          undefined,
          { index, items },
        );
        reservation?.release();
        await work;
      } catch (error) {
        if (controller.signal.aborted) {
          throw new PlaybackError('playback_cancelled', 'Queue copy cancelled');
        }
        throw error;
      } finally {
        reservation?.release();
        if (pendingStart === controller) pendingStart = undefined;
      }
    },

    advanceEnded() {
      if (closed || closing) return;
      if (failedSource) {
        if (!pendingStart) return advanceFailedSource();
        return;
      }
      const view = player.status();
      if (pendingStart || !player.canAdvanceEnded()) return;
      const items = player.queue().items;
      const current = items.findIndex((e) => e.id === view.current?.id);
      const index = view.repeat === 'single'
        ? current
        : view.repeat === 'all'
        ? (current + 1) % items.length
        : view.consume
        ? current
        : current + 1;
      const future = view.consume && view.repeat === 'off'
        ? items.filter((_, i) => i !== current)
        : items;
      const commit = (activate: () => void) => {
        if (player.status().generation !== view.generation) return;
        const result = player.advanceEnded();
        if (result === 'none') return;
        failedSources.clear();
        activate();
        if (result === 'player+queue') flushQueue();
        else flushState();
        emit(result === 'player+queue' ? ['queue', 'player'] : ['player']);
      };
      return Promise.resolve(
        transition(true, commit, undefined, {
          index,
          items: future,
          wrap: view.repeat !== 'off',
        }),
      ).catch((error) => {
        // Internal transitions have no HTTP caller. Keep the bookmark/queue and
        // publish a paused clock; an explicit newer command always wins.
        if (
          error instanceof PlaybackError && error.code === 'playback_cancelled'
        ) return;
        if (player.status().state === 'play' && !pendingStart) {
          player.pause();
          record('pause', undefined, {
            kind: 'internal',
            via: 'playback-target-loss',
          }, 'pause');
          flushState();
          emit(['player']);
        }
      });
    },

    restore(snapshot) {
      requireOpen();
      cancelAdditions();
      const index = snapshot.currentIndex ?? 0;
      const candidate = snapshot.queue[index];
      const prepareUrl = deps.prepareQueueMedia &&
        candidate?.facts.kind === 'web' && candidate.facts.mode === 'unknown';
      const commit = (restored = snapshot) => {
        player.restore(restored);
        record(
          'restore',
          undefined,
          { kind: 'internal', via: 'restore' },
          restored.state,
        );
        serverPresent = hasServerRow();
        announcedCommander = commander;
        announcedQueueVersion = player.queue().version;
        if (restored.queueChanged) flushQueue();
      };
      if (
        snapshot.state !== 'play' || !snapshot.queue.length ||
        !deps.targets && !prepareUrl && !needsCapacity()
      ) {
        cancelStart();
        return commit();
      }
      return (async () => {
        await transition(
          true,
          (activate) => {
            commit();
            activate();
          },
          undefined,
          { index, items: snapshot.queue },
        );
      })().catch(
        (error) => {
          if (
            error instanceof PlaybackError &&
              error.code === 'target_unavailable' ||
            error instanceof PlaybackError && error.code === 'no_target'
          ) commit({ ...snapshot, state: 'pause' });
          else if (prepareUrl && !(error instanceof PlaybackError)) {
            log.event('media_failed', {
              operation: 'prepare-restored-source',
              path: String(candidate.id),
              error,
            });
            commit({ ...snapshot, state: 'pause' });
          } else throw error;
        },
      );
    },

    checkpoint: flushState,
    playerView: () => player.status(),
    queueView: () => player.queue(),
    queuePageView: ({ view, offset, limit }) => {
      const { version, items } = player.queue();
      const currentEntryId = player.status().current?.id ?? null;
      const currentIndex = currentEntryId === null
        ? 0
        : items.findIndex((entry) => entry.id === currentEntryId);
      const startIndex = view === 'all' ? 0 : Math.max(0, currentIndex);
      return {
        version,
        currentEntryId,
        startIndex,
        total: items.length - startIndex,
        items: items.slice(startIndex + offset, startIndex + offset + limit),
      };
    },
    lastCommand: () => last,

    serverNowPlayingView,
    nowPlayingView: reports.nowPlayingView,

    async close() {
      cancelStart();
      cancelAdditions();
      activeReservation?.release();
      activeReservation = undefined;
      // Revoke a parked source even if its boot is being closed separately.
      if (openedSource) player.cancelSource(openedSource);
      closing = true;
      unsubscribeOutputs?.();
      if (tick !== null) clearInterval(tick);
      if (deps.reports === undefined) await reports.close();
      closed = true;
      await failureWork?.promise;
    },
  };
}
