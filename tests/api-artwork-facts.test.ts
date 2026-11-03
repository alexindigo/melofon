import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { decodeBase64 } from '@std/encoding/base64';
import { createArtwork } from '../src/artwork.ts';
import { createHatData } from '../src/hat-data.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createFolders } from '../src/folders.ts';
import { imagePixels } from '../src/media.ts';
import { scanLibrary } from '../src/scan.ts';
import { apiFixture, error } from './helpers/api.ts';
import { pixelPng } from './helpers/pixel-image.ts';
import { tagged } from './helpers/tagged.ts';
import reference from './fixtures/thumbhash-reference.json' with {
  type: 'json',
};

const red = reference.vectors.find((v) => v.name === 'one-red')!;
const black = reference.vectors.find((v) => v.name === 'one-black')!;

async function fixture() {
  const root = await Deno.makeTempDir({ prefix: 'melofon-artwork-facts-' });
  const source = pixelPng(red.w, red.h, decodeBase64(red.rgba));
  const cover = `${root}/music/Artist/Album/cover.png`;
  let calls: number[][] = [];
  let failure = false;
  const open = (initial: boolean) =>
    apiFixture({
      storeDir: `${root}/data`,
      services: async (f) => {
        const libraries = createLibraries(f.store);
        if (initial) {
          for (const album of ['Album', 'Copy', 'Missing']) {
            await Deno.mkdir(`${root}/music/Artist/${album}`, {
              recursive: true,
            });
            await tagged(`${root}/music/Artist/${album}/song.mp3`, {
              TALB: album,
              TPE1: 'Artist',
              TPE2: 'Artist',
              TIT2: album,
            });
            if (album !== 'Missing') {
              await Deno.writeFile(
                `${root}/music/Artist/${album}/cover.png`,
                source,
              );
            }
          }
          await Deno.writeFile(`${root}/music/Artist/artist.png`, source);
          await libraries.add('Music', `${root}/music`);
          await scanLibrary(f.store);
        }
        const library = createLibrary(f.store);
        return {
          library,
          libraries,
          folders: createFolders(f.store),
          artwork: createArtwork(library, {
            state: f.state,
            dataDir: f.cfg.dataDir,
            facts: f.store.artwork,
            pixels: async (bytes, width, height) => {
              calls.push([width, height]);
              if (failure) throw new Error('fixture decode failure');
              return await imagePixels(bytes, width, height);
            },
          }),
        };
      },
    });
  let f = await open(true);
  const songs = await createLibrary(f.store).listSongs({ size: 20, offset: 0 });
  const song = songs.find((s) => s.albumName === 'Album')!;
  return {
    get f() {
      return f;
    },
    root,
    source,
    cover,
    song,
    songs,
    get calls() {
      return calls;
    },
    fail(value: boolean) {
      failure = value;
    },
    async clear() {
      const data = createHatData(f.store, f.cfg, f.state)('melofon');
      for (const record of await data.list()) await data.remove(record.key);
      calls = [];
    },
    async restart() {
      await f.close();
      f = await open(false);
      calls = [];
    },
    async close() {
      await f.close();
      await Deno.remove(root, { recursive: true });
    },
  };
}

async function read(
  f: Awaited<ReturnType<typeof apiFixture>>,
  path: string,
  key: string,
  etag?: string,
) {
  const response = await f.get(
    `/api/v1/${path}`,
    key,
    etag ? { 'If-None-Match': etag } : {},
  );
  assertEquals(response.status, 200, await response.clone().text());
  assertEquals(response.headers.get('cache-control'), 'private, no-cache');
  return { body: await response.json(), etag: response.headers.get('etag')! };
}

