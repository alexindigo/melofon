import type { Store } from './store/index.ts';
import type { ReadArtworkSource } from './artwork-sources.ts';
import type { State } from './state.ts';
import {
  type CoreNetworkAuthority,
  createNetwork,
  type LookupNetwork,
} from './lookups/net.ts';
import { parsePodcastFeed } from './podcast-feed.ts';
import { scopedLog } from './logging.ts';
import { createMedia, type Media } from './media.ts';
import { createPodcastFiles } from './podcast-files.ts';
import { imageHeader } from './image-header.ts';
import { declareImageDownload, imageExtension } from './images.ts';
import type { PodcastEpisode } from './store/podcasts.ts';
import type { Notify } from './notify.ts';

export interface PodcastClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}
export async function createPodcasts(
  options: {
    store: Store;
    state: State;
    dataDir: string;
    media?: Pick<Media, 'probe'>;
    network?: LookupNetwork;
    clock?: PodcastClock;
    notify?: Notify;
  },
) {
  const { store, state } = options;
  const log = scopedLog('podcasts');
  const network = options.network ?? createNetwork({ state });
  const media = options.media ?? createMedia();
  const files = createPodcastFiles(options.dataDir);
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
  for (
    const [name, value] of Object.entries({
      autoDownloadNewest: 1,
      keepEpisodes: 0,
    })
  ) {
    state.declare(`podcasts.${name}`, {
      type: 'integer',
      default: value,
      minimum: 0,
    });
  }
  state.declare('podcasts.maxEpisodeMegabytes', {
    type: 'number',
    default: 1024,
    minimum: 0.001,
  });
  declareImageDownload(state);
  const shutdown = new AbortController();
  let closed = false;
  let timer: unknown;
  let tail: Promise<unknown> = Promise.resolve();
  let worker: Promise<void> | undefined;
  let wake = false;
  let active:
    | { episode: PodcastEpisode; controller: AbortController }
    | undefined;
  const scheduledError = (error: unknown) => {
    if (!closed) log.event('podcast_failed', { error });
  };
  const numeric = async (key: string) =>
    Number(await state.getTyped(`podcasts.${key}`));
  const interval = async () => await numeric('refreshHours') * 3600000;
  const authority = async (
    feedUrl: string,
    signal = shutdown.signal,
  ): Promise<CoreNetworkAuthority> => ({
    caller: 'core.podcasts',
    hosts: (url) => ['http:', 'https:'].includes(url.protocol),
    trustedHosts: [new URL(feedUrl).hostname],
    ratePerMinute: await numeric('requestsPerMinute'),
    signal,
  });
  const timeoutMs = async () => await numeric('requestTimeoutSeconds') * 1000;
  const view = (row: PodcastEpisode): PodcastEpisode & { streamId?: string } =>
    row.status === 'completed' ? { ...row, streamId: `stream-${row.id}` } : row;
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
  async function keep(channelId: string) {
    const count = await numeric('keepEpisodes');
    if (!count) return;
    const completed = (await store.podcasts.episodes(channelId)).filter((row) =>
      row.status === 'completed'
    );
    for (const row of completed.slice(count)) {
      await files.deleteEpisode(channelId, row.id, row.filePath);
      await store.podcasts.finish(row.id, { status: 'deleted' });
    }
  }
  function kick() {
    wake = true;
    if (worker || closed) return;
    worker = (async () => {
      while (!closed) {
        wake = false;
        const job = await serial(async () => {
          const row = (await store.podcasts.queued())[0];
          if (!row) return null;
          const controller = new AbortController();
          active = { episode: row, controller };
          return { row, controller };
        });
        if (!job) break;
        const { row, controller } = job;
        const signal = AbortSignal.any([shutdown.signal, controller.signal]);
        try {
          const channel = await store.podcasts.channel(row.channelId);
          if (!channel) throw new Error('Podcast channel no longer exists');
          const temporary = await serial(async () => {
            signal.throwIfAborted();
            const path = await files.path(row.channelId, row.id, 'download');
            await files.deleteEpisode(row.channelId, row.id, row.filePath);
            return path;
          });
          const downloaded = await network.toFile(
            await authority(channel.feedUrl, signal),
            row.enclosureUrl,
            temporary,
            {
              timeoutMs: await timeoutMs(),
              maxBytes: await numeric('maxEpisodeMegabytes') * 1024 * 1024,
            },
          );
          signal.throwIfAborted();
          const probe = await media.probe(temporary);
          if (!probe.hasAudio) {
            throw new Error('Podcast enclosure has no readable audio');
          }
          const types: Record<string, string> = {
            'audio/mpeg': 'mp3',
            'audio/mp4': 'm4a',
            'audio/aac': 'aac',
            'audio/ogg': 'ogg',
            'audio/opus': 'opus',
            'audio/flac': 'flac',
            'audio/wav': 'wav',
            'video/mp4': 'mp4',
            'audio/webm': 'webm',
          };
          const suffix = new URL(row.enclosureUrl).pathname.split('.').pop()
            ?.toLowerCase() ?? '';
          const ext = types[
            (downloaded.contentType ?? row.contentType ?? '').split(';')[0]
              .trim().toLowerCase()
          ] ??
            ([
                'mp3',
                'm4a',
                'aac',
                'ogg',
                'opus',
                'flac',
                'wav',
                'mp4',
                'webm',
              ].includes(suffix)
              ? suffix
              : 'bin');
          await serial(async () => {
            signal.throwIfAborted();
            if (
              (await store.podcasts.episode(row.id))?.status !== 'downloading'
            ) return;
            const path = await files.path(row.channelId, row.id, ext);
            await Deno.rename(temporary, path);
            await store.podcasts.finish(row.id, {
              status: 'completed',
              path,
              size: downloaded.size,
              duration: probe.durationMs === null
                ? null
                : probe.durationMs / 1000,
            });
            await keep(row.channelId);
          });
        } catch (error) {
          // Shutdown preserves persistent intent for the next process.
          if (!closed && !controller.signal.aborted) {
            await serial(async () => {
              if (
                (await store.podcasts.episode(row.id))?.status === 'downloading'
              ) {
                await store.podcasts.finish(row.id, {
                  status: 'error',
                  message: error instanceof Error
                    ? error.message
                    : String(error),
                });
              } else scheduledError(error);
            });
          }
        } finally {
          active = undefined;
          try {
            await files.cleanup(row.channelId, row.id);
          } catch (error) {
            scheduledError(error);
          }
        }
      }
    })().catch(scheduledError).finally(() => {
      worker = undefined;
      if (wake && !closed) kick();
    });
  }
  async function refreshImage(id: string) {
    const row = await store.podcasts.channel(id);
    if (!row?.imageUrl) return;
    const maxBytes = Number(await state.getTyped('lookups.imageMaxMegabytes')) *
      1024 * 1024;
    if (
      row.imageSourceUrl === row.imageUrl &&
      await files.image(id, row.imagePath, maxBytes)
    ) return;
    try {
      const response = await network.fetch(
        await authority(row.feedUrl),
        row.imageUrl,
        {},
        { timeoutMs: await timeoutMs(), maxBytes },
      );
      const type = response.headers.get('content-type')?.split(';')[0].trim()
        .toLowerCase();
      if (!response.ok || !type?.startsWith('image/')) {
        throw new Error('Podcast cover response is not an image');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const header = imageHeader(bytes);
      if (!header || !header.width || !header.height) {
        throw new Error('Podcast cover bytes are not an image');
      }
      const path = await files.saveImage(
        id,
        bytes,
        imageExtension(header.format),
      );
      await store.podcasts.image(id, path, row.imageUrl);
      options.notify?.emit(['library'], { podcasts: [id] }, 'all');
    } catch (error) {
      scheduledError(error);
    }
  }
  async function refreshOne(id: string) {
    const channel = await store.podcasts.channel(id);
    if (!channel) return null;
    try {
      const response = await network.fetch(
        await authority(channel.feedUrl),
        channel.feedUrl,
        {},
        {
          timeoutMs: await numeric('requestTimeoutSeconds') * 1000,
          maxBytes: await numeric('maxFeedMegabytes') * 1024 * 1024,
        },
      );
      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status} ${response.statusText}`.trim(),
        );
      }
      const feed = parsePodcastFeed(await response.text(), channel.feedUrl);
      await store.podcasts.saveFeed(id, feed, clock.now());
      await refreshImage(id);
      const count = await numeric('autoDownloadNewest');
      // Select the newest window first; do not walk back into old episodes
      // merely because a newer one was already downloaded or deleted.
      for (const row of (await store.podcasts.episodes(id)).slice(0, count)) {
        if (row.status === 'new') await store.podcasts.queue(row.id);
      }
      await keep(id);
      kick();
      return await store.podcasts.channel(id);
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
    if (key === 'podcasts.keepEpisodes') {
      void serial(async () => {
        for (const row of await store.podcasts.channels()) await keep(row.id);
      }).catch(scheduledError);
    }
  });
  await serial(refreshDue);
  kick();
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
    deleteChannel: (id: string) => {
      if (active?.episode.channelId === id) active.controller.abort();
      return serial(async () => {
        if (!await store.podcasts.channel(id)) return false;
        if (active?.episode.channelId === id) active.controller.abort();
        await files.deleteChannel(id);
        const deleted = await store.podcasts.delete(id);
        await schedule();
        return deleted;
      });
    },
    download: (id: string) =>
      serial(async () => {
        const row = await store.podcasts.queue(id);
        kick();
        return row ? view(row) : null;
      }),
    deleteEpisode: (id: string) => {
      if (active?.episode.id === id) active.controller.abort();
      return serial(async () => {
        const row = await store.podcasts.episode(id);
        if (!row) return false;
        if (active?.episode.id === id) active.controller.abort();
        await files.deleteEpisode(row.channelId, id, row.filePath);
        await store.podcasts.finish(id, { status: 'deleted' });
        return true;
      });
    },
    refresh: (id?: string) =>
      serial(async () => {
        const rows = id
          ? [id]
          : (await store.podcasts.channels()).map((row) => row.id);
        for (const key of rows) await refreshOne(key);
        await schedule();
      }),
    channels: store.podcasts.channels,
    episodes: async (id: string) =>
      (await store.podcasts.episodes(id)).map(view),
    async newest(count: number) {
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error('Invalid episode count');
      }
      return (await store.podcasts.newest(count)).map(view);
    },
    episode: async (id: string) => {
      const row = await store.podcasts.episode(id);
      return row ? view(row) : null;
    },
    async fileSource(id: string) {
      if (!id.startsWith('stream-episode-')) return null;
      const row = await store.podcasts.episode(id.slice(7));
      if (row?.status !== 'completed') return null;
      const path = await files.episodePath(row.channelId, row.id, row.filePath);
      return path ? { path, isVideo: false } : null;
    },
    async cover(id: string, maxBytes: number, read?: ReadArtworkSource) {
      if (!id.startsWith('podcast-')) return 'unknown' as const;
      const row = await store.podcasts.channel(id);
      return row
        ? files.image(id, row.imagePath, maxBytes, read)
        : 'unknown' as const;
    },
    /** Lifecycle/test drain, including the scheduled work already enqueued. */
    idle: async () => {
      for (;;) {
        const current = tail;
        await current;
        await worker;
        if (current === tail && !worker) return;
      }
    },
    async close() {
      closed = true;
      clock.clearTimeout(timer);
      unsubscribe();
      shutdown.abort(new Error('Podcasts closed'));
      await tail;
      await worker;
      // In-flight work can finish scheduling after close's first timer clear.
      // Drain the lifecycle queue before releasing its last owned timer.
      clock.clearTimeout(timer);
    },
  };
}
export type Podcasts = Awaited<ReturnType<typeof createPodcasts>>;
