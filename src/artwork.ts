// src/artwork.ts — app.artwork: cover art as a Response, always an image,
// never an error page. Resolution order (household rule: local cover.jpg
// wins): the album's cover.jpg, then the embedded (APIC) picture of the
// album's first song / of the song id itself, then the same chain for the
// artist's first album (clients ask getCoverArt with artist ids for artist
// tiles), then the placeholder. No rescaling in M1 (the `size` param is
// ignored by the hat). Resolution of ids → data is app.library's job;
// artwork composes (both are core).
import { decodeBase64 } from '@std/encoding/base64';
import type { Library } from './library.ts';

export interface ArtworkService {
  /** Cover image for an album/song/artist ID — always an image. */
  cover(id: string): Promise<Response>;
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

export function createArtwork(library: Library): ArtworkService {
  async function cover(id: string): Promise<Response> {
    const coverPath = await library.albumCoverPath(id);
    if (coverPath !== null) {
      try {
        const bytes = await Deno.readFile(coverPath);
        return new Response(bytes as unknown as BodyInit, {
          headers: { 'content-type': 'image/jpeg' },
        });
      } catch {
        // cover.jpg vanished between scan and read — fall through
      }
    }
    const embedded = await library.embeddedCover(id);
    if (embedded !== null) {
      return new Response(embedded.bytes as unknown as BodyInit, {
        headers: { 'content-type': embedded.format },
      });
    }
    // Artist id for an artist tile: the first album's cover stands in.
    const albums = await library.albumsByArtist(id);
    if (albums.length > 0) return await cover(albums[0].id);
    return placeholder();
  }
  return { placeholder, cover };
}
