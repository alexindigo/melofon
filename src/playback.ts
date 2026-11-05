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
import type {
  NowPlaying,
  PlaybackReport,
  SessionPlaybackReport,
} from './nowplaying.ts';
import type { Sessions } from './sessions.ts';
import type { Notify } from './notify.ts';
import type { State } from './state.ts';
import { type Log, scopedLog } from './logging.ts';
import { PlaybackError } from './playback-errors.ts';
import { planSourceFailure } from './source-recovery.ts';
import {
  catalogMedia,
  createQueueResolver,
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

interface NowPlayingFacts {
  positionMs: number | null;
  startedAtMs: number | null;
  reportedAtMs: number;
  state: 'starting' | 'playing' | 'paused';
  playbackRate: number;
}

export type NowPlayingViewRow =
  & NowPlayingFacts
  & QueueMedia
  & (
    | {
      kind: 'app';
      username: string;
      client: string;
      appPlayerId: number;
    }
    | {
      kind: 'server';
      entryId: number;
      label: string;
      /** Last external commander's known username, not the seeded account.
       * An anonymous external command replaces it with null; internal commands
       * and natural transitions preserve it. No request diagnostics escape. */
      commander: string | null;
      /** Selected targets, not evidence of audible output. */
      speakers: { id: string; name: string }[];
    }
  );

/** A boot retains its own admission authority across asynchronous preparation.
 * Core checks it again immediately before committing the engine transition. */
export interface PlaybackAuthority {
  signal: AbortSignal;
  isCurrent(): boolean;
}

export interface QueueAddOptions {
  position?: number;
  playbackFromPosition?: number;
  play?: boolean;
  clear?: boolean;
  shuffle?: boolean;
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
    references: QueueReference[],
    opts?: QueueAddOptions,
    source?: CommandSource,
  ): Promise<QueueEntry[]>;
  queueClear(source?: CommandSource): void;

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
  nowPlayingView(): Promise<NowPlayingViewRow[]>;
  /** The last recorded engine mutation (null before the first). */
  lastCommand(): LastCommand | null;
  /** Core lifecycle; also callable with a controlled report clock in tests. */
  expireReports(): Promise<boolean>;
  startReportExpiry(state: State): Promise<void>;
  /** Stop ticks/subscriptions and drain any in-flight expiry before store close. */
  close(): Promise<void>;
}

