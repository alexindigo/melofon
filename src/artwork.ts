// Core owns resolution, budgets, admission and disposable derived image bytes.
// Hats translate unknown/placeholder/image into their own protocol responses.
import { decodeBase64 } from '@std/encoding/base64';
import type { Library } from './library.ts';
import type { Playlists } from './playlists.ts';
import type { State } from './state.ts';
import { imageHash, readImage } from './images.ts';
import { imageHeader, withinPixels } from './image-header.ts';
import {
  animatedImage,
  imagePixels,
  playlistImage,
  resizeImage,
} from './media.ts';
import { createArtworkCache } from './artwork-cache.ts';
import type { Podcasts } from './podcasts.ts';
import { type ArtworkImage, createArtworkSources } from './artwork-sources.ts';
import type { Store } from './store/index.ts';
import type { createRadio } from './radio.ts';

export type ArtworkRef = {
  kind: 'song' | 'album' | 'artist' | 'playlist' | 'podcast' | 'radio';
  id: string;
};
export interface ArtworkDescriptor {
  sourceHash: string;
  version: string;
  sourceKind:
    | 'embedded'
    | 'album-file'
    | 'album-candidate'
    | 'artist-photo'
    | 'playlist'
    | 'podcast'
    | 'radio-upload';
  /** Original dimensions, not rendition dimensions; null for unknown headers. */
  width: number | null;
  height: number | null;
  mime: string;
}
export type ArtworkDescription = { kind: 'unknown' | 'missing' } | {
  kind: 'image';
  descriptor: ArtworkDescriptor;
};
export type ArtworkSnapshot = { kind: 'unknown' } | { kind: 'missing' } | {
  kind: 'image';
  descriptor: ArtworkDescriptor;
  bytes: Uint8Array;
};
export type ArtworkResult = { kind: 'unknown' } | {
  kind: 'placeholder';
  response: Response;
} | {
  kind: 'image';
  descriptor: ArtworkDescriptor;
  /** Fallback bytes are valid, but must not make a transient failure immutable. */
  rendition: 'original' | 'resized' | 'fallback';
  response: Response;
};
export type ArtworkPixels = { kind: 'unknown' | 'unavailable' } | {
  kind: 'pixels';
  descriptor: ArtworkDescriptor;
  width: number;
  height: number;
  /** Packed, straight (not premultiplied) RGBA; independent of native memory. */
  rgba: Uint8Array;
};
interface Options {
  size?: number;
  username?: string;
}
type Image = ArtworkImage;
interface Source extends Image {
  sourceKind: ArtworkDescriptor['sourceKind'];
}
interface Policy {
  maxBytes: number;
  maxPixels: number;
  quality: number;
}

