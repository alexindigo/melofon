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

export type { PersistedPlayerState } from './store/playback.ts';

export interface Persistence extends PlayerPersistence, OutputPersistence {
  /** The persisted queue, pos-ordered library song ids. */
  loadQueue(): Promise<string[]>;
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
): Persistence {
  let tail: Promise<void> = Promise.resolve();
  const enqueue = (write: () => Promise<void>): void => {
    tail = tail.then(write).catch((err) => {
      log.event('persistence_failed', { error: err });
    });
  };
  const outputCache = new Map<string, PersistedOutput>();
  const outputRevisions = new Map<string, number>();

  return {
    saveQueue(songIds) {
      enqueue(() => store.playback.saveQueue(songIds));
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
      const write = tail.then(() => store.speakers.saveAdopted(saved));
      // Keep the serialization tail usable, but return the original rejection
      // to the explicit configuration caller. Publish only a durable cache.
      tail = write.catch((error) => log.event('persistence_failed', { error }));
      await write;
      if (outputRevisions.get(row.id) === revision) {
        outputCache.set(row.id, saved);
      }
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

    drain: () => tail,
  };
}
