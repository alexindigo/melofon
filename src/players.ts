// Household registry and engine lifecycle. The store owns durable identities;
// each engine owns its commands, clock, queue, source and persistence port.
import type { Store } from './store/index.ts';
import type { StoredPlayer } from './store/players.ts';
import type { EnginePersistence, Persistence } from './persistence.ts';
import {
  type CommandSource,
  createPlayer,
  type Outputs,
  planRestore,
} from './player.ts';
import { SpeakerError } from './speaker-errors.ts';
import {
  createPlayback,
  type Playback,
  type QueueCopyOptions,
} from './playback.ts';
import { PlaybackError } from './playback-errors.ts';
import type { PlaybackReports } from './playback-reports.ts';
import type {
  createPlaybackCapacity,
  PlaybackCapacity,
} from './playback-capacity.ts';
import type { SpeakerPairingView } from './speakers.ts';
import { outputPlayerId, playerOutputs } from './player-outputs.ts';
import type { Notify } from './notify.ts';
import { scopedLog } from './logging.ts';

export class PlayerError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'invalid_name'
      | 'same_player'
      | 'name_conflict'
      | 'last_player'
      | 'default_player'
      | 'closed',
    message: string,
  ) {
    super(message);
    this.name = 'PlayerError';
  }
}

export interface PlayerBoot {
  retry(id: string): Promise<void>;
  changeCredentials(id: string, save: () => Promise<void>): Promise<void>;
  pair(id: string): Promise<SpeakerPairingView>;
  submitPin(id: string, pin: string): Promise<SpeakerPairingView>;
  close(): Promise<void>;
}

