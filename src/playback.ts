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
import { createOperationScope } from './operations.ts';
import {
  createSourcePlanOwner,
  type SourcePreparation,
} from './playback-source-plan.ts';
import { type CommandHandle, createCommandLane } from './command-authority.ts';
import { crossfadeFrames, validateCrossfadeMs } from './playback-mix.ts';
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
  planPlaybackSuccessor,
  reconcilePlaybackSuccessor,
  type SuccessorPlan,
} from './playback-successor.ts';
import {
  createPlaybackTimeline,
  type TimelineCompletion,
  type TimelineCutoff,
  type TimelineProgress,
  type TimelineSource,
} from './playback-timeline.ts';
import {
  catalogMedia,
  createQueueResolver,
  type QueueAddReference,
  queueCapabilities,
  queueDuration,
  type QueueMedia,
  type QueueReference,
  type SourceMetadata,
} from './queue-source.ts';
import type {
  AdvanceResult,
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

/** Injected sink control. Admission fences input synchronously; its immutable
 * source projection may settle after intent publication, never from a JS clock. */
export interface PlaybackSink {
  /** Fence future accepted input and join readiness; cutoff is immutable and
   * may arrive earlier. This is a deliberate reanchor, not pause intent. */
  reanchor?(
    source: TimelineSource,
    commit: (cutoff: TimelineCutoff) => void,
  ): Promise<void> | null;
  cutoff(
    source: TimelineSource,
    intent: 'pause' | 'stop',
    commit: (cutoff: TimelineCutoff) => void,
  ): Promise<void> | null;
}

export interface PlaybackRead {
  readonly source: PlaybackSource;
  readonly entry: QueueEntry;
}

type PlannedOccurrence =
  | { kind: 'existing'; entryId: number; media: QueueMedia }
  | { kind: 'new'; offset: number; media: QueueMedia };
interface ActivationPlan {
  entry: PlannedOccurrence | undefined;
  items: PlannedOccurrence[];
  direction?: number;
  successor?: SuccessorPlan;
}
const existingOccurrences = (
  entries: readonly QueueEntry[],
): PlannedOccurrence[] =>
  entries.map(({ id, ...media }) => ({ kind: 'existing', entryId: id, media }));
const newOccurrences = (media: QueueMedia[]): PlannedOccurrence[] =>
  media.map((item, offset) => ({ kind: 'new', offset, media: item }));
const existingActivation = (
  entries: readonly QueueEntry[],
  index: number,
  options: Pick<ActivationPlan, 'direction'> = {},
): ActivationPlan => {
  const items = existingOccurrences(entries);
  return { entry: items[index], items, ...options };
};
const successorActivation = (plan: SuccessorPlan): ActivationPlan => ({
  ...existingActivation(
    plan.items,
    plan.items.findIndex((item) => item.id === plan.entryId),
  ),
  successor: plan,
});
type Activate = (added?: QueueEntry[]) => AdvanceResult | void;
type PrepareNew = (media: QueueMedia[]) => QueueMedia[];

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
  setShuffle(on: boolean, source?: CommandSource): void | Promise<void>;
  setConsume(on: boolean, source?: CommandSource): void | Promise<void>;
  setRepeat(mode: RepeatMode, source?: CommandSource): void | Promise<void>;
  setCrossfade(ms: number, source?: CommandSource): void | Promise<void>;
  /** Pure validation for adapters that must validate a complete body first. */
  validateCrossfade(ms: unknown): number;
  setVolume(
    opts: { volume?: number; step?: number },
    source?: CommandSource,
  ): void | Promise<void>;
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
  ): void | Promise<void>;
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
  /** Core-owned stream source lifetime; transitions synchronously revoke it. */
  attachSink(sink?: PlaybackSink): () => void;
  openSource(entryId: number, generation: number): PlaybackSource | null;
  /** Resolve the next ordered read without changing public current. */
  prepareNextSource(
    after: PlaybackSource,
  ): PlaybackRead | null | Promise<PlaybackRead | null>;
  admitSource(read: PlaybackRead): boolean;
  sourceAccepted(source: PlaybackSource, frames: bigint): boolean;
  /** Bind an admitted incoming head before its overlap mix enters native input.
   * Its source then counts as future input for edit reconciliation. */
  overlapSource(source: PlaybackSource, frames: bigint): boolean;
  /** Reserve possible native input before an async append; settle after its receipt. */
  beginSourceInput(source: PlaybackSource): (() => void) | null;
  reviseSourceCompletion(
    source: PlaybackSource,
    receipt: TimelineCompletion,
  ): readonly bigint[] | null;
  /** Reader has established final exhaustion, separately from decoder EOF. */
  finishSources(after: PlaybackSource): boolean;
  /** Core read/preparation and scheduled-playing incarnations, never hat state. */
  sourcePlanView(): {
    reading: PlaybackSource | null;
    playing: PlaybackSource | null;
  };
  bindSource(
    source: PlaybackSource,
    streamId: bigint,
    epoch: bigint,
  ): TimelineSource | null;
  sealSource(source: PlaybackSource, target: bigint): boolean;
  sourceProgress(source: PlaybackSource, progress: TimelineProgress): boolean;
  sourceCompatibilityRemaining(source: PlaybackSource): number;
  /** Resolves after this source's matching core transition/cancellation commits,
   * not when the receipt is first observed. The boot can then acknowledge it. */
  completeSource(
    source: PlaybackSource,
    receipt: TimelineCompletion,
  ): Promise<boolean>;
  cancelSource(source: PlaybackSource): void;
  sourceAudio(source: PlaybackSource, durationMs: number): void;
  /** One bounded source retry, cancelled with the lease. Not a speaker retry. */
  retrySource(
    source: PlaybackSource,
    reason: SourceOutcome,
    signal?: AbortSignal,
  ): Promise<boolean>;
  reportSourceOutcome(source: PlaybackSource, outcome: SourceOutcome): boolean;
  /** Raw facts from the current source lease; no commands or hat labels. */
  reportSourceMetadata(
    source: PlaybackSource,
    metadata: SourceMetadata,
    sourceFrame?: bigint,
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
  outputs?: Pick<Outputs, 'list' | 'update'>;
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
  const operations = createOperationScope('Player');
  const timeline = createPlaybackTimeline();
  const timelineSources = new WeakMap<PlaybackSource, TimelineSource>();
  const reads = new WeakMap<PlaybackRead, SourcePreparation>();
  const futureOutcomes = new WeakMap<PlaybackSource, SourceOutcome>();
  let continuous = false;
  let continuousGeneration = -1;
  let inputEnded: PlaybackSource | null = null;
  let reanchoring: {
    generation: number;
    position: Promise<number>;
    ready: Promise<void>;
  } | undefined;
  const sinks = new Set<PlaybackSink>();
  let cutting: TimelineSource | undefined;
  let bookmark: { generation: number; position: Promise<number> } | undefined;
  let closeWork: Promise<void> | undefined;
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
  const sourceRecovery = new WeakMap<PlaybackSource, typeof recovery>();
  const failedSources = new Set<number>();
  const recoveryForRun = () => {
    const generation = player.status().generation;
    if (recovery.generation !== generation) {
      recovery = sourcePlans.playing && player.hasSource(sourcePlans.playing) &&
          sourceRecovery.get(sourcePlans.playing) ||
        { generation, attempts: 0, audioMs: 0 };
      recovery.generation = generation;
    }
    return recovery;
  };
  const recoveryForSource = (source: PlaybackSource) => {
    let run = sourceRecovery.get(source);
    if (!run) {
      run = source === sourcePlans.playing
        ? recoveryForRun()
        : { generation: source.generation, attempts: 0, audioMs: 0 };
      sourceRecovery.set(source, run);
    }
    return run;
  };
  const ownsSource = (source: PlaybackSource) =>
    !operations.closed && player.hasSource(source) &&
    (sourcePlans.playing === source ||
      sourcePlans.admitted.some((record) => record.source === source));
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
      playbackRate: status.playbackRate,
    };
  };
  let serverPresent = hasServerRow();
  let announcedCommander: string | null = commander;
  let announcedQueueVersion = player.queue().version;
  // Engine events keep their existing vocabulary. The aggregate additionally
  // changes on clock/current transitions and on external attribution changes,
  // including commands (volume/options/queue edits) without a player event.
  const emit = (types: string[]) => {
    reconcileFuture();
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
  const commands = createCommandLane();
  const successorPlan = (
    reason: SuccessorPlan['reason'],
    after?: PlaybackSource,
  ): SuccessorPlan | null => {
    const view = player.status(), queue = player.queue();
    let items = queue.items, currentEntryId = view.current?.id;
    if (after && after !== sourcePlans.playing) {
      let found = false;
      for (const record of sourcePlans.admitted) {
        const current = planPlaybackSuccessor({
          reason: 'natural',
          revision: queue.version,
          items,
          currentEntryId,
          repeat: view.repeat,
          consume: view.consume,
        });
        const plan = reconcilePlaybackSuccessor(
          record.plan,
          current,
          record.through,
        );
        if (!plan || !record.source || record.source.signal.aborted) {
          return null;
        }
        items = [...plan.items];
        currentEntryId = record.source.entryId;
        if (record.source === after) {
          found = true;
          break;
        }
      }
      if (!found) return null;
    }
    return planPlaybackSuccessor({
      reason,
      revision: queue.version,
      items,
      currentEntryId,
      repeat: view.repeat,
      consume: view.consume,
      failed: failedSources,
    });
  };
  const needsPreparation = (item: QueueMedia) =>
    deps.prepareQueueMedia && item.facts.kind === 'web' &&
    item.facts.mode === 'unknown';
  const sourcePlans = createSourcePlanOwner({
    player,
    current: successorPlan,
    afterCurrent: successorPlan,
    resolve(item, signal) {
      const resolved = (media: QueueMedia | null) => {
        signal.throwIfAborted();
        return media && needsPreparation(media)
          ? deps.prepareQueueMedia!(media, signal)
          : media;
      };
      const media =
        item.reference.kind === 'station' && deps.resolveQueueReference
          ? deps.resolveQueueReference(item.reference)
          : item;
      return media instanceof Promise ? media.then(resolved) : resolved(media);
    },
  });
  let pendingStart: CommandHandle | undefined;
  const submitCommand = () => {
    pendingStart = undefined;
    return commands.submit();
  };
  const cancelStart = (expected = commands.capture()) => {
    expected?.cancel();
    if (pendingStart === expected) pendingStart = undefined;
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
    commit: (activate: Activate, prepareNew: PrepareNew) => T,
    authority?: PlaybackAuthority,
    activation?: ActivationPlan,
    submitted?: CommandHandle,
  ): T | Promise<T> =>
    operations.runImmediate((operation) => {
      const externalCurrent = () =>
        !operations.closed &&
        (!authority || !authority.signal.aborted && authority.isCurrent());
      const cancelled = () =>
        new PlaybackError('playback_cancelled', 'Playback start cancelled');
      if (!externalCurrent()) throw cancelled();
      const command = submitted ?? submitCommand();
      const current = () => externalCurrent() && command.isCurrent();
      if (!current()) throw cancelled();
      const before = player.queue().items;
      const items = activation?.items ?? [];
      const candidate = activation?.entry;
      const needsResolution = starts && activation && candidate &&
        (deps.resolveQueueReference &&
            candidate.media.reference.kind === 'station' ||
          needsPreparation(candidate.media));
      const pendingBookmark =
        bookmark?.generation === player.status().generation
          ? bookmark.position
          : undefined;
      if (activation?.successor) {
        const generation = player.status().generation;
        const controller = new AbortController();
        const reservation = reserveStart(starts, controller);
        const abort = () => controller.abort();
        operation.signal.addEventListener('abort', abort, { once: true });
        authority?.signal.addEventListener('abort', abort, { once: true });
        command.signal.addEventListener('abort', abort, { once: true });
        pendingStart = command;
        const authoritative = () =>
          current() && !controller.signal.aborted &&
          player.status().generation === generation;
        const finish = () => {
          reservation?.release();
          operation.signal.removeEventListener('abort', abort);
          authority?.signal.removeEventListener('abort', abort);
          command.signal.removeEventListener('abort', abort);
          if (pendingStart === command) pendingStart = undefined;
        };
        const prepare = (plan: SuccessorPlan): T | Promise<T> => {
          if (!authoritative()) throw cancelled();
          const record = sourcePlans.prepare(plan, command);
          const retry = (): T | Promise<T> => {
            if (!authoritative()) throw cancelled();
            return prepare(successorPlan(plan.reason)!);
          };
          const publish = (
            selected: Awaited<SourcePreparation['ready']>,
          ): T | Promise<T> => {
            if (!authoritative()) throw cancelled();
            if (!sourcePlans.validate(record)) return retry();
            const entryId = selected?.source.entryId ?? null;
            return commitStart(reservation, () =>
              commit(() => {
                let result: AdvanceResult = 'none';
                sourcePlans.commit(record, (current) => {
                  result = player.applySuccessor(
                    current,
                    entryId,
                    sourcePlans.playing && !sourcePlans.playing.signal.aborted
                      ? record.source ?? undefined
                      : undefined,
                  );
                  if (result !== 'none' && selected?.refreshed) {
                    player.replaceOccurrence(entryId!, selected.media);
                  }
                  return result !== 'none';
                });
                return result;
              }, (media) => media));
          };
          const prepared = (selected: Awaited<SourcePreparation['ready']>) => {
            // Even exhaustion retains the existing natural target preflight.
            // An append can create a destination while this boundary is held.
            const targets = starts
              ? deps.targets?.preparePlayback(controller.signal)
              : undefined;
            return targets instanceof Promise
              ? targets.then(() => publish(selected))
              : publish(selected);
          };
          const failed = (error: unknown): T | Promise<T> => {
            if (!authoritative()) throw cancelled();
            if (!sourcePlans.validate(record)) return retry();
            throw error;
          };
          const ready = record.ready;
          return ready instanceof Promise
            ? ready.then(prepared, failed)
            : prepared(ready);
        };
        try {
          const result = pendingBookmark
            ? pendingBookmark.then(() => prepare(activation.successor!))
            : prepare(activation.successor);
          if (result instanceof Promise) return result.finally(finish);
          finish();
          return result;
        } catch (error) {
          finish();
          throw error;
        }
      }
      if (
        (!starts || !deps.targets && !needsResolution) && !pendingBookmark
      ) {
        const reservation = reserveStart(starts);
        try {
          return commitStart(
            reservation,
            () =>
              commit(
                () => undefined,
                (media) => media,
              ),
          );
        } finally {
          reservation?.release();
        }
      }
      const controller = new AbortController();
      const reservation = reserveStart(starts, controller);
      const abort = () => controller.abort();
      operation.signal.addEventListener('abort', abort, { once: true });
      authority?.signal.addEventListener('abort', abort, { once: true });
      command.signal.addEventListener('abort', abort, { once: true });
      pendingStart = command;
      const prepare = async () => {
        await pendingBookmark;
        if (!current() || controller.signal.aborted) throw cancelled();
        let selected:
          | { occurrence: PlannedOccurrence; media: QueueMedia }
          | null
          | undefined;
        if (needsResolution) {
          selected = null;
          let index = items.indexOf(candidate);
          for (
            let visited = 0;
            visited < items.length;
            visited++
          ) {
            if (index < 0 || index >= items.length) break;
            const item = items[index];
            let media = item.media.reference.kind === 'station' &&
                deps.resolveQueueReference
              ? await deps.resolveQueueReference!(item.media.reference)
              : item.media;
            if (media && needsPreparation(media)) {
              media = await deps.prepareQueueMedia!(media, controller.signal);
            }
            if (controller.signal.aborted) throw cancelled();
            if (media) {
              selected = { occurrence: item, media };
              break;
            }
            index += activation.direction ?? 1;
          }
        }
        if (starts && selected !== null) {
          await deps.targets?.preparePlayback(controller.signal);
        }
        return selected;
      };
      return prepare().then((selected) => {
        if (
          controller.signal.aborted || !current()
        ) throw cancelled();
        // A preparation plan refers to occurrences, not reusable ordinals. Queue
        // additions may publish during this await without cancelling the start.
        // Validate the original anchor before the command mutates anything; future
        // queues (consume/add/restore) are installed synchronously by commit.
        const planned = selected?.occurrence ?? candidate;
        const entryId = planned?.kind === 'existing'
          ? planned.entryId
          : undefined;
        const originalIndex = before.findIndex((entry) => entry.id === entryId);
        if (
          originalIndex >= 0 &&
          player.queue().items[originalIndex]?.id !== entryId
        ) {
          throw cancelled();
        }
        const result = commitStart(reservation, () =>
          commit((added) => {
            if (selected === undefined) return;
            if (selected === null) {
              player.stop();
              return;
            }
            const occurrence = selected.occurrence;
            // Existing identities were validated before commit. New media was
            // prepared before insertion and receives its id only at publication.
            if (occurrence.kind === 'existing') {
              player.replaceOccurrence(occurrence.entryId, selected.media);
            }
            if (occurrence !== candidate) {
              const id = occurrence.kind === 'existing'
                ? occurrence.entryId
                : added![occurrence.offset].id;
              player.playOccurrence(id);
            }
          }, (media) => {
            const occurrence = selected?.occurrence;
            return occurrence?.kind === 'new'
              ? media.map((item, offset) =>
                offset === occurrence.offset ? selected!.media : item
              )
              : media;
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
        command.signal.removeEventListener('abort', abort);
        operation.signal.removeEventListener('abort', abort);
        if (pendingStart === command) pendingStart = undefined;
      });
    });
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
        pauseAtCutoff();
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
  const bookmarkPosition = () =>
    bookmark?.generation === player.status().generation
      ? bookmark.position
      : undefined;
  const flushQueue = () => (reconcileFuture(),
    persistence?.saveQueue(
      player.queueSnapshot(),
      stateSnapshot(),
      bookmarkPosition(),
    ));
  const flushState =
    () => (reconcileFuture(),
      persistence?.saveState(stateSnapshot(), bookmarkPosition()));
  // All explicit and induced pauses share the same capture. The engine publishes
  // intent immediately; saves capture this command's immutable position receipt
  // in their existing ordered batch, including membership publications.
  const pauseAtCutoff = (intent: 'pause' | 'stop' = 'pause') => {
    const view = player.status();
    const source = sourcePlans.playing;
    const mapping = source ? timelineSources.get(source) : undefined;
    let cutoff: Promise<void> | null = null;
    let generation = view.generation;
    let positionMs = view.itemProgressMs;
    if (view.state === 'play' && mapping) {
      for (const sink of sinks) {
        cutoff = sink.cutoff(mapping, intent, (result) => {
          if (!timeline.cancel(mapping, result)) {
            throw new Error('Native source cutoff did not match its bookmark');
          }
          positionMs = timeline.position(mapping)!.positionMs;
          player.freezePosition(generation, positionMs);
          timeline.retire(mapping);
        });
        if (cutoff) break;
      }
    }
    cutting = cutoff ? mapping : undefined;
    player.pause();
    cutting = undefined;
    if (!cutoff || !mapping) return;
    generation = player.status().generation;
    const position = operations.run(async () => {
      try {
        await cutoff;
      } catch (error) {
        log.event('media_failed', {
          operation: 'source-cutoff',
          path: String(mapping.entryId),
          error,
        });
      } finally {
        timeline.retire(mapping);
      }
      return positionMs;
    });
    bookmark = { generation, position };
    void position.catch((error) =>
      log.event('media_failed', {
        operation: 'source-cutoff',
        path: String(mapping.entryId),
        error,
      })
    );
  };
  const reconcileFuture = () => {
    const lostReader = sourcePlans.playing?.signal.aborted === true;
    if (
      lostReader &&
      (!continuous || player.status().generation !== continuousGeneration)
    ) {
      sourcePlans.discardFuture();
      continuous = false;
      inputEnded = null;
      return;
    }
    const invalid = lostReader ? 0 : sourcePlans.reconcile();
    if (invalid < 0) return;
    const discarded = sourcePlans.admitted.slice(invalid);
    const accepted = discarded.some((record) => {
      const mapping = record.source && timelineSources.get(record.source);
      return mapping && timeline.hasInput(mapping);
    });
    if (!accepted) {
      sourcePlans.discardFuture(invalid);
      inputEnded = null;
      return;
    }
    const primary = sourcePlans.playing;
    const mapping = primary && timelineSources.get(primary);
    const view = player.status();
    if (!primary || !mapping || view.state !== 'play') return;
    if (reanchoring) return;
    const position = Promise.withResolvers<number>();
    const ready = Promise.withResolvers<void>();
    const work = {
      generation: view.generation,
      position: position.promise,
      ready: ready.promise,
    };
    reanchoring = work;
    bookmark = { generation: view.generation, position: work.position };
    let captured = false;
    let replacementGeneration: number | undefined;
    let pending: Promise<void> | null = null;
    const capture = (cutoff: TimelineCutoff) => {
      if (captured) throw new Error('Duplicate future-input cutoff');
      captured = true;
      // A newer explicit command may already have retired this old mapping.
      // Its native fence is still joined, but cannot replace the newer intent.
      if (timeline.position(mapping)) {
        if (!timeline.cancel(mapping, cutoff)) {
          throw new Error('Invalid future-input cutoff');
        }
        const value = timeline.position(mapping)!.positionMs;
        if (player.reanchorSource(view.generation, primary.entryId, value)) {
          replacementGeneration = player.status().generation;
          if (bookmark?.position === work.position) {
            bookmark = undefined;
          }
        }
        position.resolve(value);
        timeline.retire(mapping);
      } else position.resolve(view.itemProgressMs);
    };
    try {
      for (const sink of sinks) {
        pending = sink.reanchor?.(mapping, capture) ?? null;
        if (pending) break;
      }
      if (!pending) {
        throw new Error('Accepted future input has no reanchor owner');
      }
    } catch (error) {
      pending = Promise.reject(error);
    }
    sourcePlans.discardFuture();
    player.cancelSource(primary);
    continuous = false;
    inputEnded = null;
    void operations.run(async () => {
      try {
        await pending;
        if (!captured) {
          throw new Error('Future-input reset had no atomic cutoff');
        }
        if (replacementGeneration === player.status().generation) {
          flushState();
          emit(['player']);
        }
      } catch (error) {
        position.resolve(view.itemProgressMs);
        log.event('media_failed', {
          operation: 'future-input-reanchor',
          path: String(primary.entryId),
          error,
        });
        if (
          player.status().generation ===
            (replacementGeneration ?? view.generation)
        ) {
          player.pause();
          flushState();
          emit(['player']);
        }
      } finally {
        timeline.retire(mapping);
        if (reanchoring === work) reanchoring = undefined;
        ready.resolve();
      }
    });
    void position.promise.catch(() => {});
  };
  const afterMutation = <T>(result: T): T | Promise<T> =>
    reanchoring ? reanchoring.ready.then(() => result) : result;
  const advanceContinuous = () => {
    if (!continuous) return false;
    reconcileFuture();
    while (continuous && player.canAdvanceEnded()) {
      const record = sourcePlans.admitted[0];
      if (!record) {
        if (inputEnded !== sourcePlans.playing) return true;
        const plan = successorPlan('natural');
        if (!plan || plan.entryId !== null) {
          // Input exhaustion was committed before this later addition. The
          // completed primary still owns its full native tail; hand the new
          // successor to ordinary activation only after that sink gate passes.
          continuous = false;
          inputEnded = null;
          return false;
        }
        const result = player.applySuccessor(plan, null);
        if (result !== 'none') {
          continuous = false;
          inputEnded = null;
          if (result === 'player+queue') flushQueue();
          else flushState();
          emit(result === 'player+queue' ? ['queue', 'player'] : ['player']);
        }
        return true;
      }
      let result: AdvanceResult = 'none';
      sourcePlans.commit(record, (plan) => {
        result = player.applySuccessor(
          plan,
          record.source!.entryId,
          record.source!,
          true,
        );
        if (result !== 'none' && record.refreshed && record.media) {
          player.replaceOccurrence(record.source!.entryId, record.media);
        }
        return result !== 'none';
      });
      if (result === 'none') return true;
      continuousGeneration = player.status().generation;
      failedSources.clear();
      if (result === 'player+queue') flushQueue();
      else flushState();
      emit(result === 'player+queue' ? ['queue', 'player'] : ['player']);
      const promoted = sourcePlans.playing;
      const outcome = promoted && futureOutcomes.get(promoted);
      if (promoted && outcome) {
        futureOutcomes.delete(promoted);
        applySourceOutcome(promoted, outcome);
        if (outcome !== 'eof') return true;
      }
    }
    return true;
  };
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
    replacedStart?: CommandHandle,
    submitted?: CommandHandle,
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
      ...existingOccurrences(future.slice(0, at)),
      ...newOccurrences(media),
      ...existingOccurrences(future.slice(at)),
    ];
    const oldCurrent = player.status().current;
    const index = opts.playbackFromPosition !== undefined
      ? Math.min(Math.max(0, Math.trunc(opts.playbackFromPosition)), size - 1)
      : oldCurrent && !opts.clear
      ? items.findIndex((item) =>
        item.kind === 'existing' && item.entryId === oldCurrent.id
      )
      : 0;
    const commit = (
      activate: Activate,
      prepareNew: PrepareNew = (media) => media,
    ) => {
      checkSize(media.length, opts, limit);
      if (opts.clear) player.queueClear();
      const added = player.queueAddSources(prepareNew(media), at, firstId);
      if (opts.shuffle !== undefined) player.setShuffle(opts.shuffle);
      if (opts.play) player.play(opts.playbackFromPosition);
      activate(added);
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
      return afterMutation(commit(() => {}));
    }
    const result = transition(
      size > 0,
      commit,
      undefined,
      opts.clear || opts.playbackFromPosition !== undefined ||
        player.status().state !== 'play'
        ? { entry: items[index], items }
        : undefined,
      submitted,
    );
    return result instanceof Promise
      ? result.then(afterMutation)
      : afterMutation(result);
  };
  const resolveReference = deps.resolveQueueReference ?? createQueueResolver({
    getSong: (id) => library.getSong(id),
    getStation: () => Promise.resolve(null),
  });
  // One ordered mutation lane spans resolution, preparation and allocation.
  // Only add-and-play borrows pendingStart; ordinary adds have their own
  // lifetime, revoked by destructive queue clear/restore or engine disposal.
  let additionTail: Promise<void> | undefined;
  const orderedAddition = <T>(run: () => T | Promise<T>): T | Promise<T> => {
    const result = additionTail ? additionTail.then(run) : run();
    if (result instanceof Promise) {
      const settled = result.then(() => {}, () => {}).finally(() => {
        if (additionTail === settled) additionTail = undefined;
      });
      additionTail = settled;
    }
    return result;
  };
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
  ): QueueEntry[] | Promise<QueueEntry[]> =>
    operations.runImmediate((operation) => {
      requireOpen();
      const replacedStart = commands.capture();
      const controller = new AbortController();
      const abort = () => controller.abort();
      operation.signal.addEventListener('abort', abort, { once: true });
      const starts = opts.startPlaying === true || opts.play === true;
      const command = starts ? submitCommand() : undefined;
      command?.signal.addEventListener('abort', abort, { once: true });
      const reservation = reserveStart(starts, controller);
      if (command) pendingStart = command;
      let limit = defaultQueueLimit;
      additions.add(controller);
      const check = () => {
        if (
          controller.signal.aborted || operations.closed ||
          command && !command.isCurrent()
        ) {
          throw new PlaybackError(
            'playback_cancelled',
            'Queue addition cancelled',
          );
        }
      };
      const finish = () => {
        operation.signal.removeEventListener('abort', abort);
        command?.signal.removeEventListener('abort', abort);
        additions.delete(controller);
        reservation?.release();
        if (pendingStart === command) pendingStart = undefined;
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
          const result = commitAdd(
            media,
            opts,
            source,
            firstId,
            limit,
            replacedStart,
            command,
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
        const result = orderedAddition(run);
        if (!(result instanceof Promise)) {
          finish();
          return result;
        }
        const work = result.catch(failed).finally(finish);
        return work;
      } catch (error) {
        finish();
        return failed(error);
      }
    });
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
    const work = { source, promise: Promise.resolve() };
    failureWork = work;
    work.promise = operations.run(async () => {
      try {
        const command = submitCommand();
        const advance = async (): Promise<void> => {
          const view = player.status();
          const queue = player.queue();
          const plan = planSourceFailure(
            queue.items,
            view.current?.id,
            failedSources,
            view.repeat,
            view.consume,
            queue.version,
          );
          await transition(
            plan.entryId !== null,
            (activate) => {
              if (
                !ownsSource(source) ||
                player.status().generation !== view.generation
              ) return;
              const result = activate();
              if (!result || result === 'none') return;
              failedSource = null;
              record('sourceSkip', undefined, {
                kind: 'internal',
                via: 'source-outcome',
              }, player.status().state);
              if (result === 'player+queue') flushQueue();
              else flushState();
              emit(
                result === 'player+queue' ? ['queue', 'player'] : ['player'],
              );
            },
            { signal: source.signal, isCurrent: () => ownsSource(source) },
            successorActivation(plan),
            command,
          );
        };
        await advance();
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
        pauseAtCutoff();
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
    });
    return work.promise;
  };
  const requireOpen = () => {
    if (operations.closed) {
      throw new PlaybackError('playback_cancelled', 'Player is closed');
    }
  };
  const applySourceOutcome = (
    source: PlaybackSource,
    outcome: SourceOutcome,
  ) => {
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
        return;
      }
      pauseAtCutoff();
      record(
        'pause',
        undefined,
        { kind: 'internal', via: 'source-outcome' },
        'pause',
      );
      flushState();
      emit(['player']);
    }
  };
  return {
    attachSink(sink) {
      requireOpen();
      if (sink) sinks.add(sink);
      const detach = player.attachSink();
      return () => {
        if (sink) sinks.delete(sink);
        detach();
      };
    },
    prepareNextSource: (after) =>
      operations.runImmediate(() => {
        requireOpen();
        const tail = sourcePlans.admitted.at(-1)?.source ?? sourcePlans.playing;
        const command = commands.capture();
        if (
          tail !== after || !ownsSource(after) || !command?.isCurrent()
        ) return null;
        const plan = successorPlan('natural', after);
        if (!plan) return null;
        const record = sourcePlans.prepare(plan, command, after);
        const resolved = (selected: Awaited<SourcePreparation['ready']>) => {
          if (!sourcePlans.validate(record)) {
            throw new PlaybackError(
              'playback_cancelled',
              'Read source superseded',
            );
          }
          if (!selected) return null;
          const read = Object.freeze({
            source: selected.source,
            entry: Object.freeze({
              ...selected.media,
              id: selected.source.entryId,
            }),
          });
          reads.set(read, record);
          return read;
        };
        return record.ready instanceof Promise
          ? record.ready.then(resolved)
          : resolved(record.ready);
      }),
    admitSource(read) {
      const record = reads.get(read);
      if (!record || !sourcePlans.admit(record)) return false;
      reads.delete(read);
      if (!continuous) continuousGeneration = player.status().generation;
      continuous = true;
      inputEnded = null;
      return true;
    },
    sourceAccepted(source, frames) {
      const mapping = timelineSources.get(source);
      return ownsSource(source) && !!mapping &&
        timeline.accept(mapping, frames);
    },
    overlapSource(source, frames) {
      const mapping = timelineSources.get(source);
      if (
        !ownsSource(source) || source === sourcePlans.playing ||
        !mapping || !timeline.overlap(mapping, frames)
      ) return false;
      return player.sourcePosition(
        source,
        timeline.position(mapping)!.positionMs,
        0,
      );
    },
    beginSourceInput(source) {
      const mapping = timelineSources.get(source);
      return ownsSource(source) && mapping ? timeline.admitting(mapping) : null;
    },
    reviseSourceCompletion(source, receipt) {
      const mapping = timelineSources.get(source);
      return ownsSource(source) && mapping
        ? timeline.revise(mapping, receipt)
        : null;
    },
    finishSources(after) {
      const tail = sourcePlans.admitted.at(-1)?.source ?? sourcePlans.playing;
      if (
        tail !== after || !ownsSource(after) ||
        successorPlan('natural', after)?.entryId !== null &&
          !sourcePlans.terminal(after)
      ) return false;
      if (!continuous) continuousGeneration = player.status().generation;
      continuous = true;
      inputEnded = after;
      advanceContinuous();
      return true;
    },
    bindSource(source, streamId, epoch) {
      if (!ownsSource(source) || timelineSources.has(source)) return null;
      if (source !== sourcePlans.playing) {
        const primary = sourcePlans.playing &&
          timelineSources.get(sourcePlans.playing);
        if (
          !primary || primary.streamId !== streamId || primary.epoch !== epoch
        ) return null;
      }
      const mapping = timeline.begin({
        streamId,
        epoch,
        entryId: source.entryId,
        generation: source.generation,
        originMs: source.startMs,
      });
      timelineSources.set(source, mapping);
      const generation = player.status().generation;
      source.signal.addEventListener('abort', () => {
        // Reader cleanup does not retire the sink's run-wide bookmark authority.
        if (
          cutting !== mapping &&
          (source !== sourcePlans.playing || operations.closed ||
            player.status().generation !== generation)
        ) {
          timeline.retire(mapping);
        }
      }, { once: true });
      return mapping;
    },
    sourceProgress(source, progress) {
      const mapping = timelineSources.get(source);
      if (!ownsSource(source) || !mapping) return false;
      const previous = timeline.position(mapping)!;
      if (!timeline.observe(mapping, progress)) return false;
      let metadataChanged = false;
      if (sourcePlans.playing === source) {
        for (const metadata of timeline.scheduledMetadata(mapping)) {
          metadataChanged = player.sourceMetadata(source, metadata, true) ||
            metadataChanged;
        }
      }
      const rate = player.status().playbackRate;
      const accepted = player.sourcePosition(
        source,
        timeline.position(mapping)!.positionMs,
        progress.status === 'scheduled' &&
          progress.sourceFrames > previous.sourceFrames
          ? 1
          : 0,
      );
      if (accepted && metadataChanged) {
        flushQueue();
        emit(['queue', 'nowPlaying', 'player']);
      } else if (accepted && rate !== player.status().playbackRate) {
        emit(['player']);
      }
      return accepted;
    },
    sealSource(source, target) {
      const mapping = timelineSources.get(source);
      return ownsSource(source) && !!mapping && timeline.seal(mapping, target);
    },
    sourceCompatibilityRemaining: (source) =>
      player.sourceCompatibilityRemaining(source),
    completeSource: (source, receipt) =>
      operations.run(async () => {
        const mapping = timelineSources.get(source);
        if (
          !ownsSource(source) || !mapping ||
          !timeline.complete(mapping, receipt) ||
          !player.sourceComplete(source)
        ) return false;
        const current = player.status().current;
        if (
          sourcePlans.playing === source && current?.facts.kind === 'song' &&
          (queueDuration(current) ?? 0) <= 0
        ) {
          // Matching sink completion terminates an unknown-length catalog
          // source, but never grants natural advancement or consumes it.
          player.pause();
          record(
            'stop',
            undefined,
            { kind: 'internal', via: 'source-end' },
            'stop',
          );
          flushState();
          emit(['player']);
        }
        advanceContinuous();
        await new Promise<void>((resolve) => {
          source.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
          if (source.signal.aborted) resolve();
        });
        // Abort fires within the synchronous core mutation. This continuation
        // follows its persistence publication and notification, never precedes it.
        return true;
      }),
    openSource: (entryId, generation) => {
      if (operations.closed) return null;
      if (needsCapacity() && !deps.capacity!.authority()()) return null;
      const source = player.openSource(entryId, generation);
      if (source) {
        sourcePlans.playingSource(source);
      }
      return source;
    },
    sourcePlanView: () => ({
      reading: sourcePlans.reading?.source ?? null,
      playing: sourcePlans.playing?.signal.aborted ? null : sourcePlans.playing,
    }),
    cancelSource(source) {
      if (operations.closed) return;
      const version = player.queue().version;
      const rate = player.status().playbackRate;
      player.cancelSource(source);
      if (player.queue().version !== version) {
        flushQueue();
        emit(['queue', 'nowPlaying']);
      }
      if (rate !== player.status().playbackRate) emit(['player']);
    },
    sourceAudio(source, durationMs) {
      if (operations.closed) return;
      if (
        player.sourceAudio(source, durationMs) && ownsSource(source)
      ) {
        recoveryForSource(source).audioMs += durationMs;
      }
    },
    retrySource: (source, reason, cancellation) =>
      operations.run(async () => {
        const signal = cancellation
          ? AbortSignal.any([source.signal, cancellation])
          : source.signal;
        const media = source === sourcePlans.playing
          ? player.status().current
          : sourcePlans.admitted.find((record) => record.source === source)
            ?.media;
        if (
          signal.aborted || !ownsSource(source) ||
          media?.facts.kind !== 'web'
        ) return false;
        const run = recoveryForSource(source);
        const backoff =
          await deps.state?.getTyped('playback.source.retryBackoffMs') ??
            recoverySettings.retryBackoffMs.default;
        const reset = Number(
          await deps.state?.getTyped('playback.source.retryResetAudioMs') ??
            recoverySettings.retryResetAudioMs.default,
        );
        if (
          signal.aborted || !ownsSource(source) ||
          sourceRecovery.get(source) !== run
        ) return false;
        if (run.audioMs >= reset) {
          run.attempts = 0;
          if (sourcePlans.playing === source) failedSources.clear();
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
            signal.removeEventListener('abort', finish);
            resolve();
          };
          const timer = setTimeout(finish, waitMs);
          signal.addEventListener('abort', finish, { once: true });
          if (signal.aborted) finish();
        });
        return !signal.aborted && ownsSource(source) &&
          sourceRecovery.get(source) === run;
      }),
    reportSourceMetadata(source, metadata, sourceFrame) {
      const mapping = timelineSources.get(source);
      if (sourceFrame !== undefined && mapping && ownsSource(source)) {
        return timeline.metadata(mapping, sourceFrame, metadata);
      }
      if (operations.closed || !player.sourceMetadata(source, metadata)) {
        return false;
      }
      flushQueue();
      emit(['queue', 'nowPlaying']);
      return true;
    },
    reportSourceOutcome(source, outcome) {
      if (operations.closed || !player.sourceOutcome(source, outcome)) {
        return false;
      }
      // A speculative failure is retained on its incarnation. It cannot pause,
      // skip, consume or discard healthy primary audio before becoming due.
      if (sourcePlans.playing !== source) futureOutcomes.set(source, outcome);
      else applySourceOutcome(source, outcome);
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
        view.state === 'play'
          ? undefined
          : existingActivation(player.queue().items, index),
      );
    },
    pause(source) {
      requireOpen();
      submitCommand();
      pauseAtCutoff();
      record('pause', undefined, source, 'pause');
      flushState();
      emit(['player']);
    },
    stop(source) {
      requireOpen();
      submitCommand();
      // Explicit stop releases transport intent, not the bookmark. Engine stop
      // remains the terminal operation for exhaustion and end-of-queue.
      pauseAtCutoff('stop');
      record('stop', undefined, source, 'stop');
      flushState();
      emit(['player']);
    },
    toggle(source) {
      const view = player.status();
      if (view.state === 'play') {
        requireOpen();
        submitCommand();
        pauseAtCutoff();
        record('toggle', undefined, source, 'pause');
        flushState();
        emit(['player']);
        return;
      }
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
        existingActivation(player.queue().items, index),
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
        existingActivation(queue, next),
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
        existingActivation(player.queue().items, index, { direction: -1 }),
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
        existingActivation(player.queue().items, index),
      );
    },
    setShuffle(on, source) {
      requireOpen();
      submitCommand();
      player.setShuffle(on);
      record('shuffle', `shuffle=${on}`, source, 'none', false, {
        shuffle: on,
      });
      flushState();
      emit(['options']);
      return afterMutation(undefined);
    },
    setConsume(on, source) {
      requireOpen();
      submitCommand();
      player.setConsume(on);
      record('consume', `consume=${on}`, source, 'none', false, {
        consume: on,
      });
      flushState();
      emit(['options']);
      return afterMutation(undefined);
    },
    setRepeat(mode, source) {
      requireOpen();
      submitCommand();
      player.setRepeat(mode);
      record('repeat', `repeat=${mode}`, source, 'none', false, {
        repeat: mode,
      });
      flushState();
      emit(['options']);
      return afterMutation(undefined);
    },
    validateCrossfade: validateCrossfadeMs,
    setCrossfade: (ms, source) =>
      operations.runImmediate(() => {
        requireOpen();
        crossfadeFrames(ms);
        const change = () => {
          player.setCrossfade(ms);
          persistence?.saveCrossfade?.(ms);
          record('crossfade', `crossfade_ms=${ms}`, source, 'none', false, {
            crossfadeMs: ms,
          });
          emit(['options', 'player']);
        };
        return persistence?.publishedCommands
          ? persistence.publishedCommands.publish(change).command
          : change();
      }),
    setVolume: (opts, source) =>
      operations.runImmediate(() => {
        requireOpen();
        if (opts.volume === undefined && opts.step === undefined) return;
        const change = () => {
          requireOpen();
          const before = player.status().volume;
          player.setVolume(opts);
          const volume = player.status().volume;
          const step = volume - before;
          for (const out of outputs?.list() ?? []) {
            if (out.selected && out.linked !== false) {
              outputs?.update(out.id, {
                volume: volume === 0 ? 0 : out.volume + step,
              }, source);
            }
          }
          persistence?.saveVolume?.(volume);
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
        };
        return persistence?.publishedCommands
          ? persistence.publishedCommands.publish(change).command
          : persistence?.changeVolume
          ? persistence.changeVolume(change)
          : change();
      }),
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
        view.state === 'stop'
          ? existingActivation(player.queue().items, index)
          : undefined,
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
      if (!current) {
        if (pendingStart && sourcePlans.reading?.command !== pendingStart) {
          cancelStart(pendingStart);
        }
        player.queueRemove(entryId);
        record('queueRemove', `entryId=${entryId}`, source, 'none', false, {
          entryId,
        });
        flushQueue();
        emit(['queue']);
        return afterMutation(undefined);
      }
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
        existingActivation(future, index),
      );
    },
    queueMove(entryId, position, expectedVersion, source) {
      requireOpen();
      checkVersion(expectedVersion);
      requireEntry(entryId);
      if (pendingStart && sourcePlans.reading?.command !== pendingStart) {
        cancelStart(pendingStart);
      }
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
      return afterMutation(undefined);
    },
    queueClear(source, expectedVersion) {
      requireOpen();
      checkVersion(expectedVersion);
      submitCommand();
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
    queueImport: (snapshot, opts, source, publish) =>
      operations.run(async (operation) => {
        requireOpen();
        checkVersion(opts.expectedVersion);
        const controller = new AbortController();
        const abort = () => controller.abort();
        operation.signal.addEventListener('abort', abort, { once: true });
        const replace = opts.mode === 'replace';
        const starts = snapshot.items.length > 0 &&
          (opts.startPlaying === true ||
            replace && player.status().state === 'play');
        const command = replace || opts.startPlaying
          ? submitCommand()
          : undefined;
        command?.signal.addEventListener('abort', abort, { once: true });
        const reservation = reserveStart(starts, controller);
        if (command) pendingStart = command;
        additions.add(controller);
        const check = () => {
          if (
            operations.closed || controller.signal.aborted ||
            command && !command.isCurrent()
          ) {
            throw new PlaybackError(
              'playback_cancelled',
              'Queue copy cancelled',
            );
          }
        };
        try {
          await orderedAddition(async () => {
            check();
            const limit = await queueLimit();
            check();
            checkSize(snapshot.items.length, { clear: replace }, limit);
            const firstId = snapshot.items.length && deps.reserveQueueIds
              ? await deps.reserveQueueIds(snapshot.items.length)
              : undefined;
            check();
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
            const at = Math.min(
              Math.max(0, Math.trunc(position)),
              future.length,
            );
            const items = [
              ...existingOccurrences(future.slice(0, at)),
              ...newOccurrences(snapshot.items),
              ...existingOccurrences(future.slice(at)),
            ];
            const index = replace ? snapshot.currentIndex ?? 0 : at;
            const commit = (activate: Activate, prepareNew: PrepareNew) => {
              checkVersion(opts.expectedVersion);
              checkSize(snapshot.items.length, { clear: replace }, limit);
              return publish(() => {
                // Registry publication may itself wait. Consume only this
                // submitted command at the actual synchronous mutation boundary.
                check();
                checkVersion(opts.expectedVersion);
                checkSize(snapshot.items.length, { clear: replace }, limit);
                if (replace) player.queueClear();
                const added = snapshot.items.length
                  ? player.queueAddSources(
                    prepareNew(snapshot.items),
                    at,
                    firstId,
                  )
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
                activate(added);
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
            };
            const work = command
              ? transition(
                starts,
                commit,
                undefined,
                { entry: items[index], items },
                command,
              )
              : commit(() => {}, (media) => media);
            reservation?.release();
            await work;
            await afterMutation(undefined);
          });
        } catch (error) {
          if (controller.signal.aborted) {
            throw new PlaybackError(
              'playback_cancelled',
              'Queue copy cancelled',
            );
          }
          throw error;
        } finally {
          operation.signal.removeEventListener('abort', abort);
          command?.signal.removeEventListener('abort', abort);
          additions.delete(controller);
          reservation?.release();
          if (pendingStart === command) pendingStart = undefined;
        }
      }),

    advanceEnded() {
      if (operations.closed) return;
      return operations.runImmediate(() => {
        if (advanceContinuous()) return;
        if (failedSource) {
          // Source outcomes start this work before the next tick. Its captured
          // receipt, not the pending-start flag, represents publication/cleanup.
          if (failureWork?.source === failedSource) return failureWork.promise;
          if (!pendingStart) return advanceFailedSource();
          return;
        }
        if (pendingStart) return;
        const view = player.status();
        const captured = commands.capture();
        if (
          captured?.isCurrent() && sourcePlans.playing &&
          ownsSource(sourcePlans.playing) &&
          view.current && !view.capabilities.live
        ) {
          sourcePlans.prepare(successorPlan('natural')!, captured);
        }
        if (!player.canAdvanceEnded()) return;
        const command = sourcePlans.reading?.command ?? submitCommand();
        const advance = (): void | Promise<void> => {
          const view = player.status();
          const queue = player.queue();
          const plan = planPlaybackSuccessor({
            reason: 'natural',
            revision: queue.version,
            items: queue.items,
            currentEntryId: view.current?.id,
            repeat: view.repeat,
            consume: view.consume,
          });
          const commit = (activate: Activate) => {
            if (player.status().generation !== view.generation) return;
            const result = activate();
            if (!result || result === 'none') return;
            failedSources.clear();
            if (result === 'player+queue') flushQueue();
            else flushState();
            emit(result === 'player+queue' ? ['queue', 'player'] : ['player']);
          };
          return Promise.resolve(
            transition(
              true,
              commit,
              undefined,
              successorActivation(plan),
              command,
            ),
          );
        };
        return Promise.resolve(advance()).catch((error) => {
          // Internal transitions have no HTTP caller. Keep the bookmark/queue and
          // publish a paused clock; an explicit newer command always wins.
          if (
            error instanceof PlaybackError &&
            error.code === 'playback_cancelled'
          ) return;
          if (
            !operations.closed && player.status().state === 'play' &&
            !pendingStart
          ) {
            pauseAtCutoff();
            record('pause', undefined, {
              kind: 'internal',
              via: 'playback-target-loss',
            }, 'pause');
            flushState();
            emit(['player']);
          }
        });
      });
    },

    restore: (snapshot) =>
      operations.runImmediate(() => {
        requireOpen();
        cancelAdditions();
        const command = submitCommand();
        const index = snapshot.currentIndex ?? 0;
        const candidate = snapshot.queue[index];
        const prepareUrl = deps.prepareQueueMedia &&
          candidate?.facts.kind === 'web' && candidate.facts.mode === 'unknown';
        const commit = (restored = snapshot, activate?: Activate) => {
          player.restore(restored);
          activate?.();
          record(
            'restore',
            undefined,
            { kind: 'internal', via: 'restore' },
            restored.state,
          );
          announcedCommander = commander;
          announcedQueueVersion = player.queue().version;
          if (restored.queueChanged) flushQueue();
          emit(['queue', 'player', 'options']);
        };
        if (
          snapshot.state !== 'play' || !snapshot.queue.length ||
          !deps.targets && !prepareUrl && !needsCapacity()
        ) {
          return commit();
        }
        return (async () => {
          await transition(
            true,
            (activate) => {
              commit(snapshot, activate);
            },
            undefined,
            existingActivation(snapshot.queue, index),
            command,
          );
        })().catch(
          (error) => {
            requireOpen();
            if (!command.isCurrent()) {
              throw new PlaybackError(
                'playback_cancelled',
                'Restore cancelled',
              );
            }
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
      }),

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

    close() {
      if (closeWork) return closeWork;
      const completion = Promise.withResolvers<void>();
      closeWork = completion.promise;
      // Fence intake before cancellation can synchronously reenter the player.
      const settled = operations.close();
      const prepared = sourcePlans.close();
      cancelStart();
      cancelAdditions();
      activeReservation?.release();
      activeReservation = undefined;
      // Revoke a parked source even if its boot is being closed separately.
      if (sourcePlans.playing) player.cancelSource(sourcePlans.playing);
      unsubscribeOutputs?.();
      if (tick !== null) clearInterval(tick);
      void Promise.all([
        settled,
        prepared,
        deps.reports === undefined ? reports.close() : undefined,
      ]).then(() => {
        timeline.close();
        completion.resolve();
      }, completion.reject);
      return closeWork;
    },
  };
}
