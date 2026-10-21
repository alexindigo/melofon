// Core owns resolution, budgets, admission and disposable derived image bytes.
// Hats translate unknown/placeholder/image into their own protocol responses.
import { decodeBase64 } from '@std/encoding/base64';
import type { Library } from './library.ts';
import type { Playlists } from './playlists.ts';
import type { State } from './state.ts';
import { imageHash, readImage } from './images.ts';
import { imageHeader, withinPixels } from './image-header.ts';
import { animatedImage, playlistImage, resizeImage } from './media.ts';
import { createArtworkCache } from './artwork-cache.ts';

export type ArtworkResult = { kind: 'unknown' } | {
  kind: 'image' | 'placeholder';
  response: Response;
};
interface Options {
  size?: number;
  username?: string;
}
interface Image {
  bytes: Uint8Array;
  format: string;
}

export interface ArtworkService {
  /** A real artist photo, never the first-album artwork fallback. */
  hasArtistPhoto(id: string): Promise<boolean>;
  get(id: string, options?: Options): Promise<ArtworkResult>;
  /** HTTP-native convenience for OwnTone: unknown is 404, never error 70. */
  cover(id: string, options?: Options): Promise<Response>;
  /** The missing-cover tile, for callers with no cover concept (getAvatar). */
  placeholder(): Response;
}

// 128×128 solid gray PNG (generated with ffmpeg), the missing-cover tile.
const PLACEHOLDER_PNG = decodeBase64(
  'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAAACXBIWXMAAAABAAAAAQBPJcTWAAABL0lEQVR4nO3RQQ0AIAzAQEhQNf/CJuMe9BQ06Z2ZE+fpgN81AGsA1gCsAVgDsAZgDcAagDUAawDWAKwBWAOwBmANwBqANQBrANYArAFYA7AGYA3AGoA1AGsA1gCsAVgDsAZgDcAagDUAawDWAKwBWAOwBmANwBqANQBrANYArAFYA7AGYA3AGoA1AGsA1gCsAVgDsAZgDcAagDUAawDWAKwBWAOwBmANwBqANQBrANYArAFYA7AGYA3AGoA1AGsA1gCsAVgDsAZgDcAagDUAawDWAKwBWAOwBmANwBqANQBrANYArAFYA7AGYA3AGoA1AGsA1gCsAVgDsAZgC2iRAqzfkgj2AAAAAElFTkSuQmCC',
);

function placeholder(): Response {
  return new Response(PLACEHOLDER_PNG as unknown as BodyInit, {
    headers: { 'content-type': 'image/png' },
  });
}

