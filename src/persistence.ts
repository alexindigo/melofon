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

export type { PersistedPlayerState } from './store/playback.ts';

export interface EnginePersistence extends PlayerPersistence {
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
  loadQueue(): Promise<QueueSnapshot>;
  loadPlayerState(): Promise<PersistedPlayerState | null>;
  /** Engine ports share the household write tail, never the output cache. */
  forPlayer(playerId: number): EnginePersistence;
  /** Capture a synchronous membership publication and its induced engine pauses
   * as one semantic store write, ordered with all other household writes. */
  changeMemberships<T>(change: () => T): Promise<T>;
  /** Capture a synchronous multi-player command in the same household transaction.
   * Once published, the command succeeds even if its queued save must retry. */
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
  /** Stop the household retry owner and drain before closing the store. */
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
  let retryTimer: { cancel(): void } | undefined;
  let retryEpoch = 0;
  let retryAttempt = 0;
  const retryKey = 'persistence.retryBackoffMs';
  const retryDefault = [1000, 2000, 5000, 30000];
  let backoff = retryDefault;
  state?.declare(retryKey, {
    type: 'array',
    items: { type: 'integer', minimum: 1, maximum: 600000 },
    default: retryDefault,
    description:
      'Published save retry delays in ms; repeat the last delay until saved; empty uses defaults',
  });
  let policyRevision = 0;
  const loadPolicy = async () => {
    const revision = ++policyRevision;
    try {
      const delays = await state?.getTyped(retryKey);
      if (!closed && revision === policyRevision && Array.isArray(delays)) {
        backoff = delays.length ? delays as number[] : retryDefault;
      }
    } catch (error) {
      log.event('persistence_failed', { error });
    }
  };
  const unsubscribe = state?.onChange((key) => {
    if (key === retryKey) policyWork = loadPolicy();
  });
  let policyWork = state ? loadPolicy() : Promise.resolve();
  const pendingWrites: (() => Promise<void>)[] = [];
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
      await pendingWrites[0]();
      pendingWrites.shift();
      retryAttempt = 0;
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
  const enqueue = (write: () => Promise<void>): void => {
    if (closed) return;
    const work = tail.then(async () => {
      // Published intent succeeds independently of storage. Retain every whole
      // batch behind its predecessors; this owner wakes itself when idle.
      pendingWrites.push(write);
      await retryWrites();
    });
    observe(work);
  };
  const outputCache = new Map<string, PersistedOutput>();
  const outputRevisions = new Map<string, number>();
  const ignored = new Set<string>();
  let membershipChange: {
    players: Map<number, PlayerSave>;
    outputs: Map<string, AdoptedSpeakerSnapshot>;
  } | undefined;
  const savePlayer = (row: PlayerSave, save = enqueue) => {
    if (membershipChange) {
      membershipChange.players.set(row.playerId, {
        ...membershipChange.players.get(row.playerId),
        ...row,
      });
    } else save(() => store.players.saveChanges({ players: [row] }));
  };
  const forPlayer = (playerId: number): EnginePersistence => {
    let active = true;
    let retired = false;
    const save = (write: () => Promise<void>) =>
      enqueue(async () => {
        if (retired) return;
        try {
          await write();
        } catch (error) {
          // A write queued behind the successful durable delete may already be
          // inside the store lane. It no longer has a player to persist or retry.
          if (!retired) throw error;
        }
      });
    return {
      saveQueue(snapshot, state) {
        if (!active) return;
        const copy = structuredClone(snapshot);
        if (membershipChange) savePlayer({ playerId, queue: copy, state });
        else save(() => store.playback.saveQueue(playerId, copy, state));
      },
      saveState(snapshot) {
        if (!active) return;
        if (membershipChange) {
          savePlayer({ playerId, state: structuredClone(snapshot) });
        } else save(() => store.playback.saveState(playerId, snapshot));
      },
      saveCommand(commandedAtMs) {
        if (active) {
          savePlayer({ playerId, commandedAtMs }, save);
        }
      },
      saveVolume(volume) {
        if (active) savePlayer({ playerId, volume }, save);
      },
      changeVolume: (change) => changePlayers(change),
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
    enqueue(commit);
    // The change is already published. A durable failure is logged and stays
    // in the ordered queue, not returned as a retryable command failure.
    await tail;
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
      if (closed) throw new Error('Persistence is closed');
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
      outputRevisions.set(id, (outputRevisions.get(id) ?? 0) + 1);
      outputCache.delete(id);
      // Previously queued writes finish before deletion; later temporary
      // updates cannot pass the cache gate. Forget is already published: retain
      // the whole credential/configuration delete for retry, never restore it.
      enqueue(async () => {
        await store.speakers.deleteAdopted(id);
      });
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
      if (closed) throw new Error('Persistence is closed');
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
    health: () => ({ pendingWrites: pendingWrites.length }),
    close() {
      if (closeWork) return closeWork;
      closed = true;
      cancelRetry();
      unsubscribe?.();
      closeWork = policyWork.then(drain);
      return closeWork;
    },
  };
}
