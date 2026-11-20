// src/persistence.ts — the store adapter for the player and outputs
// persistence ports. The engine is synchronous, so saves are fire-and-forget,
// serialized on one tail. Loads are awaited once at boot. drain() lets tests
// await the tail before closing and reopening the store.
import type { Store } from './store/index.ts';
import { type Log, scopedLog } from './logging.ts';
import {
  DEFAULT_CONNECTION_STRATEGY,
  requireConnectionStrategy,
} from './connection-strategy.ts';
import type {
  OutputPersistence,
  PersistedOutput,
  PlayerPersistence,
} from './player.ts';
import type { PersistedPlayerState } from './store/playback.ts';
import type { SpeakerCredentials } from './speaker-credentials.ts';
import type { QueueSnapshot } from './queue-source.ts';
import type { PlayerSave } from './store/players.ts';
import type { AdoptedSpeakerSnapshot } from './store/speakers.ts';
import type { State } from './state.ts';
import type { PublishedCommandPort } from './save-receipt.ts';
import { outputPlayerId } from './player-outputs.ts';

type CapturedPlayerSave = PlayerSave & { position?: Promise<number> };
// Capture all ordinary facts synchronously. Only the identified native cutoff
// remains pending; retries reuse its resolved value, never re-read live state.
const capturePlayer = (row: CapturedPlayerSave): Promise<PlayerSave> => {
  const { position, ...facts } = row;
  const copy = structuredClone(facts);
  const captured = position && copy.state
    ? position.then((positionMs) => ({
      ...copy,
      state: { ...copy.state!, positionMs },
    }))
    : Promise.resolve(copy);
  // The ordered writer may still be behind an older batch when this settles.
  // Retain rejection for that writer without an unhandled intermediate promise.
  void captured.catch(() => {});
  return captured;
};

export type { PersistedPlayerState } from './store/playback.ts';

export interface EnginePersistence extends PlayerPersistence {
  publishedCommands: PublishedCommandPort;
  /** Ordered occurrences, durable allocator and revision, without runtime facts. */
  loadQueue(): Promise<QueueSnapshot>;
  /** The player's state row, or null when never persisted. */
  loadPlayerState(): Promise<PersistedPlayerState | null>;
  drain(): Promise<void>;
  close(): Promise<void>;
  /** Successful deletion makes any queued snapshots obsolete, unlike shutdown. */
  retire(): void;
}

export interface Persistence extends PlayerPersistence, OutputPersistence {
  publishedCommands: PublishedCommandPort;
  loadQueue(): Promise<QueueSnapshot>;
  loadPlayerState(): Promise<PersistedPlayerState | null>;
  /** Engine ports share the household write tail, never the output cache. */
  forPlayer(playerId: number): EnginePersistence;
  /** Order durability-first deletion with every ordinary and captured save. */
  deletePlayer(playerId: number): Promise<void>;
  /** Compatibility facade for existing captured-publication callers. */
  changeMemberships<T>(change: () => T): Promise<T>;
  /** Compatibility facade; new consumers use publishedCommands. */
  changePlayers<T>(change: () => T): Promise<T>;
  /** Adopted output preferences only (also seeds the savedOutput cache). */
  loadOutputs(): Promise<PersistedOutput[]>;
  /** The last-known adopted row per output id, kept current by saveOutput.
   * Observations and temporary controls never enter this cache. */
  savedOutput(id: string): PersistedOutput | undefined;
  /** Await every queued write (tests: before closing/reopening the db). */
  drain(): Promise<void>;
  /** Unsaved published batches, without exposing private failure details. */
  health(): { pendingWrites: number };
  /** Reject publications and stop automatic retries, then drain accepted writes
   * with bounded shutdown retries. Exhaustion logs the batches lost on exit;
   * they remain retained for an explicit later close or drain. */
  close(): Promise<void>;
}

