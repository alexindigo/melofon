// Artwork owns reusable source facts; selection/authorization stays with each owner.
import { stat } from 'node:fs/promises';
import { imageHash } from './images.ts';
import { imageHeader } from './image-header.ts';
import type { Store } from './store/index.ts';
import type { ArtworkSourceFacts } from './store/artwork.ts';
import type { createArtworkCache } from './artwork-cache.ts';

export interface ArtworkImage {
  bytes: Uint8Array;
  format: string;
  facts?: ArtworkSourceFacts;
}
export type ReadArtworkSource = (
  path: string,
  kind: string,
  load: () => Promise<ArtworkImage | null>,
) => Promise<ArtworkImage | null>;

async function signature(path: string): Promise<string | null> {
  try {
    let s = await stat(path, { bigint: true });
    // Deno 2.9.6 truncates ctime to seconds, including Node's ctimeNs shim.
    // Close that observation window before trusting a signature. Otherwise an
    // in-place same-size edit restoring mtime could alias the previous content.
    const settle = Number(s.ctimeMs) + 1000 - Date.now();
    if (settle > 0 && settle <= 1000) {
      await new Promise((resolve) => setTimeout(resolve, settle));
      s = await stat(path, { bigint: true });
    }
    if (Number(s.ctimeMs) + 1000 > Date.now()) return null;
    return s.isFile()
      ? `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
      : null;
  } catch {
    return null;
  }
}

export function createArtworkSources(
  store: Store['artwork'] | undefined,
  cache: ReturnType<typeof createArtworkCache>,
  limit: () => Promise<number>,
) {
  async function load(
    key: string,
    stamp: string | null,
    read: () => Promise<ArtworkImage | null>,
    valid: () => Promise<boolean>,
    cacheMissing = true,
  ): Promise<ArtworkImage | null> {
    const previous = stamp === null ? null : await store?.get(key);
    if (previous && previous.signature === stamp) {
      if (!previous.facts) {
        if (await valid()) return null;
      } else {
        const bytes = await cache.get(
          `${previous.facts.sourceHash}.png`,
          await limit(),
        );
        if (
          bytes && bytes.length === previous.facts.byteLength && await valid()
        ) {
          return {
            bytes,
            format: previous.facts.format,
            facts: previous.facts,
          };
        }
      }
    }
    const image = await read();
    const header = image && imageHeader(image.bytes);
    const facts = image
      ? {
        sourceHash: await imageHash(image.bytes),
        width: header?.width ?? null,
        height: header?.height ?? null,
        format: image.format,
        byteLength: image.bytes.length,
      }
      : null;
    // Never bind a read racing a replacement to the replacement's stat signature.
    if (store && stamp !== null && (image || cacheMissing) && await valid()) {
      if (image && facts) {
        await cache.put(`${facts.sourceHash}.png`, image.bytes, await limit());
      }
      await store.put(key, stamp, facts);
    }
    return image && { ...image, facts: facts! };
  }
  return {
    file(maxBytes: number): ReadArtworkSource {
      return async (path, kind, read) => {
        if (!store) {
          return await load('', null, read, () => Promise.resolve(false));
        }
        const before = await signature(path);
        return await load(
          `${kind}:${path}`,
          before === null ? null : `${maxBytes}:${before}`,
          read,
          async () => before === await signature(path),
        );
      };
    },
    generated(
      key: string,
      stamp: string,
      read: () => Promise<ArtworkImage | null>,
    ) {
      return load(key, stamp, read, () => Promise.resolve(true), false);
    },
  };
}