Deno.test('API lazy artwork: real song/album/artist lists and details publish trusted facts on the next read', async () => {
  const t = await fixture();
  try {
    const ips = await Deno.resolveDns('melofon.home', 'A');
    assert(ips.length > 0 && ips.every((ip) => !ip.startsWith('127.')));
    const cookie = (await t.f.login('cookie')).credential;
    const bearer = (await t.f.login('bearer')).credential;
    for (const [index, kind] of ['songs', 'albums', 'artists'].entries()) {
      await t.clear();
      const first = await read(t.f, kind, cookie);
      const rows = first.body[kind];
      assert(rows.some((r: { artwork: unknown }) => r.artwork !== null));
      for (const row of rows) {
        if (row.artwork) {
          assertEquals([row.artwork.thumbHash, row.artwork.dominantColor], [
            null,
            null,
          ]);
        }
      }
      assertEquals(
        t.calls,
        [[1, 1]],
        'identical source images decode once per reply',
      );
      const second = await read(t.f, kind, bearer, first.etag);
      assertNotEquals(
        second.etag,
        first.etag,
        'readiness is part of the representation',
      );
      for (const row of second.body[kind]) {
        if (!row.artwork) continue;
        assertEquals([
          row.artwork.thumbHash,
          row.artwork.dominantColor,
          row.artwork.width,
          row.artwork.height,
        ], [red.hash, '#ff0000', 1, 1]);
        assert(row.artwork.url.includes(`?v=${row.artwork.version}`));
        const image = await t.f.get(row.artwork.url, cookie);
        assertEquals(new Uint8Array(await image.arrayBuffer()), t.source);
      }
      assertEquals(t.calls.length, 1);
      const repeated = await t.f.get(`/api/v1/${kind}`, bearer, {
        'If-None-Match': second.etag,
      });
      assertEquals(repeated.status, 304);
      assertEquals(await repeated.text(), '');
      const selected = second.body[kind].find((r: { artwork: unknown }) =>
        r.artwork !== null
      );
      await t.clear();
      const path = `${kind}/${selected.id}`;
      const a = await read(t.f, path, index % 2 ? bearer : cookie);
      const b = await read(t.f, path, bearer, a.etag);
      const entity = kind.slice(0, -1);
      assertEquals(a.body[entity].artwork.thumbHash, null);
      assertEquals(b.body[entity].artwork.thumbHash, red.hash);
    }
    const records = await t.f.store.hatData.list('melofon', '');
    assertEquals(records.length, 1);
    assertEquals(records[0].kind, 'data');
    await t.restart();
    const after = await read(t.f, 'songs', bearer);
    assertEquals(
      after.body.songs.find((s: { id: string }) => s.id === t.song.id).artwork
        .thumbHash,
      red.hash,
    );
    assertEquals(t.calls, [], 'restart reuses persisted facts');
    assert(t.f.peers.every((ip) => ip !== '127.0.0.1' && ip !== '::1'));
  } finally {
    await t.close();
  }
});

Deno.test('API lazy artwork: source changes without scan, policy changes, original dimensions and deleted entities', async () => {
  const t = await fixture();
  try {
    const key = (await t.f.login('bearer')).credential;
    const path = `songs/${t.song.id}`;
    await read(t.f, path, key);
    const old = await read(t.f, path, key);
    const revision =
      (await createLibrary(t.f.store).getSongSnapshot(t.song.id)).revision;
    await Deno.writeFile(t.cover, pixelPng(1, 1, decodeBase64(black.rgba)));
    const miss = await read(t.f, path, key, old.etag);
    assertEquals(miss.body.song.artwork.thumbHash, null);
    assertNotEquals(
      miss.body.song.artwork.version,
      old.body.song.artwork.version,
    );
    const changed = await read(t.f, path, key, miss.etag);
    assertEquals([
      changed.body.song.artwork.thumbHash,
      changed.body.song.artwork.dominantColor,
    ], [black.hash, '#000000']);
    assertEquals(
      (await createLibrary(t.f.store).getSongSnapshot(t.song.id)).revision,
      revision,
    );
    const count = t.calls.length;
    await t.f.state.set('artwork.jpegQuality', '40');
    const policy = await read(t.f, path, key, changed.etag);
    assertNotEquals(
      policy.body.song.artwork.version,
      changed.body.song.artwork.version,
    );
    assertEquals(policy.body.song.artwork.thumbHash, black.hash);
    assertEquals(
      t.calls.length,
      count,
      'rendition settings do not invalidate source-keyed codecs',
    );
    const large = new Uint8Array(
      Array.from({ length: 137 * 71 }, () => [255, 0, 0, 255]).flat(),
    );
    await Deno.writeFile(t.cover, pixelPng(137, 71, large));
    await read(t.f, path, key);
    const scaled = (await read(t.f, path, key)).body.song.artwork;
    assertEquals([scaled.width, scaled.height, scaled.dominantColor], [
      137,
      71,
      '#ff0000',
    ]);
    assertEquals(t.calls.at(-1), [100, 51]);
    assert(typeof scaled.thumbHash === 'string');
    await t.f.state.set('server.baseUrl', `${t.f.origin}/music`);
    const prefixed = await t.f.get(`/music/api/v1/${path}`, key);
    assert(
      (await prefixed.json()).song.artwork.url.startsWith(
        '/music/api/v1/artwork/',
      ),
    );
    await Deno.remove(t.song.path);
    await scanLibrary(t.f.store);
    await error(
      await t.f.get(`/music/api/v1/${path}`, key, { 'If-None-Match': '*' }),
      404,
      'not_found',
    );
  } finally {
    await t.close();
  }
});

