// Shared station data validation. Protocol-specific write limits belong to hats.
import type { Store } from './store/index.ts';
import type { StationInput, StationRow } from './store/radio.ts';
import type { State } from './state.ts';
import { createImageFiles, ImageFileUnavailable } from './image-files.ts';
import { imageHeader, withinPixels } from './image-header.ts';
import { imagePixels } from './media.ts';
import type { Notify } from './notify.ts';
import { type Log, scopedLog } from './logging.ts';

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
} = {}) {
  const log = options.log ?? scopedLog('radio');
  const defaults: Record<string, number> = {
    maxArtworkBytes: 20971520,
    maxArtworkPixels: 64000000,
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
        const payload = await store.radio.artwork(id);
        if (payload === undefined) return 'unknown' as const;
        if (payload === null || !files) return null;
        try {
          const image = await files.read(payload, maxBytes);
          return { bytes: image.value, format: image.contentType };
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
      return await store.radio.update(id, checked);
    },
    async delete(id: string): Promise<boolean> {
      return await serial(async () => {
        const payload = await store.radio.artwork(id);
        const deleted = await store.radio.delete(id);
        if (deleted && payload && files) await files.retire(payload);
        return deleted;
      });
    },
  };
}
