import { assertEquals } from '@std/assert';
import { albumArtistLabel as subsonic } from '../layers/opensubsonic/id3.ts';
import type { AlbumRow as SubsonicAlbum } from '../layers/opensubsonic/types.ts';
import { albumArtistLabel as owntone } from '../layers/owntone/payloads.ts';
import type { AlbumRow as OwntoneAlbum } from '../layers/owntone/types.ts';

for (const kind of ['various', 'unknown'] as const) {
  Deno.test(`hat placeholder ids: ${kind} literals preserve the original SHA-256 identity in both hats`, async () => {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`melofon-placeholder-artist\n${kind}`),
    );
    const expected = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
    // These builders consume only artistKind for protocol-only artists.
    assertEquals(subsonic({ artistKind: kind } as SubsonicAlbum).id, expected);
    assertEquals(owntone({ artistKind: kind } as OwntoneAlbum).id, expected);
  });
}