export function createPersistence(
  store: Store,
  log: Log = scopedLog('persistence'),
  credentials?: Pick<SpeakerCredentials, 'adopt'>,
  state?: Pick<State, 'declare' | 'getTyped' | 'onChange'>,
  timer = {
    set(callback: () => void, delay: number): { cancel(): void } {
      const handle = setTimeout(callback, delay);
      Deno.unrefTimer(handle);
      return { cancel: () => clearTimeout(handle) };
    },
  },
): Persistence {
  let tail: Promise<void> = Promise.resolve();
  let closed = false;
  let closeWork: Promise<void> | undefined;
  const requireOpen = () => {
    if (closed) throw new Error('Persistence is closed');
  };
  let retryTimer: { cancel(): void } | undefined;
  let retryEpoch = 0;
  let retryAttempt = 0;
  const retryKey = 'persistence.retryBackoffMs';
  const retryDefault = [1000, 2000, 5000, 30000];
  let backoff = retryDefault;
  const shutdownRetryKey = 'persistence.shutdownRetries';
  let shutdownRetries = 2;
  state?.declare(retryKey, {
    type: 'array',
    items: { type: 'integer', minimum: 1, maximum: 600000 },
    default: retryDefault,
    description:
      'Published save retry delays in ms; repeat the last delay until saved; empty uses defaults',
  });
  state?.declare(shutdownRetryKey, {
    type: 'integer',
    minimum: 0,
    default: shutdownRetries,
    description:
      'Extra attempts to save retained batches before shutdown; uses the retry backoff without repeating indefinitely',
  });
  let policyRevision = 0;
  const loadPolicy = async () => {
    const revision = ++policyRevision;
    try {
      const [delays, retries] = await Promise.all([
        state?.getTyped(retryKey),
        state?.getTyped(shutdownRetryKey),
      ]);
      if (revision === policyRevision) {
        if (Array.isArray(delays)) {
          backoff = delays.length ? delays as number[] : retryDefault;
        }
        if (typeof retries === 'number') shutdownRetries = retries;
      }
    } catch (error) {
      log.event('persistence_failed', { error });
    }
  };
  const unsubscribe = state?.onChange((key) => {
    if (key === retryKey || key === shutdownRetryKey) policyWork = loadPolicy();
  });
  let policyWork = state ? loadPolicy() : Promise.resolve();
  // Includes published batches still waiting to enter the retry queue on tail.
  let acceptedWrites = 0;
  const pendingWrites: {
    save(): Promise<void>;
    target: string;
    saved(): void;
  }[] = [];
  const cancelRetry = () => {
    retryEpoch++;
    retryTimer?.cancel();
    retryTimer = undefined;
  };
  const scheduleRetry = () => {
    if (closed || retryTimer !== undefined || !pendingWrites.length) return;
    const delay = backoff[Math.min(retryAttempt++, backoff.length - 1)];
    const epoch = ++retryEpoch;
    retryTimer = timer.set(() => {
      if (epoch !== retryEpoch || closed) return;
      retryTimer = undefined;
      void drain().catch(() => {});
    }, delay);
  };
  const retryWrites = async () => {
    cancelRetry();
    while (pendingWrites.length) {
      await pendingWrites[0].save();
      const batch = pendingWrites.shift()!;
      acceptedWrites--;
      retryAttempt = 0;
      batch.saved();
    }
  };
  const observe = (write: Promise<void>) => {
    tail = write.catch((error) => log.event('persistence_failed', { error }))
      .finally(scheduleRetry);
  };
  const drain = () => {
    const write = tail.then(retryWrites);
    observe(write);
    return write;
  };
  const admit = () => {
    requireOpen();
    acceptedWrites++;
    return Promise.withResolvers<void>();
  };
  const enqueue = (
    write: () => Promise<void>,
    target: string,
    receipt = admit(),
  ) => {
    const work = tail.then(async () => {
      // Published intent succeeds independently of storage. Retain every whole
      // batch behind its predecessors; this owner wakes itself when idle.
      pendingWrites.push({ save: write, target, saved: receipt.resolve });
      await retryWrites();
    });
    observe(work);
    return { attempted: tail, saved: receipt.promise };
  };
  const outputCache = new Map<string, PersistedOutput>();
  // Changed only on the household tail. Successful deletion obsoletes player
  // snapshots and membership references, not the rest of a published batch.
  const deletedPlayers = new Set<number>();
  const survivingOutput = <
    T extends Pick<PersistedOutput, 'playerId' | 'selected' | 'linked'>,
  >(row: T): T => {
    const playerId = outputPlayerId(row);
    return playerId !== null && deletedPlayers.has(playerId)
      ? { ...row, selected: false, playerId: null, linked: true }
      : row;
  };
  const saveChanges = (changes: {
    players: PlayerSave[];
    outputs: AdoptedSpeakerSnapshot[];
  }) =>
    store.players.saveChanges({
      players: changes.players.filter((row) =>
        !deletedPlayers.has(row.playerId)
      ),
      outputs: changes.outputs.map(survivingOutput),
    });
  const outputRevisions = new Map<string, number>();
  const ignored = new Set<string>();
  let publication: {
    players: Map<number, CapturedPlayerSave>;
    outputs: Map<string, AdoptedSpeakerSnapshot>;
  } | undefined;
  const playerTarget = (row: PlayerSave) =>
    `${row.playerId}(${
      Object.keys(row).filter((key) => key !== 'playerId').sort().join(',')
    })`;
  const savePlayer = (row: CapturedPlayerSave, save = enqueue) => {
    if (publication) {
      publication.players.set(row.playerId, {
        ...publication.players.get(row.playerId),
        ...row,
      });
    } else {
      requireOpen();
      const captured = capturePlayer(row);
      save(
        async () => store.players.saveChanges({ players: [await captured] }),
        `player:${playerTarget(row)}`,
      );
    }
  };
  const forPlayer = (playerId: number): EnginePersistence => {
    let active = true;
    let retired = false;
    const save = (write: () => Promise<void>, target: string) =>
      enqueue(async () => {
        if (retired || deletedPlayers.has(playerId)) return;
        try {
          await write();
        } catch (error) {
          // A write queued behind the successful durable delete may already be
          // inside the store lane. It no longer has a player to persist or retry.
          if (!retired) throw error;
        }
      }, target);
    return {
      saveQueue(snapshot, state, position) {
        if (!active) return;
        const copy = structuredClone(snapshot);
        if (publication) savePlayer({ playerId, queue: copy, state, position });
        else {
          const captured = capturePlayer({
            playerId,
            queue: copy,
            state,
            position,
          });
          save(
            async () =>
              store.playback.saveQueue(playerId, copy, (await captured).state!),
            `player:${playerId}:queue`,
          );
        }
      },
      saveState(snapshot, position) {
        if (!active) return;
        if (publication) {
          savePlayer({ playerId, state: structuredClone(snapshot), position });
        } else {
          const captured = capturePlayer({
            playerId,
            state: snapshot,
            position,
          });
          save(
            async () =>
              store.playback.saveState(playerId, (await captured).state!),
            `player:${playerId}:state`,
          );
        }
      },
      saveCommand(commandedAtMs) {
        if (active) {
          savePlayer({ playerId, commandedAtMs }, save);
        }
      },
      saveVolume(volume) {
        if (active) savePlayer({ playerId, volume }, save);
      },
      saveCrossfade(crossfadeMs) {
        if (active) savePlayer({ playerId, crossfadeMs }, save);
      },
      publishedCommands,
      changeVolume: async (change) =>
        await publishedCommands.publish(change).command,
      loadQueue: () => store.playback.loadQueue(playerId),
      loadPlayerState: () => store.playback.loadPlayerState(playerId),
      drain,
      async close() {
        active = false;
        await drain();
      },
      retire() {
        active = false;
        retired = true;
      },
    };
  };
  const publishedCommands: PublishedCommandPort = {
    publish<T>(change: () => T) {
      requireOpen();
      if (publication) throw new Error('Nested membership change');
      // Reserve before calling user code, including reentrant health/close.
      // Closing intake cannot turn an already-admitted publication into failure.
      const receipt = admit();
      const batch = {
        players: new Map<number, CapturedPlayerSave>(),
        outputs: new Map<string, AdoptedSpeakerSnapshot>(),
      };
      publication = batch;
      let value: T;
      try {
        value = change();
      } catch (error) {
        acceptedWrites--;
        throw error;
      } finally {
        publication = undefined;
      }
      // Capture without an await. Retried values cannot follow later mutation
      // of a caller's state object, nor replay any runtime command.
      const players = [...batch.players.values()].map(capturePlayer);
      const outputs = structuredClone([...batch.outputs.values()]);
      const save = enqueue(
        async () =>
          saveChanges({ players: await Promise.all(players), outputs }),
        `players:${
          [...batch.players.values()].map(playerTarget).join(',')
        } speakers:${outputs.map((row) => row.id).join(',')}`,
        receipt,
      );
      return { command: save.attempted.then(() => value), saved: save.saved };
    },
  };
  const home = forPlayer(1);
  const changePlayers = async <T>(change: () => T): Promise<T> =>
    await publishedCommands.publish(change).command;
  return {
    forPlayer,
    async deletePlayer(playerId) {
      requireOpen();
      const write = tail.then(async () => {
        await retryWrites();
        deletedPlayers.add(playerId);
        try {
          await store.players.delete(playerId);
        } catch (error) {
          deletedPlayers.delete(playerId);
          throw error;
        }
      });
      observe(write);
      await write;
    },
    publishedCommands,
    changeMemberships: changePlayers,
    changePlayers,
    saveQueue: home.saveQueue,
    saveState: home.saveState,
    saveVolume: home.saveVolume,
    saveCrossfade: home.saveCrossfade,
    changeVolume: home.changeVolume,
    loadQueue: home.loadQueue,
    loadPlayerState: home.loadPlayerState,

    saveOutput(row) {
      // A synchronous capture already owns admission, even if an observer
      // closes intake midway through its publication.
      if (!publication) requireOpen();
      // Only explicit adoption (or an adopted row loaded at boot) authorizes
      // preferences to reach disk. A temporary selection cannot mint a row.
      if (!outputCache.has(row.id)) return;
      const connectionStrategy = requireConnectionStrategy(
        row.connectionStrategy ?? DEFAULT_CONNECTION_STRATEGY,
      );
      row = { ...row, connectionStrategy };
      outputCache.set(row.id, row);
      if (publication) {
        publication.outputs.set(row.id, { ...row, connectionStrategy });
      } else {
        enqueue(
          () =>
            store.playback.saveOutput(
              survivingOutput({ ...row, connectionStrategy }),
            ),
          `speaker:${row.id}:preferences`,
        );
      }
    },

    async adoptOutput(row) {
      requireOpen();
      const revision = outputRevisions.get(row.id);
      const connectionStrategy = requireConnectionStrategy(
        row.connectionStrategy ?? DEFAULT_CONNECTION_STRATEGY,
      );
      const saved = { ...row, connectionStrategy };
      const save = async (
        records: Parameters<Store['speakers']['saveAdopted']>[1],
      ) => {
        const current = survivingOutput(saved);
        await store.speakers.saveAdopted(current, records);
        if (outputRevisions.get(row.id) === revision) {
          outputCache.set(row.id, current);
          ignored.delete(row.id);
        }
      };
      // Reserve the credential incarnation now, before an older queued write
      // can yield to unregister/re-registration of the same speaker id.
      const before = tail.then(retryWrites);
      const write = credentials
        ? credentials.adopt(row.id, save, before)
        : before.then(() => save([]));
      // Keep the serialization tail usable, but return the original rejection
      // to the explicit configuration caller. Publish only a durable cache.
      observe(write);
      await write;
    },

    async deleteOutput(id) {
      requireOpen();
      outputRevisions.set(id, (outputRevisions.get(id) ?? 0) + 1);
      outputCache.delete(id);
      // Previously queued writes finish before deletion; later temporary
      // updates cannot pass the cache gate. Forget is already published: retain
      // the whole credential/configuration delete for retry, never restore it.
      enqueue(async () => {
        await store.speakers.deleteAdopted(id);
      }, `speaker:${id}:forget`);
      await tail;
    },

    async loadOutputs() {
      const markers = await store.speakers.loadIgnored();
      ignored.clear();
      for (const id of markers) ignored.add(id);
      const rows = (await store.speakers.loadAdopted()).map((row) => ({
        ...row,
        connectionStrategy: requireConnectionStrategy(
          row.connectionStrategy ?? DEFAULT_CONNECTION_STRATEGY,
        ),
      }));
      const memberships = new Map(
        (await store.speakers.loadMemberships()).map((
          row,
        ) => [row.speakerId, row]),
      );
      outputCache.clear();
      for (const row of rows) {
        const membership = memberships.get(row.id);
        outputCache.set(row.id, {
          ...row,
          playerId: membership?.playerId ?? null,
          linked: membership?.linked ?? true,
        });
      }
      return rows;
    },

    savedOutput: (id) => outputCache.get(id),

    ignoredOutputs: () => [...ignored],

    async setOutputIgnored(id, value) {
      requireOpen();
      const write = tail.then(async () => {
        await retryWrites();
        if (value) await store.speakers.saveIgnored(id);
        else await store.speakers.deleteIgnored(id);
        if (value) ignored.add(id);
        else ignored.delete(id);
      });
      observe(write);
      await write;
    },

    drain,
    health: () => ({ pendingWrites: acceptedWrites }),
    close() {
      if (closeWork) return closeWork;
      if (!closed) {
        closed = true;
        cancelRetry();
        unsubscribe?.();
      }
      closeWork = policyWork.then(async () => {
        // Only this household owner can retry every accepted batch in order.
        // The caller keeps the store open until these finite attempts settle.
        for (let attempt = 0; attempt <= shutdownRetries; attempt++) {
          try {
            await drain();
            return;
          } catch (error) {
            if (attempt >= shutdownRetries) {
              log.event('persistence_shutdown_failed', {
                error,
                attempts: attempt + 1,
                pendingWrites: acceptedWrites,
                batches: pendingWrites.map((write) => write.target),
              });
              throw error;
            }
            const delay = backoff[Math.min(attempt, backoff.length - 1)];
            await new Promise<void>((resolve) => setTimeout(resolve, delay));
          }
        }
      }).catch((error) => {
        // Admission stays closed, but retained writes still belong to us.
        // Share each in-flight attempt; only a failed attempt may be retried.
        closeWork = undefined;
        throw error;
      });
      return closeWork;
    },
  };
}
