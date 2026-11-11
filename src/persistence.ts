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

export type { PersistedPlayerState } from './store/playback.ts';

export interface EnginePersistence extends PlayerPersistence {
  /** Ordered occurrences, durable allocator and revision, without runtime facts. */
  loadQueue(): Promise<QueueSnapshot>;
  /** The player's state row, or null when never persisted. */
  loadPlayerState(): Promise<PersistedPlayerState | null>;
  drain(): Promise<void>;
  close(): Promise<void>;
}

export interface Persistence extends PlayerPersistence, OutputPersistence {
  loadQueue(): Promise<QueueSnapshot>;
  loadPlayerState(): Promise<PersistedPlayerState | null>;
  /** Engine ports share the household write tail, never the output cache. */
  forPlayer(playerId: number): EnginePersistence;
  /** Capture a synchronous membership publication and its induced engine pauses
   * as one semantic store write, ordered with all other household writes. */
  changeMemberships<T>(change: () => T): Promise<T>;
  /** Capture a synchronous multi-player command in the same household transaction. */
  changePlayers<T>(change: () => T): Promise<T>;
  /** Adopted output preferences only (also seeds the savedOutput cache). */
  loadOutputs(): Promise<PersistedOutput[]>;
  /** The last-known adopted row per output id, kept current by saveOutput.
   * Observations and temporary controls never enter this cache. */
  savedOutput(id: string): PersistedOutput | undefined;
  /** Await every queued write (tests: before closing/reopening the db). */
  drain(): Promise<void>;
}

