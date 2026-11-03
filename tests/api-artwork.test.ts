import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { artworkUrl } from '../layers/melofon/artwork.ts';
import { type ArtworkRef, createArtwork } from '../src/artwork.ts';
import { createLibrary } from '../src/library.ts';
import { createLibraries } from '../src/libraries.ts';
import { createPlaylists } from '../src/playlists.ts';
import { imageHeader } from '../src/image-header.ts';
import { imagePixels, resizeImage } from '../src/media.ts';
import { scanLibrary } from '../src/scan.ts';
import { apiFixture, error } from './helpers/api.ts';
import { pixelPng, twoFrameGif } from './helpers/pixel-image.ts';
import { tagged } from './helpers/tagged.ts';

async function digest(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function solid(red: number) {
  return new Uint8Array(
    Array.from({ length: 13 * 7 }, () => [red, 20, 40, 255]).flat(),
  );
}

async function fixture(resize?: typeof resizeImage) {
  const root = await Deno.makeTempDir({ prefix: 'melofon-api-artwork-' });
  const source = pixelPng(13, 7, solid(200));
  const cover = `${root}/music/Artist/Album/cover.png`;
  const open = (initial: boolean) =>
    apiFixture({
      storeDir: `${root}/data`,
      services: async (f) => {
        if (initial) {
          await Deno.mkdir(`${root}/music/Artist/Album`, { recursive: true });
          await Deno.mkdir(`${root}/music/Missing`);
          await tagged(`${root}/music/Artist/Album/song.mp3`, {
            TALB: 'Album',
            TPE2: 'Artist',
          });
          await tagged(`${root}/music/Missing/song.mp3`, {
            TALB: 'Missing',
            TPE2: 'Other',
          });
          await Deno.writeFile(cover, source);
          await createLibraries(f.store).add('Music', `${root}/music`);
          await scanLibrary(f.store);
        }
        const library = createLibrary(f.store);
        const playlists = createPlaylists(f.store);
        return {
          library,
          playlists,
          artwork: createArtwork(library, {
            state: f.state,
            dataDir: f.cfg.dataDir,
            facts: f.store.artwork,
            playlists,
            resize,
          }),
        };
      },
    });
  let f = await open(true);
  const library = () => createLibrary(f.store);
  const songs = await library().listSongs({ size: 20, offset: 0 });
  const song = songs.find((s) => s.albumName === 'Album')!;
  const missing = songs.find((s) => s.albumName === 'Missing')!;
  const ref: ArtworkRef = { kind: 'song', id: song.id };
  const descriptor = async (reference = ref) => {
    const result = await createArtwork(library(), { state: f.state }).describe(
      reference,
      { username: 'admin' },
    );
    assert(result.kind === 'image');
    return result.descriptor;
  };
  return {
    get f() {
      return f;
    },
    root,
    source,
    cover,
    song,
    missing,
    ref,
    descriptor,
    async restart() {
      await f.close();
      f = await open(false);
    },
    async close() {
      await f.close();
      await Deno.remove(root, { recursive: true });
    },
  };
}

async function image(
  response: Response,
  width: number,
  height: number,
  mime: string,
) {
  assertEquals(response.status, 200, await response.clone().text());
  assertEquals(response.headers.get('content-type'), mime);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const header = imageHeader(bytes)!;
  assertEquals([header.width, header.height], [width, height]);
  assertEquals(response.headers.get('etag'), `"${await digest(bytes)}"`);
  return bytes;
}

Deno.test('API artwork: authenticated native images, arbitrary aspect fit, versions and HTTP validators', async () => {
  const t = await fixture();
  try {
    const ips = await Deno.resolveDns('melofon.home', 'A');
    assert(ips.length > 0 && ips.every((ip) => !ip.startsWith('127.')));
    const version = (await t.descriptor()).version;
    const path = artworkUrl(t.ref, version);
    assert(path.includes('/song%3A'));
    await error(
      await t.f.get(path, undefined, { 'If-None-Match': '*' }),
      401,
      'unauthenticated',
    );
    for (const use of ['cookie', 'bearer'] as const) {
      const key = (await t.f.login(use)).credential;
      const original = await t.f.get(path, key, {
        Origin: 'http://foreign.home',
      });
      const etag = original.headers.get('etag')!;
      assertEquals(
        original.headers.get('cache-control'),
        'private, max-age=31536000, immutable',
      );
      assertEquals(original.headers.get('vary'), 'Cookie, Authorization');
      assertEquals(await image(original, 13, 7, 'image/png'), t.source);
      for (const size of [0, 13, 9999]) {
        assertEquals(
          await image(
            await t.f.get(`${path}&size=${size}`, key),
            13,
            7,
            'image/png',
          ),
          t.source,
        );
      }
      const resized = await t.f.get(`${path}&size=5`, key);
      const smallTag = resized.headers.get('etag')!;
      const small = await image(resized, 5, 2, 'image/png');
      assertNotEquals(smallTag, etag);
      const pixels = await imagePixels(small, 5, 2);
      assertEquals(
        pixels,
        new Uint8Array(
          Array.from({ length: 10 }, () => [200, 20, 40, 255]).flat(),
        ),
      );
      await image(await t.f.get(`${path}&size=1`, key), 1, 1, 'image/png');
      for (const field of [etag, `W/${etag}`, `"other,tag", W/${etag}`, '*']) {
        const repeated = await t.f.get(path, key, { 'If-None-Match': field });
        assertEquals(repeated.status, 304);
        assertEquals(await repeated.text(), '');
        assertEquals(repeated.headers.get('etag'), etag);
        assertEquals(
          repeated.headers.get('cache-control'),
          'private, max-age=31536000, immutable',
        );
        assertEquals(repeated.headers.get('vary'), 'Cookie, Authorization');
      }
      for (
        const field of [smallTag, `${etag},`, `garbage ${etag}`, '"other"']
      ) {
        await image(
          await t.f.get(path, key, { 'If-None-Match': field }),
          13,
          7,
          'image/png',
        );
      }
      for (const query of ['', '?v=stale', '?v=']) {
        const r = await t.f.get(
          `/api/v1/artwork/song:${t.song.id}${query}`,
          key,
        );
        assertEquals(r.headers.get('cache-control'), 'private, no-cache');
        assertEquals(await image(r, 13, 7, 'image/png'), t.source);
      }
      const standIn = await t.f.get(
        artworkUrl({ kind: 'song', id: t.missing.id }, version),
        key,
        { 'If-None-Match': '*' },
      );
      assertEquals(standIn.status, 200);
      assertEquals(standIn.headers.get('cache-control'), 'no-store');
      assertEquals(standIn.headers.get('etag'), null);
      const header = imageHeader(new Uint8Array(await standIn.arrayBuffer()))!;
      assertEquals([header.width, header.height, header.format], [
        128,
        128,
        'png',
      ]);
      await error(
        await t.f.get(
          artworkUrl({ kind: 'song', id: 'absent' }, version),
          key,
          { 'If-None-Match': '*' },
        ),
        404,
        'not_found',
      );
      for (
        const query of [
          'size=-1',
          'size=1.5',
          'size=9007199254740992',
          'size=',
          'size=2&size=3',
          'v=a&v=b',
          'unknown=1',
        ]
      ) {
        await error(
          await t.f.get(`${path}&${query}`, key),
          400,
          'invalid_field',
        );
      }
      await error(
        await t.f.get('/api/v1/artwork/untyped', key),
        400,
        'invalid_field',
      );
      await error(
        await t.f.get('/api/v1/artwork/wrong:kind', key),
        400,
        'invalid_field',
      );
    }
    await t.f.state.set('server.baseUrl', `${t.f.origin}/music`);
    const key = (await t.f.login('cookie')).credential;
    const prefixed = artworkUrl(t.ref, version, '/music', 5);
    assert(prefixed.startsWith('/music/api/v1/artwork/'));
    await image(await t.f.get(prefixed, key), 5, 2, 'image/png');
    const album: ArtworkRef = { kind: 'album', id: t.song.albumId! };
    await image(
      await t.f.get(artworkUrl(album, version, '/music'), key),
      13,
      7,
      'image/png',
    );
    assert(t.f.peers.every((ip) => ip !== '127.0.0.1' && ip !== '::1'));
  } finally {
    await t.close();
  }
});

Deno.test('API artwork: source and rendition changes invalidate bytes; restart and cached playlist authorization', async () => {
  const t = await fixture();
  try {
    await t.f.auth.users.create(t.f.admin.id, {
      username: 'reader',
      password: 'password-reader',
      role: 'user',
    });
    const key = (await t.f.login('bearer')).credential;
    const reader =
      (await t.f.login('cookie', 'reader', 'password-reader')).credential;
    const version = (await t.descriptor()).version;
    const path = artworkUrl(t.ref, version, '', 5);
    const before = await t.f.get(path, key);
    const tag = before.headers.get('etag')!;
    await image(before, 5, 2, 'image/png');
    await t.restart();
    const repeated = await t.f.get(path, key, { 'If-None-Match': tag });
    assertEquals(repeated.status, 304);
    assertEquals(await repeated.text(), '');
    const replacement = pixelPng(13, 7, solid(50));
    await Deno.writeFile(t.cover, replacement);
    const changed = await t.f.get(path, key, { 'If-None-Match': tag });
    assertEquals(changed.headers.get('cache-control'), 'private, no-cache');
    const changedBytes = await image(changed, 5, 2, 'image/png');
    assertEquals((await imagePixels(changedBytes, 5, 2))![0], 50);
    assertNotEquals((await t.descriptor()).version, version);
    // The native URL token includes settings even when the source hash is stable.
    const source = await t.descriptor();
    await t.f.state.set('artwork.jpegQuality', '40');
    const policy = await t.descriptor();
    assertEquals(policy.sourceHash, source.sourceHash);
    assertNotEquals(policy.version, source.version);
    // A real JPEG also changes the validator when rendition quality changes.
    await Deno.remove(t.cover);
    const jpegPath = t.cover.replace('.png', '.jpg');
    await Deno.copyFile(
      'tests/fixtures/library/Fixture Artist/Fixture Album/cover.jpg',
      jpegPath,
    );
    const jpeg = await t.descriptor();
    const jpegUrl = artworkUrl(t.ref, jpeg.version, '', 5);
    const first = await t.f.get(jpegUrl, key);
    const firstTag = first.headers.get('etag')!;
    const h = imageHeader(new Uint8Array(await first.arrayBuffer()))!;
    assert(Math.max(h.width, h.height) <= 5);
    assertEquals(h.format, 'jpeg');
    await t.f.state.set('artwork.jpegQuality', '95');
    const quality = await t.descriptor();
    assertNotEquals(quality.version, jpeg.version);
    assertEquals(quality.sourceHash, jpeg.sourceHash);
    const qualityResponse = await t.f.get(jpegUrl, key, {
      'If-None-Match': firstTag,
    });
    assertEquals(qualityResponse.status, 200);
    assertEquals(
      qualityResponse.headers.get('cache-control'),
      'private, no-cache',
    );
    assertNotEquals(qualityResponse.headers.get('etag'), firstTag);
    await qualityResponse.arrayBuffer();
    const lists = createPlaylists(t.f.store);
    const list = await lists.create('admin', 'Grid', [t.song.id], true);
    const listRef: ArtworkRef = { kind: 'playlist', id: list.id };
    // Obtain the version from the same actual core composition used by GET.
    const art = createArtwork(createLibrary(t.f.store), {
      playlists: lists,
      state: t.f.state,
    });
    const description = await art.describe(listRef, { username: 'admin' });
    assert(description.kind === 'image');
    const listUrl = artworkUrl(listRef, description.descriptor.version, '', 5);
    const grid = await t.f.get(listUrl, reader);
    const gridTag = grid.headers.get('etag')!;
    assertEquals(
      grid.headers.get('cache-control'),
      'private, max-age=31536000, immutable',
    );
    await image(grid, 5, 5, 'image/png');
    await lists.update('admin', list.id, { public: false });
    await error(
      await t.f.get(listUrl, reader, { 'If-None-Match': gridTag }),
      404,
      'not_found',
    );
    await error(
      await t.f.get(listUrl, reader, { 'If-None-Match': '*' }),
      404,
      'not_found',
    );
    await image(await t.f.get(listUrl, key), 5, 5, 'image/png');
    await lists.delete('admin', list.id);
    await error(
      await t.f.get(listUrl, key, { 'If-None-Match': gridTag }),
      404,
      'not_found',
    );
    await Deno.remove(`${t.root}/music/Artist/Album/song.mp3`);
    await scanLibrary(t.f.store);
    await error(
      await t.f.get(path, key, { 'If-None-Match': '*' }),
      404,
      'not_found',
    );
  } finally {
    await t.close();
  }
});

Deno.test('API artwork: failed or overloaded resize stays revalidatable and recovery serves the requested bytes', async () => {
  let mode = 'fail';
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const t = await fixture(async (...args) => {
    if (mode === 'fail') throw new Error('fixture encoder failure');
    if (mode === 'block') {
      entered();
      await blocked;
    }
    return await resizeImage(...args);
  });
  try {
    const key = (await t.f.login('cookie')).credential;
    const version = (await t.descriptor()).version;
    const path = artworkUrl(t.ref, version, '', 5);
    const failed = await t.f.get(path, key);
    const originalTag = failed.headers.get('etag')!;
    assertEquals(failed.headers.get('cache-control'), 'private, no-cache');
    assertEquals(await image(failed, 13, 7, 'image/png'), t.source);
    mode = 'ok';
    const recovered = await t.f.get(path, key, {
      'If-None-Match': originalTag,
    });
    assertNotEquals(recovered.headers.get('etag'), originalTag);
    assertEquals(
      recovered.headers.get('cache-control'),
      'private, max-age=31536000, immutable',
    );
    await image(recovered, 5, 2, 'image/png');
    await t.f.state.set('artwork.maxConcurrentResizes', '1');
    await t.f.state.set('artwork.maxQueuedResizes', '0');
    mode = 'block';
    const active = t.f.get(artworkUrl(t.ref, version, '', 6), key);
    await started;
    try {
      const overloaded = await t.f.get(artworkUrl(t.ref, version, '', 7), key);
      assertEquals(
        overloaded.headers.get('cache-control'),
        'private, no-cache',
      );
      assertEquals(await image(overloaded, 13, 7, 'image/png'), t.source);
    } finally {
      mode = 'ok';
      release();
      await image(await active, 6, 3, 'image/png');
    }
    await image(
      await t.f.get(artworkUrl(t.ref, version, '', 7), key, {
        'If-None-Match': originalTag,
      }),
      7,
      3,
      'image/png',
    );
    // Animation keeps the core policy: GIF -> animated WebP, never a static tile.
    await Deno.writeFile(t.cover, twoFrameGif());
    const animation = await t.f.get(
      `/api/v1/artwork/song:${t.song.id}?size=1`,
      key,
    );
    const bytes = await image(animation, 1, 1, 'image/webp');
    assertEquals(imageHeader(bytes)!.animated, true);
  } finally {
    release();
    await t.close();
  }
});
