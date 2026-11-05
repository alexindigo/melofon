// Shared station data validation. Protocol-specific write limits belong to hats.
import type { Store } from './store/index.ts';
import type { StationInput, StationRow } from './store/radio.ts';
import type { State } from './state.ts';
import { createImageFiles, ImageFileUnavailable } from './image-files.ts';
import { imageHeader, withinPixels } from './image-header.ts';
import { imagePixels } from './media.ts';
import type { Notify } from './notify.ts';
import { type Log, scopedLog } from './logging.ts';
import type { LookupNetwork } from './lookups/net.ts';

export type StationResult = StationRow | { invalid: string };

function validate(input: StationInput): StationInput | { invalid: string } {
  const name = input.name.trim();
  if (!name) return { invalid: 'Station name must not be empty' };
  for (const key of ['streamUrl', 'homePageUrl'] as const) {
    const value = input[key];
    if (value === null && key === 'homePageUrl') continue;
    try {
      const url = new URL(value!);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
        throw new Error();
      }
    } catch {
      return { invalid: `${key} must be an absolute http or https URL` };
    }
  }
  return { ...input, name };
}

export function createRadio(store: Store, options: {
  dataDir?: string;
  state?: Pick<State, 'declare' | 'getTyped'>;
  notify?: Notify;
  log?: Log;
  network?: Pick<LookupNetwork, 'fetch'>;
} = {}) {
  const log = options.log ?? scopedLog('radio');
  const defaults: Record<string, number> = {
    maxArtworkBytes: 20971520,
    maxArtworkPixels: 64000000,
    artworkTimeoutMs: 10000,
    artworkRequestsPerMinute: 60,
  };
  for (const [key, value] of Object.entries(defaults)) {
    options.state?.declare(`radio.${key}`, {
      type: 'integer',
      minimum: 1,
      default: value,
    });
  }
  const setting = async (key: string) =>
    Number(await options.state?.getTyped(`radio.${key}`) ?? defaults[key]);
  const files = options.dataDir
    ? createImageFiles(options.dataDir, 'radio-images', 'radio artwork')
    : undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let ready = false;
  const streams = new Map<string, AbortController>();
  const changed = (id: string) =>
    options.notify?.emit(['library'], { radioStations: [id] }, 'all');
  const revoke = (id: string) => {
    streams.get(id)?.abort();
    streams.delete(id);
  };
  // One owner orders file reads, publication and retirement. No file/native work
  // occurs in a store slot, and a reader cannot race retirement of its source.
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(async () => {
      if (!ready && files) {
        await files.prune(await store.radio.imagePayloads());
        ready = true;
      }
      return operation();
    });
    tail = result.catch(() => {});
    return result;
  }
  return {
    list: () => store.radio.list(),
    get: (id: string) => store.radio.get(id),
    artworkMaxBytes: () => setting('maxArtworkBytes'),
    cover(id: string, maxBytes: number) {
      return serial(async () => {
        const upload = await store.radio.artwork(id);
        if (upload === undefined) return 'unknown' as const;
        const payload = upload ?? await store.radio.streamArtwork(id);
        if (!payload || !files) return null;
        try {
          const image = await files.read(payload, maxBytes);
          return {
            bytes: image.value,
            format: image.contentType,
            sourceKind: upload
              ? 'radio-upload' as const
              : 'radio-stream' as const,
          };
        } catch (error) {
          if (!(error instanceof ImageFileUnavailable)) throw error;
          log.event('radio_artwork_unavailable', {
            station: id,
            reason: error.reason,
          });
          return null;
        }
      });
    },
    /** Only the elected source opens this capability. Metadata remains external
     * content: the entered station host is the entire private-address grant. */
    streamArtwork(id: string, streamUrl: string, signal: AbortSignal) {
      revoke(id);
      const generation = new AbortController();
      streams.set(id, generation);
      const lifetime = AbortSignal.any([signal, generation.signal]);
      let request: AbortController | undefined;
      let previous: string | null | undefined;
      const jobs = new Set<Promise<void>>();
      const publish = (bytes: Uint8Array | null, current: AbortSignal) =>
        serial(async () => {
          if (current.aborted || streams.get(id) !== generation) return;
          const station = await store.radio.get(id);
          if (!station || station.streamUrl !== streamUrl || current.aborted) {
            return;
          }
          const maxBytes = await setting('maxArtworkBytes');
          const maxPixels = await setting('maxArtworkPixels');
          if (bytes) {
            if (!withinPixels(imageHeader(bytes), maxPixels)) return;
            try {
              await imagePixels(bytes, 1, 1);
            } catch {
              return;
            }
          }
          if (current.aborted || !files) return;
          const payload = bytes
            ? await files.save(bytes, maxBytes, maxPixels)
            : null;
          // Cancellation may happen during native validation or durable file I/O.
          if (current.aborted || streams.get(id) !== generation) {
            if (payload) await files.retire(payload);
            return;
          }
          let result;
          try {
            result = await store.radio.setStreamArtwork(id, streamUrl, payload);
          } catch (error) {
            if (payload) await files.retire(payload);
            throw error;
          }
          if (!result) {
            if (payload) await files.retire(payload);
            return;
          }
          if (result.previous) await files.retire(result.previous);
          if (payload || result.previous) changed(id);
        });
      return {
        observe(value: string | null | undefined) {
          if (value === undefined || value === previous || lifetime.aborted) {
            return;
          }
          previous = value;
          request?.abort();
          request = new AbortController();
          const current = AbortSignal.any([lifetime, request.signal]);
          // Every new carrier retires the old cover before acquisition. Invalid,
          // absent or unavailable images reveal the deterministic name tile.
          const pending = (async () => {
            await publish(null, current);
            if (!value || !options.network || !files || current.aborted) return;
            let url: URL;
            try {
              url = new URL(value);
              if (
                !['http:', 'https:'].includes(url.protocol) || url.username ||
                url.password
              ) return;
            } catch {
              return;
            }
            const response = await options.network.fetch(
              {
                caller: 'core.radio-artwork',
                hosts: (url) => ['http:', 'https:'].includes(url.protocol),
                trustedHosts: [new URL(streamUrl).hostname],
                ratePerMinute: await setting('artworkRequestsPerMinute'),
                signal: current,
              },
              url.href,
              {},
              {
                timeoutMs: await setting('artworkTimeoutMs'),
                maxBytes: await setting('maxArtworkBytes'),
              },
            );
            if (!response.ok) return;
            const bytes = new Uint8Array(await response.arrayBuffer());
            const header = imageHeader(bytes);
            const mime = response.headers.get('content-type')?.split(';')[0]
              .trim().toLowerCase();
            if (!header || mime !== `image/${header.format}`) return;
            await publish(bytes, current);
          })().catch(() => {
            // Artwork is optional; failed external content never interrupts audio.
            // The preceding retirement has already exposed the name fallback.
          });
          jobs.add(pending);
          void pending.finally(() => jobs.delete(pending));
          return pending;
        },
        async close() {
          generation.abort();
          if (streams.get(id) === generation) streams.delete(id);
          await Promise.all(jobs);
        },
      };
    },
    async putArtwork(id: string, bytes: Uint8Array) {
      const maxBytes = await setting('maxArtworkBytes');
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes) {
        return { invalid: 'too_large' as const };
      }
      bytes = bytes.slice();
      return serial(async () => {
        if (!await store.radio.get(id)) return null;
        const maxPixels = await setting('maxArtworkPixels');
        if (!withinPixels(imageHeader(bytes), maxPixels)) {
          return { invalid: 'invalid_image' as const };
        }
        // Header admission alone does not prove a decodable image. Validate the
        // first frame with the existing in-process decoder before publication.
        try {
          await imagePixels(bytes, 1, 1);
        } catch {
          return { invalid: 'invalid_image' as const };
        }
        if (!files) {
          throw new Error('A data directory is required for radio artwork');
        }
        const payload = await files.save(bytes, maxBytes, maxPixels);
        let previous;
        try {
          previous = await store.radio.setArtwork(id, payload);
        } catch (error) {
          await files.retire(payload);
          throw error;
        }
        if (!previous) {
          await files.retire(payload);
          return null;
        }
        if (previous.previous) await files.retire(previous.previous);
        options.notify?.emit(['library'], { radioStations: [id] }, 'all');
        return { ok: true as const };
      });
    },
    removeArtwork(id: string) {
      return serial(async () => {
        const previous = await store.radio.setArtwork(id, null);
        if (!previous) return false;
        if (previous.previous && files) await files.retire(previous.previous);
        if (previous.previous) {
          options.notify?.emit(['library'], { radioStations: [id] }, 'all');
        }
        return true;
      });
    },
    async create(
      input: StationInput,
    ): Promise<StationResult> {
      const checked = validate(input);
      if ('invalid' in checked) return checked;
      return await store.radio.create(checked);
    },
    async update(
      id: string,
      input: StationInput,
    ): Promise<StationResult | null> {
      const checked = validate(input);
      if ('invalid' in checked) return checked;
      return await serial(async () => {
        const before = await store.radio.get(id);
        const moved = before && before.streamUrl !== checked.streamUrl;
        const old = moved ? await store.radio.streamArtwork(id) : null;
        if (moved) revoke(id);
        const updated = await store.radio.update(id, checked);
        if (updated && old && files) await files.retire(old);
        if (updated && old) changed(id);
        return updated;
      });
    },
    async delete(id: string): Promise<boolean> {
      return await serial(async () => {
        revoke(id);
        const payload = await store.radio.artwork(id);
        const stream = await store.radio.streamArtwork(id);
        const deleted = await store.radio.delete(id);
        if (deleted && payload && files) await files.retire(payload);
        if (deleted && stream && files) await files.retire(stream);
        return deleted;
      });
    },
  };
}
