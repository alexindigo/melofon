import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { decodeBase64, encodeBase64 } from '@std/encoding/base64';
import { createArtwork } from '../src/artwork.ts';
import { createArtworkBackground } from '../src/artwork/background.ts';
import { dominantColor } from '../src/artwork/dominant-color.ts';
import { rgbaToThumbHash } from '../src/artwork/thumbhash.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createFolders } from '../src/folders.ts';
import { createPlaylists } from '../src/playlists.ts';
import { createRadio } from '../src/radio.ts';
import { createPodcasts, type Podcasts } from '../src/podcasts.ts';
import { imagePixels } from '../src/media.ts';
import { imageHash } from '../src/images.ts';
import { scanLibrary } from '../src/scan.ts';
import { apiFixture, error } from './helpers/api.ts';
import { pixelPng } from './helpers/pixel-image.ts';
import { tagged } from './helpers/tagged.ts';
import { waitForWorkerSignal } from './helpers/artwork-worker.ts';
import reference from './fixtures/thumbhash-reference.json' with {
  type: 'json',
};

const red = reference.vectors.find((v) => v.name === 'one-red')!;
const black = reference.vectors.find((v) => v.name === 'one-black')!;

async function fixture(
  options: {
    background?: boolean;
    workerUrl?: URL;
    onComputing?: () => void;
    workerGate?: Int32Array;
    podcasts?: boolean;
  } = {},
) {
  const root = await Deno.makeTempDir({ prefix: 'melofon-artwork-facts-' });
  const source = pixelPng(red.w, red.h, decodeBase64(red.rgba));
  const cover = `${root}/music/Artist/Album/cover.png`;
  let calls: number[][] = [];
  const logs: string[] = [];
  let background: ReturnType<typeof createArtworkBackground> | undefined;
  let radio!: ReturnType<typeof createRadio>;
  let playlists!: ReturnType<typeof createPlaylists>;
  let podcasts: Podcasts | undefined;
  const open = (initial: boolean) =>
    apiFixture({
      storeDir: `${root}/data`,
      services: async (f) => {
        const libraries = createLibraries(f.store);
        const library = createLibrary(f.store);
        radio = createRadio(f.store, {
          state: f.state,
          dataDir: f.cfg.dataDir,
          notify: f.notify,
        });
        playlists = createPlaylists(f.store, f.notify);
        if (options.podcasts) {
          podcasts = await createPodcasts({
            store: f.store,
            state: f.state,
            dataDir: f.cfg.dataDir,
            notify: f.notify,
          });
        }
        const artwork = createArtwork(library, {
          state: f.state,
          dataDir: f.cfg.dataDir,
          facts: f.store.artwork,
          radio,
          playlists,
          podcasts,
          pixels: async (bytes, width, height) => {
            calls.push([width, height]);
            return await imagePixels(bytes, width, height);
          },
        });
        if (options.workerGate) {
          const pixels = artwork.pixels;
          artwork.pixels = async (...args) => {
            const result = await pixels(...args);
            return result.kind === 'pixels' && result.width === 100
              ? { ...result, gate: options.workerGate!.buffer }
              : result;
          };
        }
        if (options.background !== false) {
          background = createArtworkBackground({
            artwork,
            store: f.store,
            state: f.state,
            notify: f.notify!,
            workerUrl: options.workerUrl,
            onComputing: options.onComputing,
            log: { event: (id) => logs.push(id) },
          });
        }
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
          await scanLibrary(f.store, undefined, undefined, undefined, {
            notify: f.notify,
          });
        }
        return {
          library,
          libraries,
          folders: createFolders(f.store),
          artwork,
          radio,
          playlists,
          podcasts,
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
    logs,
    get radio() {
      return radio;
    },
    get playlists() {
      return playlists;
    },
    get calls() {
      return calls;
    },
    get podcasts() {
      return podcasts;
    },
    get background() {
      return background;
    },
    async idle() {
      await background?.idle();
    },
    async rescan() {
      await scanLibrary(f.store, undefined, undefined, undefined, {
        notify: f.notify,
      });
      await background?.idle();
    },
    async restart() {
      await podcasts?.close();
      await background?.close();
      await f.close();
      calls = [];
      f = await open(false);
      await background?.idle();
    },
    async close() {
      await podcasts?.close();
      await background?.close();
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

Deno.test('API core artwork: scan computes before any browse request; lists, details and image responses reuse facts', async () => {
  const t = await fixture();
  try {
    await t.idle();
    assertEquals(
      t.calls,
      [[1, 1]],
      'identical artwork computes once across all references',
    );
    const cookie = (await t.f.login('cookie')).credential;
    const bearer = (await t.f.login('bearer')).credential;
    for (const kind of ['songs', 'albums', 'artists']) {
      const first = await read(t.f, kind, cookie);
      for (const row of first.body[kind]) {
        if (!row.artwork) continue;
        assertEquals([
          row.artwork.thumbHash,
          row.artwork.dominantColor,
          row.artwork.width,
          row.artwork.height,
        ], [red.hash, '#ff0000', 1, 1]);
        const image = await t.f.get(row.artwork.url, bearer);
        assertEquals(image.status, 200);
        assertEquals(new Uint8Array(await image.arrayBuffer()), t.source);
        assertEquals(
          (await read(t.f, `${kind}/${row.id}`, bearer)).body[kind.slice(0, -1)]
            .artwork,
          row.artwork,
        );
      }
      const repeated = await t.f.get(`/api/v1/${kind}`, bearer, {
        'If-None-Match': first.etag,
      });
      assertEquals(repeated.status, 304);
      await repeated.text();
    }
    const search = (await read(t.f, 'search?query=Album', cookie)).body;
    assertEquals(search.songs.songs[0].artwork.thumbHash, red.hash);
    assertEquals(search.albums.albums[0].artwork.thumbHash, red.hash);
    const folder = (await read(
      t.f,
      `folders?library=${t.song.libraryId}&path=Artist%2FAlbum`,
      bearer,
    )).body;
    assertEquals(folder.songs.songs[0].artwork.thumbHash, red.hash);
    assertEquals(t.calls, [[1, 1]], 'requests never compute');
    assertEquals(await t.f.store.hatData.list('melofon', ''), []);
    assert(t.f.peers.every((ip) => ip !== '127.0.0.1' && ip !== '::1'));
    await error(
      await t.f.get(`/api/v1/songs/${t.song.id}`),
      401,
      'unauthenticated',
    );
  } finally {
    await t.close();
  }
});

Deno.test('API core artwork: requests neither compute nor queue missing facts', async () => {
  const t = await fixture({ background: false });
  try {
    const key = (await t.f.login('bearer')).credential;
    for (let n = 0; n < 3; n++) {
      const row = (await read(t.f, `songs/${t.song.id}`, key)).body.song;
      assertEquals([row.artwork.thumbHash, row.artwork.dominantColor], [
        null,
        null,
      ]);
    }
    assertEquals(t.calls, []);
  } finally {
    await t.close();
  }
});

Deno.test('API core artwork: concurrent requests share one background computation and readiness changes validators', async () => {
  let release!: () => void;
  const started = Promise.withResolvers<void>();
  const t = await fixture({ onComputing: () => started.resolve() });
  try {
    await t.idle();
    const key = (await t.f.login('bearer')).credential;
    const original = t.f.store.artwork.savePreview;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.f.store.artwork.savePreview = async (...args) => {
      await blocked;
      await original(...args);
    };
    await Deno.writeFile(t.cover, pixelPng(1, 1, decodeBase64(black.rgba)));
    t.background!.refresh();
    const before = await Promise.all(
      Array.from({ length: 8 }, () => read(t.f, `songs/${t.song.id}`, key)),
    );
    for (const result of before) {
      assertEquals(result.body.song.artwork.thumbHash, null);
    }
    release();
    await t.idle();
    const after = await read(t.f, `songs/${t.song.id}`, key, before[0].etag);
    assertNotEquals(after.etag, before[0].etag);
    assertEquals(after.body.song.artwork.thumbHash, black.hash);
    assertEquals(t.calls, [[1, 1], [1, 1]]);
  } finally {
    release?.();
    await t.close();
  }
});

Deno.test('API core artwork: restart retains core facts, including transparent no-colour results', async () => {
  const t = await fixture();
  try {
    await t.idle();
    await Deno.writeFile(
      t.cover,
      pixelPng(1, 1, new Uint8Array([0, 128, 128, 0])),
    );
    await t.rescan();
    const key = (await t.f.login('bearer')).credential;
    const before =
      (await read(t.f, `songs/${t.song.id}`, key)).body.song.artwork;
    assertEquals(before.dominantColor, null);
    assert(typeof before.thumbHash === 'string');
    await t.restart();
    assertEquals(t.calls, []);
    assertEquals(
      (await read(t.f, `songs/${t.song.id}`, key)).body.song.artwork,
      before,
    );
    assertEquals(await t.f.store.hatData.list('melofon', ''), []);
  } finally {
    await t.close();
  }
});

Deno.test('API core artwork: rescan discovers changed sources, dimensions and pixel admission without requests', async () => {
  const t = await fixture();
  try {
    await t.idle();
    const key = (await t.f.login('bearer')).credential;
    const before =
      (await read(t.f, `songs/${t.song.id}`, key)).body.song.artwork;
    await t.f.state.set('artwork.maxPixels', '1');
    await t.idle();
    await Deno.writeFile(
      t.cover,
      pixelPng(
        137,
        71,
        new Uint8Array(
          Array.from({ length: 137 * 71 }, () => [0, 0, 0, 255]).flat(),
        ),
      ),
    );
    await t.rescan();
    const missing =
      (await read(t.f, `songs/${t.song.id}`, key)).body.song.artwork;
    assertEquals([missing.width, missing.height, missing.thumbHash], [
      137,
      71,
      null,
    ]);
    await t.f.state.set('artwork.maxPixels', '64000000');
    await t.idle();
    const after =
      (await read(t.f, `songs/${t.song.id}`, key)).body.song.artwork;
    assertEquals(after.dominantColor, '#000000');
    assertNotEquals(before.version, after.version);
    assertEquals(t.calls.at(-1), [100, 51]);
    const count = t.calls.length;
    await t.f.state.set('artwork.jpegQuality', '40');
    await t.idle();
    const policy =
      (await read(t.f, `songs/${t.song.id}`, key)).body.song.artwork;
    assertNotEquals(policy.version, after.version);
    assertEquals(policy.thumbHash, after.thumbHash);
    assertEquals(t.calls.length, count);
    await Deno.remove(t.song.path);
    await t.rescan();
    await error(
      await t.f.get(`/api/v1/songs/${t.song.id}`, key),
      404,
      'not_found',
    );
  } finally {
    await t.close();
  }
});

Deno.test('API core artwork: Worker failure logs and leaves null; later owner changes retry', async () => {
  const t = await fixture({
    workerUrl: new URL(
      'data:application/javascript,throw new Error("fixture worker failure")',
    ),
  });
  try {
    await t.idle();
    assert(t.logs.includes('artwork_facts_failed'));
    const key = (await t.f.login('bearer')).credential;
    const row = (await read(t.f, `songs/${t.song.id}`, key)).body.song.artwork;
    assertEquals([row.thumbHash, row.dominantColor], [null, null]);
    const count = t.calls.length;
    await read(t.f, 'songs', key);
    assertEquals(t.calls.length, count, 'requests do not retry failed Workers');
    t.background!.refresh();
    await t.idle();
    assertEquals(t.calls.length, count + 1);
  } finally {
    await t.close();
  }
});

Deno.test('API core artwork: failed persistence remains retryable without poisoning the cache', async () => {
  const t = await fixture();
  try {
    await t.idle();
    const original = t.f.store.artwork.savePreview;
    t.f.store.artwork.savePreview = () =>
      Promise.reject(new Error('fixture storage failure'));
    await Deno.writeFile(t.cover, pixelPng(1, 1, decodeBase64(black.rgba)));
    await t.rescan();
    const key = (await t.f.login('bearer')).credential;
    assertEquals(
      (await read(t.f, `songs/${t.song.id}`, key)).body.song.artwork.thumbHash,
      null,
    );
    t.f.store.artwork.savePreview = original;
    t.background!.refresh();
    await t.idle();
    assertEquals(
      (await read(t.f, `songs/${t.song.id}`, key)).body.song.artwork.thumbHash,
      black.hash,
    );
  } finally {
    await t.close();
  }
});

Deno.test('API core artwork: uploaded radio covers, generated tiles and private playlists compute at owner changes', async () => {
  const t = await fixture();
  try {
    await t.idle();
    const station = await t.radio.create({
      name: 'Test station',
      streamUrl: 'http://radio.home/live',
      homePageUrl: null,
    });
    assert(!('invalid' in station));
    const list = await t.playlists.create('admin', 'Private', [t.song.id]);
    await t.idle();
    const key = (await t.f.login('bearer')).credential;
    const generated =
      (await read(t.f, 'radio-stations', key)).body.radioStations[0].artwork;
    assert(typeof generated.thumbHash === 'string');
    const playlistResponse = await t.f.get(`/api/v1/playlists/${list.id}`, key);
    assertEquals(playlistResponse.status, 200);
    assertEquals(
      playlistResponse.headers.get('cache-control'),
      'private, no-store',
    );
    const playlist = (await playlistResponse.json()).playlist;
    assert(typeof playlist.artwork.thumbHash === 'string');
    await t.radio.putArtwork(
      station.id,
      pixelPng(1, 1, decodeBase64(black.rgba)),
    );
    await t.idle();
    const uploaded =
      (await read(t.f, 'radio-stations', key)).body.radioStations[0].artwork;
    assertEquals([uploaded.thumbHash, uploaded.dominantColor], [
      black.hash,
      '#000000',
    ]);
    assertNotEquals(uploaded.version, generated.version);
  } finally {
    await t.close();
  }
});

Deno.test('API core artwork: adversarial 100x100 computation does not block another HTTP response', async () => {
  let observe = false;
  const entered = Promise.withResolvers<void>();
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const release = () => {
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
  };
  const t = await fixture({
    workerUrl: new URL('./fixtures/artwork-gated-worker.ts', import.meta.url),
    workerGate: gate,
    onComputing: () => {
      if (observe) entered.resolve();
    },
  });
  try {
    await t.idle();
    const key = (await t.f.login('bearer')).credential;
    const rgba = new Uint8Array(100 * 100 * 4);
    let seed = 123456789;
    for (let i = 0; i < rgba.length; i += 4) {
      for (let j = 0; j < 3; j++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
        rgba[i + j] = seed >>> 24;
      }
      rgba[i + 3] = 255;
    }
    const expected = {
      thumbHash: encodeBase64(rgbaToThumbHash(100, 100, rgba)),
      dominantColor: dominantColor(rgba) || null,
    };
    await Deno.writeFile(t.cover, pixelPng(100, 100, rgba));
    observe = true;
    let completed = false;
    const save = t.f.store.artwork.savePreview;
    t.f.store.artwork.savePreview = (...args) => {
      completed = true;
      return save(...args);
    };
    t.background!.refresh();
    await waitForWorkerSignal(entered.promise, 'computation start');
    const other = await t.f.get('/api/v1/me', key);
    assertEquals(other.status, 200);
    await other.json();
    assertEquals(
      completed,
      false,
      'the other HTTP response must complete during the real Worker computation',
    );
    release();
    await t.idle();
    assertEquals(completed, true);
    const actual =
      (await read(t.f, `songs/${t.song.id}`, key)).body.song.artwork;
    assertEquals({
      thumbHash: actual.thumbHash,
      dominantColor: actual.dominantColor,
    }, expected);
  } finally {
    release();
    await t.close();
  }
});

Deno.test('API core artwork: podcast cover acquisition computes facts before the first native read', async () => {
  const t = await fixture({ podcasts: true });
  const podcastCover = pixelPng(1, 1, decodeBase64(black.rgba));
  const server = Deno.serve(
    { hostname: '0.0.0.0', port: 0, onListen() {} },
    (request): Response => {
      if (new URL(request.url).pathname === '/cover.png') {
        return new Response(podcastCover, {
          headers: { 'content-type': 'image/png' },
        });
      }
      return new Response(
        `<rss version="2.0"><channel><title>Artwork podcast</title><image><url>http://melofon.home:${server.addr.port}/cover.png</url></image></channel></rss>`,
      );
    },
  );
  try {
    await t.idle();
    const channel = await t.podcasts!.addChannel(
      `http://melofon.home:${server.addr.port}/feed`,
    );
    assertEquals(channel.status, 'completed');
    await t.podcasts!.idle();
    await t.idle();
    const key = (await t.f.login('bearer')).credential;
    const response = await t.f.get(`/api/v1/podcasts/${channel.id}`, key);
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals([
      body.podcast.artwork.thumbHash,
      body.podcast.artwork.dominantColor,
    ], [black.hash, '#000000']);
  } finally {
    await server.shutdown();
    await t.close();
  }
});

Deno.test('API core artwork: a source race cannot persist new pixels under an old source hash', async () => {
  const t = await fixture();
  try {
    await t.idle();
    const blackImage = pixelPng(1, 1, decodeBase64(black.rgba));
    const oldHash = await imageHash(blackImage);
    const greenImage = pixelPng(1, 1, new Uint8Array([0, 255, 0, 255]));
    const preview = t.f.store.artwork.preview;
    let replaced = false;
    t.f.store.artwork.preview = async (hash) => {
      if (hash === oldHash && !replaced) {
        replaced = true;
        await Deno.writeFile(t.cover, greenImage);
      }
      return await preview(hash);
    };
    await Deno.writeFile(t.cover, blackImage);
    t.background!.refresh();
    await t.idle();
    assert(replaced);
    assertEquals(
      await preview(oldHash),
      null,
      'mismatched snapshot was not saved',
    );
    const key = (await t.f.login('bearer')).credential;
    const actual =
      (await read(t.f, `songs/${t.song.id}`, key)).body.song.artwork;
    assertEquals(actual.dominantColor, '#00ff00');
    assertEquals(
      actual.thumbHash,
      encodeBase64(rgbaToThumbHash(1, 1, new Uint8Array([0, 255, 0, 255]))),
    );
  } finally {
    await t.close();
  }
});
