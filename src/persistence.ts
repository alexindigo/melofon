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

export type { PersistedPlayerState } from './store/playback.ts';

export interface Persistence extends PlayerPersistence, OutputPersistence {
  /** Ordered occurrences, durable allocator and revision, without runtime facts. */
  loadQueue(): Promise<QueueSnapshot>;
  /** The singleton state row, or null when never persisted. */
  loadPlayerState(): Promise<PersistedPlayerState | null>;
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
  const enqueue = (write: () => Promise<void>): void => {
    tail = tail.then(write).catch((err) => {
      log.event('persistence_failed', { error: err });
    });
  };
  const outputCache = new Map<string, PersistedOutput>();
  const outputRevisions = new Map<string, number>();
  const ignored = new Set<string>();

  return {
    saveQueue(snapshot, state) {
      const copy = structuredClone(snapshot);
      enqueue(() => store.playback.saveQueue(copy, state));
    },

    saveState(snapshot) {
      enqueue(() => store.playback.saveState(snapshot));
    },

    loadQueue: () => store.playback.loadQueue(),

    loadPlayerState: () => store.playback.loadPlayerState(),

    saveOutput(row) {
      // Only explicit adoption (or an adopted row loaded at boot) authorizes
      // preferences to reach disk. A temporary selection cannot mint a row.
      if (!outputCache.has(row.id)) return;
      const connectionStrategy = requireConnectionStrategy(
        row.connectionStrategy ?? DEFAULT_CONNECTION_STRATEGY,
      );
      row = { ...row, connectionStrategy };
      outputCache.set(row.id, row);
      enqueue(() => store.playback.saveOutput({ ...row, connectionStrategy }));
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
      const write = credentials
        ? credentials.adopt(row.id, save, tail)
        : tail.then(() => save([]));
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
      outputCache.clear();
      for (const row of rows) outputCache.set(row.id, row);
      return rows;
    },

    savedOutput: (id) => outputCache.get(id),

    ignoredOutputs: () => [...ignored],

    async setOutputIgnored(id, value) {
      const write = tail.then(async () => {
        if (value) await store.speakers.saveIgnored(id);
        else await store.speakers.deleteIgnored(id);
        if (value) ignored.add(id);
        else ignored.delete(id);
      });
      tail = write.catch((error) => log.event('persistence_failed', { error }));
      await write;
    },

    drain: () => tail,
  };
}