export function createPlayback(deps: {
  player: Player;
  nowPlaying: NowPlaying;
  library: Library;
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
  /** Restart transparency (plan restart-transparency): when present, every
   * state change flushes the engine snapshot and queue, and a 1 Hz tick
   * keeps position_ms current while playing. */
  persistence?: PlayerPersistence;
  resolveQueueReference?: (
    reference: QueueReference,
  ) => Promise<QueueMedia | null>;
  prepareQueueMedia?: (
    media: QueueMedia,
    signal: AbortSignal,
  ) => Promise<QueueMedia>;
  state?: Pick<State, 'declare' | 'getTyped'>;
  log?: Log;
}): Playback {
  const { player, nowPlaying, library, outputs, notify, persistence } = deps;
  const log = deps.log ?? scopedLog('playback');
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
    notify?.emit(changed ? [...types, 'nowPlaying'] : types, undefined, 'all');
  };
  // Playback owns the aggregate dependency on selected target names/ids, not
  // hats or individual output call sites. Ignore volume, admission and other
  // output facts which do not appear in this view. Drop the subscription on close.
  let speakers = JSON.stringify(selectedSpeakers());
  let pendingStart: AbortController | undefined;
  const cancelStart = () => {
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
      !authority || !authority.signal.aborted && authority.isCurrent();
    const cancelled = () =>
      new PlaybackError('playback_cancelled', 'Playback start cancelled');
    if (!current()) throw cancelled();
    cancelStart();
    const items = activation?.items ?? player.queue().items;
    const candidate = activation && items[activation.index];
    const needsPreparation = (item: QueueMedia) =>
      deps.prepareQueueMedia &&
      item.facts.kind === 'web' && item.facts.mode === 'unknown';
    const needsResolution = starts && activation && candidate &&
      (deps.resolveQueueReference && candidate.reference.kind === 'station' ||
        needsPreparation(candidate));
    if (!starts || !deps.targets && !needsResolution) return commit(() => {});
    const controller = new AbortController();
    const abort = () => controller.abort();
    authority?.signal.addEventListener('abort', abort, { once: true });
    pendingStart = controller;
    const prepare = async () => {
      let selected: { index: number; media: QueueMedia } | null | undefined;
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
            selected = { index, media };
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
      pendingStart = undefined;
      const result = commit(() => {
        if (selected === undefined) return;
        if (selected === null) {
          player.stop();
          return;
        }
        player.replaceMedia(selected.index, selected.media);
        if (selected.index !== activation!.index) player.play(selected.index);
      });
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
  // The position tick: writes only while the engine plays ("on while play,
  // off otherwise"), so a restored play needs no extra wiring. SIGKILL
  // loses at most ~1 s of position.
  const tick = persistence === undefined ? null : setInterval(() => {
    if (player.status().state === 'play') flushState();
  }, 1000);
  let closed = false;
  let closing = false;
  let expiryStarted = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTask: Promise<void> | undefined;
  let expiryWork: Promise<boolean> | undefined;
  // A timer and an explicit sweep share one operation, not competing removals
  // or duplicate events. Persistence completes before the invalidation is emitted.
  const expireReports = (): Promise<boolean> => {
    if (closed) return Promise.resolve(false);
    return expiryWork ??= (async () => {
      try {
        const changed = await nowPlaying.expire();
        if (changed) invalidateNowPlaying();
        return changed;
      } finally {
        expiryWork = undefined;
      }
    })();
  };
  // One subscription per aggregate owner. Queue after any in-flight sweep so
  // a revoke cannot be missed by a sweep whose transaction preceded it.
  let sessionCleanup = Promise.resolve();
  const unsubscribeSessions = deps.sessions?.onSessionsEnded(() => {
    sessionCleanup = sessionCleanup.then(async () => {
      await expiryWork;
      await expireReports();
    }).catch((error) => log.event('playback_expiry_failed', { error }));
  });
  const addSources = (
    media: QueueMedia[],
    opts: QueueAddOptions = {},
    source?: CommandSource,
  ): QueueEntry[] | Promise<QueueEntry[]> => {
    const size = media.length + (opts.clear ? 0 : player.queue().items.length);
    const future = opts.clear ? [] : player.queue().items;
    const at = Math.min(
      Math.max(0, Math.trunc(opts.position ?? future.length)),
      future.length,
    );
    const items = [...future.slice(0, at), ...media, ...future.slice(at)];
    const oldCurrent = player.status().current;
    const index = opts.playbackFromPosition !== undefined
      ? Math.min(Math.max(0, Math.trunc(opts.playbackFromPosition)), size - 1)
      : oldCurrent && !opts.clear
      ? items.indexOf(oldCurrent)
      : 0;
    return transition(
      opts.play === true && size > 0,
      (activate) => {
        if (opts.clear) player.queueClear();
        const added = player.queueAddSources(media, opts.position);
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
      },
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
  const prepareAdd = async (
    resolve: (signal: AbortSignal) => Promise<QueueMedia[]>,
    opts?: QueueAddOptions,
    source?: CommandSource,
  ): Promise<QueueEntry[]> => {
    cancelStart();
    const controller = new AbortController();
    pendingStart = controller;
    try {
      const media = await resolve(controller.signal);
      const prepared: QueueMedia[] = [];
      for (const item of media) {
        prepared.push(
          deps.prepareQueueMedia
            ? await deps.prepareQueueMedia(item, controller.signal)
            : item,
        );
        controller.signal.throwIfAborted();
      }
      if (pendingStart !== controller) controller.abort();
      controller.signal.throwIfAborted();
      pendingStart = undefined;
      return await addSources(prepared, opts, source);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new PlaybackError(
          'playback_cancelled',
          'Queue preparation cancelled',
        );
      }
      throw error;
    } finally {
      if (pendingStart === controller) pendingStart = undefined;
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
  return {
    openSource: (entryId, generation) => {
      if (closed || closing) return null;
      const source = player.openSource(entryId, generation);
      if (source) openedSource = source;
      return source;
    },
    cancelSource(source) {
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
    expireReports,
    async startReportExpiry(state) {
      if (closed || expiryStarted) return;
      expiryStarted = true;
      state.declare('playback.sessionSweepSeconds', {
        type: 'number',
        minimum: 0.01,
        maximum: 3600,
        default: 1,
      });
      let intervalMs = 1000;
      const cycle = async () => {
        try {
          intervalMs =
            (await state.getTyped('playback.sessionSweepSeconds') as number) *
            1000;
          if (!closing) await expireReports();
        } catch (error) {
          log.event('playback_expiry_failed', { error });
        } finally {
          // Self-scheduling bounds work even if a store call takes longer than
          // the cadence. Read live policy again each cycle; no per-hat timer.
          if (!closing) {
            expiryTimer = setTimeout(() => {
              expiryTask = cycle();
            }, intervalMs);
          }
        }
      };
      expiryTask = cycle();
      await expiryTask;
    },
    async reportPlaying(report) {
      // Queue the session write before an abort can queue its clear. Catalog
      // duration is resolved by the store's session view, not awaited here.
      await nowPlaying.set(
        report.username,
        report.client,
        report.trackId,
        report.streamId,
        report.positionMs,
      );
      invalidateNowPlaying();
    },

    async reportStopped({ streamId }) {
      // Clears only when this streamId is still the session's current one.
      if (await nowPlaying.clearByStreamId(streamId)) invalidateNowPlaying();
    },

    async reportPlayback(report) {
      const song = await library.getSong(report.trackId);
      if (!song) return false;
      await nowPlaying.report(report, song.durationMs);
      invalidateNowPlaying();
      return true;
    },

    async reportSessionPlayback(report) {
      const song = await library.getSong(report.trackId);
      if (!song) return false;
      const changed = await nowPlaying.reportSession(report, song.durationMs);
      if (changed) invalidateNowPlaying();
      return changed;
    },

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
      cancelStart();
      player.pause();
      record('pause', undefined, source, 'pause');
      flushState();
      emit(['player']);
    },
    stop(source) {
      cancelStart();
      player.stop();
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
    setShuffle(on, source) {
      cancelStart();
      player.setShuffle(on);
      record('shuffle', `shuffle=${on}`, source, 'none', false, {
        shuffle: on,
      });
      flushState();
      emit(['options']);
    },
    setConsume(on, source) {
      cancelStart();
      player.setConsume(on);
      record('consume', `consume=${on}`, source, 'none', false, {
        consume: on,
      });
      flushState();
      emit(['options']);
    },
    setRepeat(mode, source) {
      cancelStart();
      player.setRepeat(mode);
      record('repeat', `repeat=${mode}`, source, 'none', false, {
        repeat: mode,
      });
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
      return addSources(songs.map(catalogMedia), opts, source);
    },
    queueAddSources(media, opts, source) {
      if (
        !deps.prepareQueueMedia ||
        !media.some((item) => item.facts.kind === 'web')
      ) {
        return addSources(media, opts, source);
      }
      return prepareAdd(() => Promise.resolve(media), opts, source);
    },
    queueAddReferences(references, opts, source) {
      return prepareAdd(
        async (signal) => {
          const media: QueueMedia[] = [];
          for (const reference of references) {
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
          return media;
        },
        opts,
        source,
      );
    },
    queueClear(source) {
      cancelStart();
      player.queueClear();
      record('queueClear', undefined, source, 'stop', true);
      flushQueue();
      // The clear also stopped the engine — both reads changed.
      emit(['queue', 'player']);
    },

    advanceEnded() {
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
        !deps.targets && !prepareUrl
      ) {
        cancelStart();
        return commit();
      }
      return Promise.resolve(transition(
        true,
        (activate) => {
          commit();
          activate();
        },
        undefined,
        { index, items: snapshot.queue },
      )).catch(
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

    playerView: () => player.status(),
    queueView: () => player.queue(),
    lastCommand: () => last,

    async nowPlayingView() {
      const out: NowPlayingViewRow[] = [];
      const status = player.status();
      if (status.current !== null && status.clock !== null) {
        const { id, ...media } = status.current;
        out.push({
          ...media,
          kind: 'server',
          entryId: id,
          label: 'melofon',
          commander,
          speakers: selectedSpeakers(),
          positionMs: status.itemProgressMs,
          startedAtMs: status.clock.startedAtMs,
          reportedAtMs: status.clock.reportedAtMs,
          state: status.state === 'play' ? 'playing' : 'paused',
          playbackRate: 1,
        });
      }
      for (const row of await nowPlaying.list()) {
        const song = await library.getSong(row.trackId);
        if (song === null) continue; // track vanished since the report
        out.push({
          kind: 'app',
          username: row.username,
          client: row.client,
          ...catalogMedia(song),
          positionMs: row.positionMs,
          startedAtMs: row.startedAtMs,
          reportedAtMs: row.reportedAtMs,
          state: row.state,
          playbackRate: row.playbackRate,
          appPlayerId: row.playerId,
        });
      }
      return out;
    },

    async close() {
      cancelStart();
      // Revoke a parked source even if its boot is being closed separately.
      if (openedSource) player.cancelSource(openedSource);
      closing = true;
      unsubscribeSessions?.();
      unsubscribeOutputs?.();
      clearTimeout(expiryTimer);
      if (tick !== null) clearInterval(tick);
      await sessionCleanup;
      closed = true;
      await expiryTask;
      await expiryWork;
      await failureWork?.promise;
    },
  };
}