Deno.test('API lazy artwork: bounded distinct misses and decoder failures remain retryable', async () => {
  const t = await fixture();
  try {
    const key = (await t.f.login('cookie')).credential;
    await Deno.writeFile(
      `${t.root}/music/Artist/Copy/cover.png`,
      pixelPng(1, 1, decodeBase64(black.rgba)),
    );
    await t.f.state.set('melofon.artworkFactsPerRequest', '1');
    t.fail(true);
    await read(t.f, 'songs', key);
    assertEquals(
      t.calls.length,
      1,
      'budget counts failed attempts, including concurrent row projections',
    );
    assertEquals(await t.f.store.hatData.list('melofon', ''), []);
    t.fail(false);
    await read(t.f, 'songs', key);
    assertEquals(t.calls.length, 2);
    const partial = await read(t.f, 'songs', key);
    assertEquals(
      partial.body.songs.filter((
        s: { artwork: { thumbHash: string | null } | null },
      ) => s.artwork?.thumbHash).length,
      1,
    );
    const complete = await read(t.f, 'songs', key, partial.etag);
    assertEquals(
      complete.body.songs.filter((
        s: { artwork: { thumbHash: string | null } | null },
      ) => s.artwork?.thumbHash).length,
      2,
    );
    assertEquals(t.calls.length, 3);
    assertEquals(
      complete.body.songs.find((s: { title: string }) => s.title === 'Missing')
        .artwork,
      null,
    );
    await t.clear();
    await t.f.state.set('melofon.artworkFactsPerRequest', '0');
    await read(t.f, 'songs', key);
    assertEquals(t.calls.length, 0);
    await t.f.state.set('melofon.artworkFactsPerRequest', '8');
    await t.f.state.set('artwork.maxPixels', '1');
    await Deno.writeFile(
      t.cover,
      pixelPng(2, 1, new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255])),
    );
    const path = `songs/${t.song.id}`;
    await read(t.f, path, key);
    assertEquals(
      t.calls.length,
      0,
      'core rejects over-budget pixels before native admission',
    );
    await t.f.state.set('artwork.maxPixels', '64000000');
    await read(t.f, path, key);
    assertEquals(t.calls.length, 1);
    assert((await read(t.f, path, key)).body.song.artwork.thumbHash);
  } finally {
    await t.close();
  }
});

Deno.test('API lazy artwork: a source race cannot publish mismatched pixels under the old hash', async () => {
  const t = await fixture();
  try {
    const key = (await t.f.login('bearer')).credential;
    const path = `songs/${t.song.id}`;
    // Change the source after describe but before pixels resolves its snapshot.
    const data = createHatData(t.f.store, t.f.cfg, t.f.state)('melofon');
    const originalGet = t.f.store.hatData.get;
    let replaced = false;
    t.f.store.hatData.get = async (...args) => {
      if (!replaced) {
        replaced = true;
        await Deno.writeFile(t.cover, pixelPng(1, 1, decodeBase64(black.rgba)));
      }
      return originalGet(...args);
    };
    try {
      const first = await read(t.f, path, key);
      assertEquals(first.body.song.artwork.thumbHash, null);
      assertEquals(await data.list(), []);
    } finally {
      t.f.store.hatData.get = originalGet;
    }
    await read(t.f, path, key);
    const next = await read(t.f, path, key);
    assertEquals(next.body.song.artwork.thumbHash, black.hash);
    assertEquals((await data.list()).length, 1);
  } finally {
    await t.close();
  }
});

Deno.test('API lazy artwork: failed persistence retries, and shared nested browse projections see saved facts', async () => {
  const t = await fixture();
  try {
    const key = (await t.f.login('bearer')).credential;
    const path = `songs/${t.song.id}`;
    const originalPut = t.f.store.hatData.put;
    t.f.store.hatData.put = () =>
      Promise.reject(new Error('fixture storage failure'));
    try {
      assertEquals(
        (await read(t.f, path, key)).body.song.artwork.thumbHash,
        null,
      );
      assertEquals(await t.f.store.hatData.list('melofon', ''), []);
    } finally {
      t.f.store.hatData.put = originalPut;
    }
    assertEquals(
      (await read(t.f, path, key)).body.song.artwork.thumbHash,
      null,
    );
    assertEquals(
      (await read(t.f, path, key)).body.song.artwork.thumbHash,
      red.hash,
    );
    assertEquals(t.calls.length, 2);
    const search = (await read(t.f, 'search?query=Album', key)).body;
    assertEquals(search.songs.songs[0].artwork.thumbHash, red.hash);
    assertEquals(search.albums.albums[0].artwork.thumbHash, red.hash);
    const membership =
      (await read(t.f, `artists/${t.song.artistId}/albums`, key)).body;
    assert(
      membership.albums.filter((a: { artwork: unknown }) => a.artwork).every((
        a: { artwork: { thumbHash: string } },
      ) => a.artwork.thumbHash === red.hash),
    );
    const folder = (await read(
      t.f,
      `folders?library=${t.song.libraryId}&path=Artist%2FAlbum`,
      key,
    )).body;
    assertEquals(folder.songs.songs[0].artwork.thumbHash, red.hash);
    assertEquals(t.calls.length, 2);
    await error(
      await t.f.get(`/api/v1/${path}`, undefined, { 'If-None-Match': '*' }),
      401,
      'unauthenticated',
    );
  } finally {
    await t.close();
  }
});