export interface ArtworkService {
  /** A real artist photo, never the first-album artwork fallback. */
  hasArtistPhoto(id: string): Promise<boolean>;
  /** Plain facts and owned encoded bytes from one authorized source resolution. */
  snapshot(
    ref: ArtworkRef,
    options?: Pick<Options, 'username'>,
  ): Promise<ArtworkSnapshot>;
  describe(
    ref: ArtworkRef,
    options?: Pick<Options, 'username'>,
  ): Promise<ArtworkDescription>;
  /** First-frame aspect fit, no upscale; never encoded bytes or a stand-in tile. */
  pixels(
    ref: ArtworkRef,
    options: Options & { size: number },
  ): Promise<ArtworkPixels>;
  /** Strings adapt legacy catalog ids and pl- playlist aliases. */
  get(id: string | ArtworkRef, options?: Options): Promise<ArtworkResult>;
  /** HTTP-native convenience for OwnTone: unknown is 404, never error 70. */
  cover(id: string | ArtworkRef, options?: Options): Promise<Response>;
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
  podcasts?: Pick<Podcasts, 'cover'>;
  radio?: Pick<ReturnType<typeof createRadio>, 'cover'>;
  facts?: Store['artwork'];
  /** Native processing port, also lets admission be exercised deterministically. */
  resize?: typeof resizeImage;
  pixels?: typeof imagePixels;
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
  const sources = createArtworkSources(
    options.facts,
    cache,
    async () => await setting('cacheMegabytes') * 1024 * 1024,
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
    kind?: ArtworkRef['kind'],
  ): Promise<Source | null | 'unknown'> {
    if (kind === 'radio' || !kind && id.startsWith('radio-')) {
      const image = await options.radio?.cover(id, maxBytes);
      return image === undefined || image === 'unknown'
        ? 'unknown'
        : image && { ...image, sourceKind: 'radio-upload' };
    }
    if (!kind || kind === 'podcast') {
      const podcast = await options.podcasts?.cover(
        id,
        maxBytes,
        sources.file(maxBytes),
      );
      if (podcast !== undefined && podcast !== 'unknown') {
        return podcast && { ...podcast, sourceKind: 'podcast' };
      }
      if (kind === 'podcast') return 'unknown';
    }
    const song = !kind || kind === 'song' ? await library.getSong(id) : null;
    if (song !== null) {
      const own = await library.embeddedCover(
        id,
        maxBytes,
        sources.file(maxBytes),
      );
      if (own !== null) return { ...own, sourceKind: 'embedded' };
      return song.albumId === null
        ? null
        : await resolve(song.albumId, maxBytes, 'album');
    }
    if ((!kind || kind === 'album') && await library.getAlbum(id) !== null) {
      const path = await library.albumCoverPath(id);
      if (path !== null) {
        try {
          const image = await sources.file(maxBytes)(
            path,
            'image-v1',
            async () => {
              const bytes = await readImage(path, maxBytes);
              return bytes
                ? {
                  bytes,
                  format: path.toLowerCase().endsWith('.png')
                    ? 'image/png'
                    : path.toLowerCase().endsWith('.webp')
                    ? 'image/webp'
                    : 'image/jpeg',
                }
                : null;
            },
          );
          if (image) return { ...image, sourceKind: 'album-file' };
        } catch {
          /* Vanished/unreadable sources fall through the same chain. */
        }
      }
      const embedded = await library.embeddedCover(
        id,
        maxBytes,
        sources.file(maxBytes),
      );
      if (embedded !== null) return { ...embedded, sourceKind: 'embedded' };
      const candidate = await library.candidateCover(
        id,
        maxBytes,
        sources.file(maxBytes),
      );
      return candidate && { ...candidate, sourceKind: 'album-candidate' };
    }
    if ((!kind || kind === 'artist') && await library.artistById(id) !== null) {
      const photo = await library.artistPhoto(
        id,
        maxBytes,
        sources.file(maxBytes),
      );
      if (photo) return { ...photo, sourceKind: 'artist-photo' };
      const albums = await library.albumsByArtist(id);
      return albums.length
        ? await resolve(albums[0].id, maxBytes, 'album')
        : null;
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
  ): Promise<Source | null | 'unknown'> {
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
      images.map((image) => image.facts?.sourceHash ?? imageHash(image.bytes)),
    );
    const key = `${await imageHash(
      new TextEncoder().encode(
        `playlist-v1:${id}:${list.changedAtMs}:${tileSize}:${hashes.join(':')}`,
      ),
    )}.png`;
    const limit = await setting('cacheMegabytes') * 1024 * 1024;
    const image = await sources.generated(`playlist:${id}`, key, async () => {
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
    });
    return image && { ...image, sourceKind: 'playlist' };
  }

