// Household registry and engine lifecycle. The store owns durable identities;
// each engine owns its commands, clock, queue, source and persistence port.
import type { Store } from './store/index.ts';
import type { StoredPlayer } from './store/players.ts';
import type { EnginePersistence, Persistence } from './persistence.ts';
import { createPlayer, type Outputs, planRestore } from './player.ts';
import { createPlayback, type Playback } from './playback.ts';
import type { PlaybackReports } from './playback-reports.ts';
import type { SpeakerPairingView } from './speakers.ts';
import { outputPlayerId, playerOutputs } from './player-outputs.ts';
import type { Notify } from './notify.ts';
import { scopedLog } from './logging.ts';

export class PlayerError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'invalid_name'
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
    >
    & {
      resolveQueueReference: NonNullable<
        Parameters<typeof createPlayback>[0]['resolveQueueReference']
      >;
    };
  targets?(
    playerId: number,
  ): NonNullable<Parameters<typeof createPlayback>[0]['targets']>;
  createBoot?(
    playerId: number,
    playback: Playback,
    outputs: Outputs,
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
    const playback = createPlayback({
      ...deps.playback,
      playerId: row.id,
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
      notify: deps.notify,
    });
    const engine = { row, playback, outputs, persistence, disposing: false };
    engines.set(row.id, engine);
    return engine;
  };
  const start = (engine: Engine) => {
    engine.boot = deps.createBoot?.(
      engine.row.id,
      engine.playback,
      engine.outputs,
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
    for (const engine of engines.values()) {
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
        await engine.playback.restore(snapshot);
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
    setShuffle: (...args) => current().setShuffle(...args),
    setConsume: (...args) => current().setConsume(...args),
    setRepeat: (...args) => current().setRepeat(...args),
    setVolume: (...args) => current().setVolume(...args),
    seek: (...args) => current().seek(...args),
    queueAdd: (...args) => current().queueAdd(...args),
    queueAddSources: (...args) => current().queueAddSources(...args),
    queueAddReferences: (...args) => current().queueAddReferences(...args),
    queueClear: (...args) => current().queueClear(...args),
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
    serverNowPlayingView: () => current().serverNowPlayingView(),
    lastCommand: () => current().lastCommand(),
    close: () => current().close(),
  };
  const registry = {
    playback,
    list: () =>
      [...engines.values()].filter((e) => !e.disposing).map((e) => ({
        ...e.row,
      })),
    get: (id: number) => requireEngine(id).playback,
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
        await dispose(engine);
        await deps.persistence.drain();
        await deps.store.players.delete(id);
        engines.delete(id);
        // The durable delete frees members in the same transaction as the queue.
        // Publish the corresponding runtime release only after it commits.
        for (const row of deps.outputs.list()) {
          if (outputPlayerId(row) === id) {
            deps.outputs.update(row.id, { selected: false }, {
              kind: 'internal',
              via: 'player-delete',
            });
          }
        }
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
