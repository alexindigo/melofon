import type { Store } from './store/index.ts';
import type { State } from './state.ts';
import {
  type CoreNetworkAuthority,
  createNetwork,
  type LookupNetwork,
} from './lookups/net.ts';
import { parsePodcastFeed } from './podcast-feed.ts';
import { scopedLog } from './logging.ts';

export interface PodcastClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}
export async function createPodcasts(
  options: {
    store: Store;
    state: State;
    network?: LookupNetwork;
    clock?: PodcastClock;
  },
) {
  const { store, state } = options;
  const log = scopedLog('podcasts');
  const network = options.network ?? createNetwork({ state });
  const clock: PodcastClock = options.clock ?? {
    now: Date.now,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => clearTimeout(timer as number),
  };
  state.declare('podcasts.refreshHours', {
    type: 'number',
    default: 24,
    minimum: 0.001,
    maximum: 8760,
  });
  state.declare('podcasts.maxFeedMegabytes', {
    type: 'number',
    default: 10,
    minimum: 0.001,
    maximum: 200,
  });
  state.declare('podcasts.requestTimeoutSeconds', {
    type: 'number',
    default: 60,
    minimum: 0.001,
    maximum: 600,
  });
  state.declare('podcasts.requestsPerMinute', {
    type: 'number',
    default: 60,
    minimum: 1,
    maximum: 600000,
  });
  const shutdown = new AbortController();
  let closed = false;
  let timer: unknown;
  let tail: Promise<unknown> = Promise.resolve();
  const scheduledError = (error: unknown) => {
    if (!closed) log.event('podcast_failed', { error });
  };
  const numeric = async (key: string) =>
    Number(await state.getTyped(`podcasts.${key}`));
  const interval = async () => await numeric('refreshHours') * 3600000;
  // Refresh and deletion share one lifecycle queue. Parsing/I/O never holds a
  // store slot, and deletion cannot race a refresh into resurrecting rows.
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const task = tail.then(() => {
      if (closed) throw new Error('Podcasts closed');
      return work();
    });
    tail = task.catch(() => {});
    return task;
  };
  async function refreshOne(id: string) {
    const channel = await store.podcasts.channel(id);
    if (!channel) return null;
    try {
      const authority: CoreNetworkAuthority = {
        caller: 'core.podcasts',
        // An admin-approved feed may redirect/CDN across public HTTP hosts.
        // The network owner checks actual destinations independently.
        hosts: (url) => ['http:', 'https:'].includes(url.protocol),
        ratePerMinute: await numeric('requestsPerMinute'),
        signal: shutdown.signal,
      };
      const response = await network.fetch(authority, channel.feedUrl, {}, {
        timeoutMs: await numeric('requestTimeoutSeconds') * 1000,
        maxBytes: await numeric('maxFeedMegabytes') * 1024 * 1024,
      });
      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status} ${response.statusText}`.trim(),
        );
      }
      const feed = parsePodcastFeed(await response.text(), channel.feedUrl);
      return await store.podcasts.saveFeed(id, feed, clock.now());
    } catch (error) {
      if (closed) return null;
      return await store.podcasts.fail(
        id,
        error instanceof Error ? error.message : String(error),
        clock.now(),
      );
    }
  }
  async function schedule() {
    clock.clearTimeout(timer);
    if (closed) return;
    const rows = await store.podcasts.channels();
    if (closed || !rows.length) return;
    const period = await interval();
    const due = Math.min(
      ...rows.map((row) =>
        (row.lastRefreshMs ?? clock.now() - period) + period
      ),
    );
    // Native timers are signed 32-bit; long intervals are scheduled in chunks.
    timer = clock.setTimeout(() => {
      void serial(refreshDue).catch(scheduledError);
    }, Math.min(2147483647, Math.max(0, due - clock.now())));
  }
  async function refreshDue() {
    const period = await interval();
    for (const row of await store.podcasts.channels()) {
      if (closed) break;
      if (
        row.lastRefreshMs === null || row.lastRefreshMs + period <= clock.now()
      ) await refreshOne(row.id);
    }
    await schedule();
  }
  const unsubscribe = state.onChange((key) => {
    if (key === 'podcasts.refreshHours') {
      void serial(refreshDue).catch(scheduledError);
    }
  });
  await serial(refreshDue);
  return {
    async addChannel(input: string) {
      const url = new URL(input);
      if (
        !['http:', 'https:'].includes(url.protocol) || url.username ||
        url.password
      ) throw new Error('Feed must be an absolute http or https URL');
      url.hash = '';
      return await serial(async () => {
        const row = await store.podcasts.add(url.href);
        const refreshed = await refreshOne(row.id);
        await schedule();
        return refreshed!;
      });
    },
    deleteChannel: (id: string) =>
      serial(async () => {
        const deleted = await store.podcasts.delete(id);
        await schedule();
        return deleted;
      }),
    refresh: (id?: string) =>
      serial(async () => {
        const rows = id
          ? [id]
          : (await store.podcasts.channels()).map((row) => row.id);
        for (const key of rows) await refreshOne(key);
        await schedule();
      }),
    channels: store.podcasts.channels,
    episodes: store.podcasts.episodes,
    newest(count: number) {
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error('Invalid episode count');
      }
      return store.podcasts.newest(count);
    },
    episode: store.podcasts.episode,
    /** Lifecycle/test drain, including the scheduled work already enqueued. */
    idle: () => tail,
    async close() {
      closed = true;
      clock.clearTimeout(timer);
      unsubscribe();
      shutdown.abort(new Error('Podcasts closed'));
      await tail;
      // In-flight work can finish scheduling after close's first timer clear.
      // Drain the lifecycle queue before releasing its last owned timer.
      clock.clearTimeout(timer);
    },
  };
}