  async function policy(): Promise<Policy> {
    return {
      maxBytes: await setting('maxSourceMegabytes') * 1024 * 1024,
      maxPixels: await setting('maxPixels'),
      quality: await setting('jpegQuality'),
    };
  }
  async function snapshot(
    ref: string | ArtworkRef,
    opts: Options,
    rules: Policy,
  ): Promise<ArtworkSnapshot> {
    const typed = typeof ref === 'string'
      ? ref.startsWith('pl-')
        ? { kind: 'playlist' as const, id: ref.slice(3) }
        : null
      : ref;
    const source = typed?.kind === 'playlist'
      ? await playlist(typed.id, opts.username, rules.maxBytes, rules.maxPixels)
      : await resolve(typed?.id ?? ref as string, rules.maxBytes, typed?.kind);
    if (source === 'unknown') return { kind: 'unknown' };
    if (source === null) return { kind: 'missing' };
    const header = imageHeader(source.bytes);
    const sourceHash = source.facts?.sourceHash ??
      await imageHash(source.bytes);
    return {
      kind: 'image',
      bytes: source.bytes,
      descriptor: {
        sourceHash,
        // Bump the revision when the rendition algorithm/encoder policy changes.
        version: await imageHash(new TextEncoder().encode(
          `${sourceHash}:rendition-v1:${rules.quality}:${rules.maxPixels}`,
        )),
        sourceKind: source.sourceKind,
        width: source.facts ? source.facts.width : header?.width ?? null,
        height: source.facts ? source.facts.height : header?.height ?? null,
        mime: source.format,
      },
    };
  }
  async function get(
    id: string | ArtworkRef,
    opts: Options = {},
  ): Promise<ArtworkResult> {
    const rules = await policy();
    const selected = await snapshot(id, opts, rules);
    if (selected.kind === 'unknown') return { kind: 'unknown' };
    if (selected.kind === 'missing') {
      return { kind: 'placeholder', response: placeholder() };
    }
    const { descriptor } = selected;
    const source = { bytes: selected.bytes, format: descriptor.mime };
    const size = opts.size ?? 0;
    const header = imageHeader(source.bytes);
    if (
      !Number.isSafeInteger(size) || size <= 0 ||
      !withinPixels(header, rules.maxPixels) ||
      header.animated && header.format !== 'gif' ||
      !header.animated && size >= Math.max(header.width, header.height)
    ) {
      return {
        kind: 'image',
        descriptor,
        rendition: 'original',
        response: response(source),
      };
    }
    const format = header.format === 'png'
      ? 'png'
      : header.format === 'gif' && header.animated
      ? 'webp'
      : 'jpeg';
    const quality = rules.quality;
    const key = `${await imageHash(
      new TextEncoder().encode(
        `${descriptor.version}:${size}:${format}:${quality}`,
      ),
    )}.${format}`;
    const limit = await setting('cacheMegabytes') * 1024 * 1024;
    const cached = await cache.get(key, limit);
    if (cached) {
      return {
        kind: 'image',
        descriptor,
        rendition: 'resized',
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
          descriptor,
          rendition: 'resized',
          response: response({ bytes, format: `image/${format}` }, 'miss'),
        };
      }
    } catch { /* Navidrome resize.go: failed resize serves original bytes. */ }
    return {
      kind: 'image',
      descriptor,
      rendition: 'fallback',
      response: response(source),
    };
  }
  return {
    async hasArtistPhoto(id) {
      return !!await library.artistPhoto(
        id,
        await setting('maxSourceMegabytes') * 1024 * 1024,
        sources.file(await setting('maxSourceMegabytes') * 1024 * 1024),
      );
    },
    placeholder,
    snapshot: async (ref, opts = {}) =>
      await snapshot(ref, opts, await policy()),
    async describe(ref, opts = {}) {
      const selected = await snapshot(ref, opts, await policy());
      return selected.kind === 'image'
        ? { kind: 'image', descriptor: selected.descriptor }
        : selected;
    },
    async pixels(ref, opts) {
      const rules = await policy();
      const selected = await snapshot(ref, opts, rules);
      if (selected.kind === 'unknown') return selected;
      if (selected.kind === 'missing') return { kind: 'unavailable' };
      const header = imageHeader(selected.bytes);
      if (
        !Number.isSafeInteger(opts.size) || opts.size <= 0 ||
        selected.bytes.length > rules.maxBytes ||
        !withinPixels(header, rules.maxPixels)
      ) return { kind: 'unavailable' };
      const ratio = Math.min(
        1,
        opts.size / Math.max(header.width, header.height),
      );
      const width = Math.max(1, Math.floor(header.width * ratio));
      const height = Math.max(1, Math.floor(header.height * ratio));
      try {
        const rgba = await admitted(() =>
          (options.pixels ?? imagePixels)(selected.bytes, width, height)
        );
        return rgba
          ? {
            kind: 'pixels',
            descriptor: selected.descriptor,
            width,
            height,
            rgba,
          }
          : { kind: 'unavailable' };
      } catch {
        return { kind: 'unavailable' };
      }
    },
    get,
    async cover(id, opts) {
      const result = await get(id, opts);
      return result.kind === 'unknown'
        ? new Response(null, { status: 404 })
        : result.response;
    },
  };
}