export function createPersistence(
  store: Store,
  log: Log = scopedLog('persistence'),
  credentials?: Pick<SpeakerCredentials, 'adopt'>,
): Persistence {
  let tail: Promise<void> = Promise.resolve();
  const pendingMembershipWrites: (() => Promise<void>)[] = [];
  const retryMembershipWrites = async () => {
    while (pendingMembershipWrites.length) {
      await pendingMembershipWrites[0]();
      pendingMembershipWrites.shift();
    }
  };
  const drain = () => {
    const write = tail.then(retryMembershipWrites);
    tail = write.catch((error) => log.event('persistence_failed', { error }));
    return write;
  };
  const enqueue = (write: () => Promise<void>): void => {
    tail = tail.then(async () => {
      await retryMembershipWrites();
      await write();
    }).catch((err) => {
      log.event('persistence_failed', { error: err });
    });
  };
  const outputCache = new Map<string, PersistedOutput>();
  const outputRevisions = new Map<string, number>();
  const ignored = new Set<string>();
  let membershipChange: {
    players: Map<number, PlayerSave>;
    outputs: Map<string, AdoptedSpeakerSnapshot>;
  } | undefined;
  const savePlayer = (row: PlayerSave) => {
    if (membershipChange) {
      membershipChange.players.set(row.playerId, {
        ...membershipChange.players.get(row.playerId),
        ...row,
      });
    } else enqueue(() => store.players.saveChanges({ players: [row] }));
  };
  const forPlayer = (playerId: number): EnginePersistence => {
    let active = true;
    return {
      saveQueue(snapshot, state) {
        if (!active) return;
        const copy = structuredClone(snapshot);
        if (membershipChange) savePlayer({ playerId, queue: copy, state });
        else enqueue(() => store.playback.saveQueue(playerId, copy, state));
      },
      saveState(snapshot) {
        if (!active) return;
        if (membershipChange) {
          savePlayer({ playerId, state: structuredClone(snapshot) });
        } else enqueue(() => store.playback.saveState(playerId, snapshot));
      },
      saveCommand(commandedAtMs) {
        if (active) {
          savePlayer({ playerId, commandedAtMs });
        }
      },
      saveVolume(volume) {
        if (active) savePlayer({ playerId, volume });
      },
      changeVolume: (change) => changePlayers(change),
      loadQueue: () => store.playback.loadQueue(playerId),
      loadPlayerState: () => store.playback.loadPlayerState(playerId),
      drain,
      async close() {
        active = false;
        await drain();
      },
    };
  };
  const home = forPlayer(1);

  const changePlayers = async <T>(change: () => T): Promise<T> => {
    if (membershipChange) throw new Error('Nested membership change');
    const batch = {
      players: new Map<number, PlayerSave>(),
      outputs: new Map<string, AdoptedSpeakerSnapshot>(),
    };
    membershipChange = batch;
    let result;
    try {
      result = change();
    } finally {
      membershipChange = undefined;
    }
    // Capture happens without an await: older snapshots finish first, and
    // subsequent preference/bookmark writes necessarily follow this commit.
    const commit = () =>
      store.players.saveChanges({
        players: [...batch.players.values()],
        outputs: [...batch.outputs.values()],
      });
    const write = tail.then(async () => {
      try {
        await retryMembershipWrites();
        await commit();
      } catch (error) {
        // Runtime keeps the requested intent, as with ordinary engine writes.
        // Never let a later output snapshot commit half of a failed transfer:
        // retry this whole transaction first, without rolling cache state back.
        pendingMembershipWrites.push(commit);
        throw error;
      }
    });
    tail = write.catch((error) => log.event('persistence_failed', { error }));
    await write;
    return result;
  };
  return {
    forPlayer,
    changeMemberships: changePlayers,
    changePlayers,
    saveQueue: home.saveQueue,
    saveState: home.saveState,
    saveVolume: home.saveVolume,
    changeVolume: home.changeVolume,
    loadQueue: home.loadQueue,
    loadPlayerState: home.loadPlayerState,

    saveOutput(row) {
      // Only explicit adoption (or an adopted row loaded at boot) authorizes
      // preferences to reach disk. A temporary selection cannot mint a row.
      if (!outputCache.has(row.id)) return;
      const connectionStrategy = requireConnectionStrategy(
        row.connectionStrategy ?? DEFAULT_CONNECTION_STRATEGY,
      );
      row = { ...row, connectionStrategy };
      outputCache.set(row.id, row);
      if (membershipChange) {
        membershipChange.outputs.set(row.id, { ...row, connectionStrategy });
      } else {enqueue(() =>
          store.playback.saveOutput({ ...row, connectionStrategy })
        );}
    },

    async adoptOutput(row) {
      const revision = outputRevisions.get(row.id);
      const connectionStrategy = requireConnectionStrategy(
        row.connectionStrategy ?? DEFAULT_CONNECTION_STRATEGY,
      );
      const saved = { ...row, connectionStrategy };
      const save = async (
        records: Parameters<Store['speakers']['saveAdopted']>[1],
      ) => {
        await store.speakers.saveAdopted(saved, records);
        if (outputRevisions.get(row.id) === revision) {
          outputCache.set(row.id, saved);
          ignored.delete(row.id);
        }
      };
      // Reserve the credential incarnation now, before an older queued write
      // can yield to unregister/re-registration of the same speaker id.
      const before = tail.then(retryMembershipWrites);
      const write = credentials
        ? credentials.adopt(row.id, save, before)
        : before.then(() => save([]));
      // Keep the serialization tail usable, but return the original rejection
      // to the explicit configuration caller. Publish only a durable cache.
      tail = write.catch((error) => log.event('persistence_failed', { error }));
      await write;
    },

    async deleteOutput(id) {
      const previous = outputCache.get(id);
      outputRevisions.set(id, (outputRevisions.get(id) ?? 0) + 1);
      outputCache.delete(id);
      // Previously queued writes finish before deletion; later temporary
      // updates cannot pass the cache gate. Explicit errors reach the caller.
      const write = tail.then(async () => {
        await retryMembershipWrites();
        await store.speakers.deleteAdopted(id);
      });
      tail = write.catch((error) => log.event('persistence_failed', { error }));
      try {
        await write;
      } catch (error) {
        if (previous) outputCache.set(id, previous);
        throw error;
      }
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
      const write = tail.then(async () => {
        await retryMembershipWrites();
        if (value) await store.speakers.saveIgnored(id);
        else await store.speakers.deleteIgnored(id);
        if (value) ignored.add(id);
        else ignored.delete(id);
      });
      tail = write.catch((error) => log.event('persistence_failed', { error }));
      await write;
    },

    drain,
  };
}
