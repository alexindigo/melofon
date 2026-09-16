// src/artwork.ts — app.artwork: album cover.jpg as a Response, or the
// embedded placeholder when the album has no cover (or the ID resolves to
// nothing). Household rule: local cover.jpg wins; no rescaling in M1 (the
// `size` param is ignored by the hat). Resolution of album ID → cover path
// is app.library's job; artwork composes it (both are core).
import { decodeBase64 } from '@std/encoding/base64';
import type { Library } from './library.ts';

export interface ArtworkService {
  /** Cover image for an album ID — always an image, never an error page. */
  cover(id: string): Promise<Response>;
}

// 128×128 solid gray PNG (generated with ffmpeg), the missing-cover tile.
const PLACEHOLDER_PNG = decodeBase64(
  'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAAACXBIWXMAAAABAAAAAQBPJcTWAAABL0lEQVR4nO3RQQ0AIAzAQEhQNf/CJuMe9BQ06Z2ZE+fpgN81AGsA1gCsAVgDsAZgDcAagDUAawDWAKwBWAOwBmANwBqANQBrANYArAFYA7AGYA3AGoA1AGsA1gCsAVgDsAZgDcAagDUAawDWAKwBWAOwBmANwBqANQBrANYArAFYA7AGYA3AGoA1AGsA1gCsAVgDsAZgDcAagDUAawDWAKwBWAOwBmANwBqANQBrANYArAFYA7AGYA3AGoA1AGsA1gCsAVgDsAZgDcAagDUAawDWAKwBWAOwBmANwBqANQBrANYArAFYA7AGYA3AGoA1AGsA1gCsAVgDsAZgDcAagDUAawDWAKwBWAOwBmANwBqANQBrANYArAFYA7AGYA3AGoA1AGsA1gCsAVgDsAZgC2iRAqzfkgj2AAAAAElFTkSuQmCC',
);

function placeholder(): Response {
  return new Response(PLACEHOLDER_PNG as unknown as BodyInit, {
    headers: { 'content-type': 'image/png' },
  });
}

export function createArtwork(library: Library): ArtworkService {
  return {
    async cover(id) {
      const path = await library.albumCoverPath(id);
      if (path === null) return placeholder();
      try {
        const bytes = await Deno.readFile(path);
        return new Response(bytes as unknown as BodyInit, {
          headers: { 'content-type': 'image/jpeg' },
        });
      } catch {
        return placeholder(); // cover.jpg vanished between scan and read
      }
    },
  };
}