export function createArtwork(library: Library, options: {
  state?: Pick<State, 'declare' | 'getTyped'>;
  dataDir?: string;
  playlists?: Playlists;
  /** Native processing port, also lets admission be exercised deterministically. */
  resize?: typeof resizeImage;
} = {}): ArtworkService {
  const concurrent = Math.max(2, Math.floor(navigator.hardwareConcurrency / 2));
  const defaults: Record<string, number> = {
    jpegQuality: 75,
    maxSourceMegabytes: 20,
    maxPixels: 64000000,
    maxConcurrentResizes: concurrent,
    maxQueuedResizes: concurrent * 2,
    cacheMegabytes: 100,
    playlistTileSize: 300,
  };
  for (const [name, value] of Object.entries(defaults)) {
    options.state?.declare(`artwork.${name}`, {
      type: name === 'cacheMegabytes' || name === 'maxSourceMegabytes'
        ? 'number'
        : 'integer',
      minimum:
        ['cacheMegabytes', 'maxSourceMegabytes', 'maxQueuedResizes'].includes(
            name,
          )
          ? 0
          : 1,
      ...(name === 'jpegQuality' ? { maximum: 100 } : {}),
      default: value,
    });
  }
  const setting = async (key: string) =>
    Number(await options.state?.getTyped(`artwork.${key}`) ?? defaults[key]);
  const cache = createArtworkCache(
    options.dataDir ? `${options.dataDir}/cache/images` : undefined,
  );
  let active = 0;
  const waiting: (() => void)[] = [];
  async function admitted<T>(job: () => Promise<T>): Promise<T | null> {
    const limit = await setting('maxConcurrentResizes');
    const queued = await setting('maxQueuedResizes');
    if (active >= limit) {
      if (waiting.length >= queued) return null;
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else active++;
    try {
      return await job();
    } finally {
      active--;
      const currentLimit = await setting('maxConcurrentResizes');
      while (active < currentLimit && waiting.length) {
        active++;
        waiting.shift()!();
      }
    }
  }

  async function resolve(
    id: string,
    maxBytes: number,
  ): Promise<Image | null | 'unknown'> {
    const song = await library.getSong(id);
    if (song !== null) {
      const own = await library.embeddedCover(id, maxBytes);
      if (own !== null) return own;
      return song.albumId === null
        ? null
        : await resolve(song.albumId, maxBytes);
    }
    if (await library.getAlbum(id) !== null) {
      const path = await library.albumCoverPath(id);
      if (path !== null) {
        try {
          const bytes = await readImage(path, maxBytes);
          if (bytes) {
            return {
              bytes,
              format: path.toLowerCase().endsWith('.png')
                ? 'image/png'
                : path.toLowerCase().endsWith('.webp')
                ? 'image/webp'
                : 'image/jpeg',
            };
          }
        } catch {
          /* Vanished/unreadable sources fall through the same chain. */
        }
      }
      const embedded = await library.embeddedCover(id, maxBytes);
      if (embedded !== null) return embedded;
      return await library.candidateCover(id, maxBytes);
    }
    if (await library.artistById(id) !== null) {
      const photo = await library.artistPhoto(id, maxBytes);
      if (photo) return photo;
      const albums = await library.albumsByArtist(id);
      return albums.length ? await resolve(albums[0].id, maxBytes) : null;
    }
    return 'unknown';
  }

  const response = (image: Image, cacheStatus?: string) =>
    new Response(image.bytes as unknown as BodyInit, {
      headers: {
        'content-type': image.format,
        ...(cacheStatus ? { 'x-artwork-cache': cacheStatus } : {}),
      },
    });
  async function playlist(
    id: string,
    username: string | undefined,
    maxBytes: number,
    maxPixels: number,
  ): Promise<Image | null | 'unknown'> {
    // Always authorize BEFORE resolving any bytes or reading any cached cover.
    if (!username || !options.playlists) return 'unknown';
    const list = await options.playlists.get(username, id);
    if (!list) return 'unknown';
    const albums = new Set<string>();
    for (const id of list.trackIds) {
      const song = await library.getSong(id);
      if (song?.albumId) albums.add(song.albumId);
    }
    // Hash-based random sampling is stable for this revision (and across restarts).
    const ranked = await Promise.all([...albums].map(async (albumId) => ({
      id: albumId,
      rank: await imageHash(
        new TextEncoder().encode(`${id}:${list.changedAtMs}:${albumId}`),
      ),
    })));
    ranked.sort((a, b) => a.rank.localeCompare(b.rank));
    const images: Image[] = [];
    for (const album of ranked.slice(0, 4)) {
      const image = await resolve(album.id, maxBytes);
      if (
        image && image !== 'unknown' &&
        withinPixels(imageHeader(image.bytes), maxPixels)
      ) images.push(image);
    }
    if (!images.length) return null;
    const tileSize = 2 * await setting('playlistTileSize');
    if (tileSize > maxPixels / tileSize) return null;
    const hashes = await Promise.all(
      images.map((image) => imageHash(image.bytes)),
    );
    const key = `${await imageHash(
      new TextEncoder().encode(
        `playlist-v1:${id}:${list.changedAtMs}:${tileSize}:${hashes.join(':')}`,
      ),
    )}.png`;
    const limit = await setting('cacheMegabytes') * 1024 * 1024;
    let bytes = await cache.get(key, limit);
    if (!bytes) {
      try {
        bytes = await admitted(() =>
          playlistImage(images.map((image) => image.bytes), tileSize)
        );
      } catch {
        return null;
      }
      if (!bytes) return null;
      await cache.put(key, bytes, limit);
    }
    return { bytes, format: 'image/png' };
  }

  async function get(id: string, opts: Options = {}): Promise<ArtworkResult> {
    const maxBytes = await setting('maxSourceMegabytes') * 1024 * 1024;
    const maxPixels = await setting('maxPixels');
    const source = id.startsWith('pl-')
      ? await playlist(id.slice(3), opts.username, maxBytes, maxPixels)
      : await resolve(id, maxBytes);
    if (source === 'unknown') return { kind: 'unknown' };
    if (source === null) {
      return { kind: 'placeholder', response: placeholder() };
    }
    const size = opts.size ?? 0;
    const header = imageHeader(source.bytes);
    if (
      !Number.isSafeInteger(size) || size <= 0 ||
      !withinPixels(header, maxPixels) ||
      header.animated && header.format !== 'gif' ||
      !header.animated && size >= Math.max(header.width, header.height)
    ) {
      return { kind: 'image', response: response(source) };
    }
    const format = header.format === 'png'
      ? 'png'
      : header.format === 'gif' && header.animated
      ? 'webp'
      : 'jpeg';
    const quality = await setting('jpegQuality');
    const key = `${await imageHash(
      new TextEncoder().encode(
        `${await imageHash(source.bytes)}:${size}:${format}:${quality}`,
      ),
    )}.${format}`;
    const limit = await setting('cacheMegabytes') * 1024 * 1024;
    const cached = await cache.get(key, limit);
    if (cached) {
      return {
        kind: 'image',
        response: response({ bytes: cached, format: `image/${format}` }, 'hit'),
      };
    }
    try {
      const ratio = Math.min(1, size / Math.max(header.width, header.height));
      const bytes = await admitted(() =>
        format === 'webp'
          ? animatedImage(source.bytes, size, quality)
          : (options.resize ?? resizeImage)(
            source.bytes,
            Math.max(1, Math.floor(header.width * ratio)),
            Math.max(1, Math.floor(header.height * ratio)),
            format as 'png' | 'jpeg',
            quality,
          )
      );
      // An encoder returning a flattened/invalid animation is a failed resize.
      if (bytes && (format !== 'webp' || imageHeader(bytes)?.animated)) {
        await cache.put(key, bytes, limit);
        return {
          kind: 'image',
          response: response({ bytes, format: `image/${format}` }, 'miss'),
        };
      }
    } catch { /* Navidrome resize.go: failed resize serves original bytes. */ }
    return { kind: 'image', response: response(source) };
  }
  return {
    async hasArtistPhoto(id) {
      return !!await library.artistPhoto(
        id,
        await setting('maxSourceMegabytes') * 1024 * 1024,
      );
    },
    placeholder,
    get,
    async cover(id, opts) {
      const result = await get(id, opts);
      return result.kind === 'unknown'
        ? new Response(null, { status: 404 })
        : result.response;
    },
  };
}
