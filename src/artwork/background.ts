import type { ArtworkService } from '../artwork.ts';
import type { Store } from '../store/index.ts';
import type { State } from '../state.ts';
import type { Notify } from '../notify.ts';
import { type Log, scopedLog } from '../logging.ts';
import { createArtworkFactsHost } from './facts-host.ts';

/** Owner changes coalesce into one sequential inventory. Requests only read facts;
 * no request starts, waits for, or owns background computation. */
export function createArtworkBackground(options: {
  artwork: ArtworkService;
  store: Store;
  state: State;
  notify: Notify;
  log?: Log;
  workerUrl?: URL;
  onComputing?: () => void;
}) {
  const { artwork, store } = options;
  const host = createArtworkFactsHost(
    options.state,
    options.workerUrl,
    options.onComputing,
  );
  const log = options.log ?? scopedLog('artwork');
  let closed = false;
  let dirty = false;
  let running: Promise<void> | undefined;
  async function inventory() {
    while (dirty && !closed) {
      dirty = false;
      const seen = new Set<string>();
      for (const ref of await store.artwork.references()) {
        if (closed) return;
        let sourceHash: string | undefined;
        try {
          const opts = { username: ref.username ?? undefined };
          const selected = await artwork.describe(ref, opts);
          if (selected.kind !== 'image' || closed) continue;
          sourceHash = selected.descriptor.sourceHash;
          if (seen.has(sourceHash)) continue;
          seen.add(sourceHash);
          if (await store.artwork.preview(sourceHash) || closed) continue;
          const pixels = await artwork.pixels(ref, { ...opts, size: 100 });
          if (
            pixels.kind !== 'pixels' ||
            pixels.descriptor.sourceHash !== sourceHash || closed
          ) continue;
          const value = await host.compute(pixels);
          if (closed) return;
          await store.artwork.savePreview(sourceHash, value);
        } catch (error) {
          if (!closed) log.event('artwork_facts_failed', { sourceHash, error });
        }
      }
    }
  }
  function refresh() {
    if (closed) return;
    dirty = true;
    if (running) return;
    running = inventory().catch((error) => {
      if (!closed) log.event('artwork_facts_failed', { error });
    }).finally(() => {
      running = undefined;
      if (dirty && !closed) refresh();
    });
  }
  const unsubscribe = options.notify.subscribe((types) => {
    // The scan publishes catalog invalidation before candidate reconciliation;
    // its existing database event also observes the completed acquisition pass.
    if (
      types.includes('library') || types.includes('database') ||
      types.includes('settings')
    ) refresh();
  });
  refresh();
  return {
    refresh,
    /** Core lifecycle/test synchronization only, never used by a hat. */
    async idle() {
      while (running) await running;
    },
    async close() {
      closed = true;
      dirty = false;
      unsubscribe();
      host.close();
      await running;
    },
  };
}