export async function createPlayers(deps: {
  store: Store;
  persistence: Persistence;
  outputs: Outputs;
  reports: PlaybackReports;
  notify: Notify;
  playback:
    & Omit<
      Parameters<typeof createPlayback>[0],
      | 'player'
      | 'playerId'
      | 'outputs'
      | 'reports'
      | 'persistence'
      | 'reserveQueueIds'
      | 'targets'
      | 'capacity'
    >
    & {
      resolveQueueReference: NonNullable<
        Parameters<typeof createPlayback>[0]['resolveQueueReference']
      >;
    };
  targets?(
    playerId: number,
  ): NonNullable<Parameters<typeof createPlayback>[0]['targets']>;
  capacity?: Pick<ReturnType<typeof createPlaybackCapacity>, 'forPlayer'>;
  createBoot?(
    playerId: number,
    playback: Playback,
    outputs: Outputs,
    capacity?: PlaybackCapacity,
  ): PlayerBoot;
  clock?: Parameters<typeof createPlayer>[0];
  now?: () => number;
  maxResumeAgeMs: number;
}) {
  type Engine = {
    row: StoredPlayer;
    playback: Playback;
    outputs: Outputs;
    persistence: EnginePersistence;
    capacity?: PlaybackCapacity;
    boot?: PlayerBoot;
    clock?: ReturnType<typeof setInterval>;
    disposing: boolean;
  };
  const engines = new Map<number, Engine>();
  const log = scopedLog('players');
  let closed = false;
  let closeWork: Promise<void> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  const requireOpen = () => {
    if (closed) throw new PlayerError('closed', 'Player registry is closed');
  };
  const requireEngine = (id: number) => {
    requireOpen();
    const engine = engines.get(id);
    if (!engine || engine.disposing) {
      throw new PlayerError('not_found', 'Player not found');
    }
    return engine;
  };
  const defaultEngine = () => {
    requireOpen();
    return [...engines.values()].find((engine) => engine.row.isDefault)!;
  };
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    requireOpen();
    const work = tail.then(operation);
    tail = work.catch(() => {});
    return work;
  };
  const changed = (id: number) =>
    deps.notify.emit(['players'], { players: [String(id)] }, 'all');
  const nameFor = (name: string, except?: number) => {
    if (typeof name !== 'string' || !name.trim()) {
      throw new PlayerError('invalid_name', 'Player name is required');
    }
    name = name.trim();
    if (
      [...engines.values()].some((engine) =>
        engine.row.id !== except &&
        engine.row.name.toLowerCase() === name.toLowerCase()
      )
    ) {
      throw new PlayerError('name_conflict', 'Player name is already in use');
    }
    return name;
  };
  const add = (row: StoredPlayer): Engine => {
    const persistence = deps.persistence.forPlayer(row.id);
    const outputs = playerOutputs(deps.outputs, row.id);
    const player = createPlayer(deps.clock);
    const capacity = deps.capacity?.forPlayer(() => ({
      id: row.id,
      name: row.name,
    }));
    const playback = createPlayback({
      ...deps.playback,
      playerId: row.id,
      playerName: () => row.name,
      player,
      outputs,
      reports: deps.reports,
      persistence: {
        ...persistence,
        saveCommand(atMs) {
          row.commandedAtMs = atMs;
          persistence.saveCommand?.(atMs);
        },
      },
      reserveQueueIds: (count) => deps.store.players.reserveQueueIds(count),
      targets: deps.targets?.(row.id),
      capacity,
      notify: deps.notify,
    });
    const engine = {
      row,
      playback,
      outputs,
      persistence,
      capacity,
      disposing: false,
    };
    engines.set(row.id, engine);
    return engine;
  };
  const start = (engine: Engine) => {
    engine.boot = deps.createBoot?.(
      engine.row.id,
      engine.playback,
      engine.outputs,
      engine.capacity,
    );
    engine.clock = setInterval(() => {
      void engine.playback.advanceEnded();
    }, 500);
  };
  const dispose = async (engine: Engine) => {
    engine.disposing = true;
    clearInterval(engine.clock);
    await engine.playback.close();
    await engine.boot?.close();
    await engine.persistence.close();
  };
  try {
    for (const row of await deps.store.players.list()) add(row);
    // Command time, not periodic bookmark time, chooses a conflicting restore.
    // Unknown/equal command times retain the stable stored player order.
    const restoreOrder = [...engines.values()].sort((a, b) =>
      (b.row.commandedAtMs ?? -Infinity) - (a.row.commandedAtMs ?? -Infinity)
    );
    for (const engine of restoreOrder) {
      const snapshot = await planRestore({
        queue: await engine.persistence.loadQueue(),
        saved: await engine.persistence.loadPlayerState(),
        resolve: deps.playback.resolveQueueReference,
        nowMs: (deps.now ?? Date.now)(),
        maxAgeMs: deps.maxResumeAgeMs,
        selectedOutputPresent: engine.outputs.list().some((row) =>
          row.selected
        ),
      });
      if (snapshot) {
        try {
          await engine.playback.restore(snapshot);
        } catch (error) {
          if (
            !(error instanceof PlaybackError) || error.code !== 'airplay_busy'
          ) {
            throw error;
          }
          // Startup resolves competing durable intentions without commanding or
          // pausing the winner. Explicit start paths still return the refusal.
          await engine.playback.restore({ ...snapshot, state: 'pause' });
        }
        log.event('restore_complete', {
          queued: snapshot.queue.length,
          state: engine.playback.playerView().state,
          currentIndex: snapshot.currentIndex,
          positionMs: snapshot.positionMs,
        });
      }
    }
    for (const engine of engines.values()) start(engine);
  } catch (error) {
    await Promise.all([...engines.values()].map(dispose));
    throw error;
  }
  // These functions are captured by hats at load time. Resolve the engine at
  // invocation, not when constructing the service bag. Reports never retarget.
  const current = () => defaultEngine().playback;
  const members = (id: number) =>
    deps.outputs.list().filter((row) => outputPlayerId(row) === id);
  const changeMembers = (id: number, ids: string[], source?: CommandSource) => {
    const engine = requireEngine(id);
    // Admission and the transaction's capture are synchronous. Playback takes
    // its own active demand from the outputs notification; this temporary ticket
    // never becomes a second persistent writer of the engine's demand.
    const reservation = engine.playback.playerView().state === 'play' &&
        engine.capacity &&
        ids.some((id) =>
          deps.outputs.get(id)?.type === engine.capacity!.protocol
        )
      ? engine.capacity.reserve()
      : undefined;
    try {
      return deps.persistence.changeMemberships(() => {
        const previous = new Set(
          deps.outputs.list().filter((row) =>
            outputPlayerId(row) === id || ids.includes(row.id)
          ).map(outputPlayerId).filter((id): id is number => id !== null),
        );
        previous.add(id);
        if (!deps.outputs.setMembers(id, ids, source)) return false;
        for (const owner of previous) {
          const engine = engines.get(owner);
          if (
            engine && !engine.disposing && !members(owner).length &&
            engine.playback.playerView().state === 'play'
          ) {
            engine.playback.pause({
              kind: 'internal',
              via: 'playback-target-loss',
            });
          }
          if (engine && !engine.disposing) engine.playback.checkpoint();
        }
        return true;
      });
    } finally {
      reservation?.release();
    }
  };
  const defaultOutputs = {
    list: () => playerOutputs(deps.outputs, defaultEngine().row.id).list(),
    get: (id: string) =>
      playerOutputs(deps.outputs, defaultEngine().row.id).get(id),
    setEnabled: (ids: string[], source?: CommandSource) =>
      mutate(() => changeMembers(defaultEngine().row.id, ids, source)),
    toggle: (id: string, source?: CommandSource) =>
      mutate(async () => {
        const owner = defaultEngine().row.id;
        const row = deps.outputs.get(id);
        if (!row) return null;
        const ids = members(owner).map((row) => row.id).filter((member) =>
          member !== id
        );
        if (outputPlayerId(row) !== owner) ids.push(id);
        if (!await changeMembers(owner, ids, source)) return null;
        return playerOutputs(deps.outputs, owner).get(id);
      }),
    update: (
      id: string,
      opts: Parameters<Outputs['update']>[1],
      source?: CommandSource,
    ) =>
      mutate(async () => {
        const owner = defaultEngine().row.id;
        if (!deps.outputs.get(id)) return null;
        if (opts.selected !== undefined) {
          const ids = members(owner).map((row) => row.id).filter((member) =>
            member !== id
          );
          if (opts.selected) ids.push(id);
          if (!await changeMembers(owner, ids, source)) return null;
        }
        const { selected: _selected, ...preferences } = opts;
        if (Object.keys(preferences).length) {
          if (!deps.outputs.update(id, preferences, source)) return null;
        }
        return playerOutputs(deps.outputs, owner).get(id);
      }),
  };
  const playback: Playback = {
    reportPlaying: deps.reports.reportPlaying,
    reportStopped: deps.reports.reportStopped,
    reportPlayback: deps.reports.reportPlayback,
    reportSessionPlayback: deps.reports.reportSessionPlayback,
    nowPlayingView: deps.reports.nowPlayingView,
    expireReports: deps.reports.expireReports,
    startReportExpiry: deps.reports.startReportExpiry,
    play: (...args) => current().play(...args),
    pause: (...args) => current().pause(...args),
    stop: (...args) => current().stop(...args),
    toggle: (...args) => current().toggle(...args),
    next: (...args) => current().next(...args),
    previous: (...args) => current().previous(...args),
    restart: (...args) => current().restart(...args),
    setShuffle: (...args) => current().setShuffle(...args),
    setConsume: (...args) => current().setConsume(...args),
    setRepeat: (...args) => current().setRepeat(...args),
    setVolume: (...args) => current().setVolume(...args),
    seek: (...args) => current().seek(...args),
    queueAdd: (...args) => current().queueAdd(...args),
    queueAddSources: (...args) => current().queueAddSources(...args),
    queueAddReferences: (...args) => current().queueAddReferences(...args),
    queueClear: (...args) => current().queueClear(...args),
    queueRemove: (...args) => current().queueRemove(...args),
    queueMove: (...args) => current().queueMove(...args),
    queueCopyView: () => current().queueCopyView(),
    queueCopied: (...args) => current().queueCopied(...args),
    queueImport: (...args) => current().queueImport(...args),
    advanceEnded: () => current().advanceEnded(),
    openSource: (...args) => current().openSource(...args),
    cancelSource: (...args) => current().cancelSource(...args),
    sourceAudio: (...args) => current().sourceAudio(...args),
    retrySource: (...args) => current().retrySource(...args),
    reportSourceOutcome: (...args) => current().reportSourceOutcome(...args),
    reportSourceMetadata: (...args) => current().reportSourceMetadata(...args),
    restore: (...args) => current().restore(...args),
    playerView: () => current().playerView(),
    queueView: () => current().queueView(),
    queuePageView: (options) => current().queuePageView(options),
    serverNowPlayingView: () => current().serverNowPlayingView(),
    lastCommand: () => current().lastCommand(),
    checkpoint: () => current().checkpoint(),
    close: () => current().close(),
  };
  const registry = {
    playback,
    defaultOutputs,
    freeSpeakers: () =>
      deps.outputs.list().filter((row) => outputPlayerId(row) === null),
    members: (id: number) => {
      requireEngine(id);
      return members(id);
    },
    setSpeakers: (id: number, ids: string[], source?: CommandSource) =>
      mutate(() => changeMembers(id, ids, source)),
    join: (id: number, speakerId: string, source?: CommandSource) =>
      mutate(async () => {
        requireEngine(id);
        if (!deps.outputs.get(speakerId)) {
          throw new SpeakerError('not_found', 'Speaker not found');
        }
        if (
          !await changeMembers(id, [
            ...new Set([...members(id).map((row) => row.id), speakerId]),
          ], source)
        ) {
          throw new SpeakerError(
            'speaker_busy',
            'Speaker membership is unavailable',
          );
        }
      }),
    leave: (id: number, speakerId: string, source?: CommandSource) =>
      mutate(async () => {
        requireEngine(id);
        if (!deps.outputs.get(speakerId)) {
          throw new SpeakerError('not_found', 'Speaker not found');
        }
        if (
          !await changeMembers(
            id,
            members(id).map((row) => row.id).filter((member) =>
              member !== speakerId
            ),
            source,
          )
        ) {
          throw new SpeakerError(
            'speaker_busy',
            'Speaker membership is unavailable',
          );
        }
      }),
    list: () =>
      [...engines.values()].filter((e) => !e.disposing).map((e) => ({
        ...e.row,
      })),
    get: (id: number) => requireEngine(id).playback,
    copyQueue: (
      id: number,
      targetId: number,
      opts: QueueCopyOptions,
      source?: CommandSource,
    ) =>
      mutate(async () => {
        const from = requireEngine(id).playback;
        const to = requireEngine(targetId).playback;
        if (id === targetId) {
          throw new PlayerError('same_player', 'Choose another player');
        }
        await to.queueImport(from.queueCopyView(), opts, source, (change) =>
          deps.persistence.changePlayers(() => {
            change();
            from.queueCopied(targetId, source);
          }));
      }),
    defaultId: () => defaultEngine().row.id,
    serverRows: () =>
      [...engines.values()].filter((e) => !e.disposing).flatMap((engine) => {
        const row = engine.playback.serverNowPlayingView();
        return row ? [row] : [];
      }),
    bootForSpeaker(id: string): PlayerBoot {
      const row = deps.outputs.get(id);
      const owner = row ? outputPlayerId(row) : null;
      const engine = owner === null ? defaultEngine() : requireEngine(owner);
      if (!engine.boot) throw new Error('Speaker boot unavailable');
      return engine.boot;
    },
    create: (name: string) =>
      mutate(async () => {
        name = nameFor(name);
        const row = await deps.store.players.create(name);
        const engine = add(row);
        start(engine);
        changed(row.id);
        return { ...row };
      }),
    rename: (id: number, name: string) =>
      mutate(async () => {
        const engine = requireEngine(id);
        name = nameFor(name, id);
        await deps.store.players.rename(id, name);
        engine.row.name = name;
        changed(id);
        deps.notify.emit(['nowPlaying'], undefined, 'all');
      }),
    setDefault: (id: number) =>
      mutate(async () => {
        requireEngine(id);
        await deps.store.players.setDefault(id);
        for (const engine of engines.values()) {
          engine.row.isDefault = engine.row.id === id;
        }
        changed(id);
        deps.notify.emit(
          ['player', 'queue', 'volume', 'options'],
          Object.fromEntries(
            ['player', 'queue', 'volume', 'options'].map((
              key,
            ) => [key, [String(id)]]),
          ),
          'all',
        );
      }),
    delete: (id: number) =>
      mutate(async () => {
        const engine = requireEngine(id);
        if (engines.size === 1) {
          throw new PlayerError('last_player', 'Cannot delete the last player');
        }
        if (engine.row.isDefault) {
          throw new PlayerError(
            'default_player',
            'Cannot delete the default player',
          );
        }
        await deps.persistence.drain();
        await deps.store.players.delete(id);
        engine.persistence.retire();
        await dispose(engine);
        engines.delete(id);
        // The durable delete frees members in the same transaction as the queue.
        // Publish the corresponding runtime release only after it commits.
        await deps.persistence.changeMemberships(() =>
          deps.outputs.setMembers(id, [], {
            kind: 'internal',
            via: 'player-delete',
          })
        );
        changed(id);
        deps.notify.emit(['outputs', 'nowPlaying'], undefined, 'all');
        await deps.persistence.drain();
      }),
    close(): Promise<void> {
      if (closeWork) return closeWork;
      closed = true;
      closeWork = (async () => {
        await tail;
        await Promise.all([...engines.values()].map(dispose));
        engines.clear();
      })();
      return closeWork;
    },
  };
  return registry;
}

export type Players = Awaited<ReturnType<typeof createPlayers>>;
