import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { BlobReader, Uint8ArrayWriter, ZipReader } from '@zip-js/zip-js';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { seedFirstUser } from '../src/users.ts';
import { createUserService } from '../src/user.ts';
import { createLibraries } from '../src/libraries.ts';
import { createScan } from '../src/scan.ts';
import { createLibrary } from '../src/library.ts';
import { createState } from '../src/state.ts';
import { createPlaylists } from '../src/playlists.ts';
import { createShares } from '../src/shares.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { createStream } from '../src/stream.ts';
import { createMedia } from '../src/media.ts';
import { createArtwork } from '../src/artwork.ts';
import { createZip } from '../src/zip.ts';
import { imageHeader } from '../src/image-header.ts';
import { loadLayers } from '../src/layers.ts';
import { facade } from '../src/facade.ts';
import { tagged } from './helpers/tagged.ts';

const hostile = '<script>alert("x")</script> & music';
const escaped = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; music';
async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-share-pages-' });
  const store = await openStore(`${dir}/data`);
  const cfg = {
    dataDir: `${dir}/data`,
    user: 'admin',
    password: 'test',
    secret: 's2-test',
    listen: undefined,
    version: 's2-test',
  };
  await seedFirstUser(store, cfg);
  const state = createState(store), library = createLibrary(store);
  const playlists = createPlaylists(store),
    shares = createShares(store, state, library, playlists);
  const libraries = createLibraries(store);
  await Deno.mkdir(`${dir}/music`, { recursive: true });
  await tagged(`${dir}/music/one.mp3`, {
    TIT2: hostile,
    TPE1: 'Artist & <band>',
    TALB: 'Album <one>',
    TPE2: 'Artist',
    TRCK: '1',
  });
  await tagged(`${dir}/music/two.mp3`, {
    TIT2: 'Second\n#EXTINF:999,Injected',
    TPE1: 'Artist',
    TALB: 'Album <one>',
    TPE2: 'Artist',
    TRCK: '2',
  });
  await Deno.copyFile(
    'tests/fixtures/library/Fixture Artist/Fixture Album/cover.jpg',
    `${dir}/music/cover.jpg`,
  );
  await libraries.add('Music', `${dir}/music`);
  await createScan(store).run();
  const songs = await library.listSongs({ offset: 0, size: 10 });
  songs.sort((a, b) => a.path.localeCompare(b.path));
  assertEquals(songs.length, 2);
  assertEquals(songs[0].title, hostile);
  const app = facade(
    await pathfinder({ roots: ['core/'], app: { store, cfg } }),
    await loadLayers({
      app: {
        cfg,
        state,
        library,
        playlists,
        shares,
        annotation: createAnnotation(store),
        listens: createListens(store),
        libraries,
        user: createUserService(store, cfg),
        stream: createStream(createMedia()),
        artwork: createArtwork(library, {
          state,
          dataDir: cfg.dataDir,
          playlists,
        }),
        zip: createZip(),
      },
    }),
  );
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    app,
  );
  const origin = `http://127.0.0.1:${server.addr.port}`;
  const rest = async (op: string, fields: [string, string][] = []) => {
    const params = new URLSearchParams({
      u: 'admin',
      p: 'test',
      v: '1.16.1',
      c: 's2',
      f: 'json',
    });
    for (const [k, v] of fields) params.append(k, v);
    const response = await fetch(`${origin}/rest/${op}.view?${params}`);
    const body = (await response.json())['subsonic-response'];
    assertEquals(body.status, 'ok', JSON.stringify(body));
    return body;
  };
  const create = async (
    ids = songs.map((s) => s.id),
    fields: [string, string][] = [],
  ) =>
    (await rest('createShare', [
      ...ids.map((id): [string, string] => ['id', id]),
      ...fields,
    ])).shares.share[0] as { id: string; url: string };
  return {
    dir,
    store,
    state,
    shares,
    playlists,
    library,
    songs,
    app,
    origin,
    rest,
    create,
    get: (id: string, suffix = '', init?: RequestInit) =>
      fetch(`${origin}/share/${id}${suffix}`, init),
    async close() {
      await server.shutdown();
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('public shares: real unauthenticated HTML escapes metadata, secure headers, contents/player links and REST remains authenticated', async () => {
  const s = await setup();
  try {
    await s.state.set('sharing.enabled', 'true');
    const share = await s.create(undefined, [['description', hostile]]);
    assertEquals(share.url, `${s.origin}/share/${share.id}`);
    const response = await fetch(share.url);
    assertEquals(response.status, 200);
    assertEquals(
      response.headers.get('content-type'),
      'text/html; charset=utf-8',
    );
    assertEquals(
      response.headers.get('Content-Security-Policy'),
      "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'",
    );
    for (
      const [key, value] of [['Referrer-Policy', 'no-referrer'], [
        'X-Content-Type-Options',
        'nosniff',
      ], ['Cache-Control', 'no-store']]
    ) assertEquals(response.headers.get(key), value);
    const html = await response.text();
    assertStringIncludes(html, `<h1>${escaped}</h1>`);
    assertStringIncludes(html, escaped);
    assertStringIncludes(html, 'Artist &amp; &lt;band&gt;');
    assertStringIncludes(html, 'Album &lt;one&gt;');
    assertStringIncludes(html, '0:');
    assert(
      !html.includes('<script') && !html.includes('<link') &&
        !html.includes('/rest/'),
    );
    assertStringIncludes(html, `<img src="${share.url}/cover"`);
    assertStringIncludes(html, `href="${share.url}/m3u"`);
    assert(!html.includes('/zip'));
    for (let n = 0; n < 2; n++) {
      assertStringIncludes(
        html,
        `<audio controls preload="none" src="${share.url}/${n}"></audio>`,
      );
    }
    const unnamed = await s.create([s.songs[0].id]);
    assertStringIncludes(
      await (await s.get(unnamed.id)).text(),
      `<h1>${escaped}</h1>`,
    );
    const auth = await fetch(
      `${s.origin}/rest/getSong.view?id=${s.songs[0].id}&f=json`,
    );
    assertEquals((await auth.json())['subsonic-response'].status, 'failed');
    assertEquals((await s.store.shares.get(share.id))!.visitCount, 1);
    assert((await s.store.shares.get(share.id))!.lastVisitedAtMs !== null);
  } finally {
    await s.close();
  }
});

Deno.test('public shares: original bytes, ranges and strict current-share track positions without counting stream/cover visits', async () => {
  const s = await setup();
  try {
    await s.state.set('sharing.enabled', 'true');
    const a = await s.create([s.songs[0].id]);
    const b = await s.create([s.songs[1].id, s.songs[0].id]);
    const bytes = await Deno.readFile(s.songs[0].path);
    const response = await s.get(a.id, '/0?format=mp3&maxBitRate=1');
    assertEquals(response.status, 200);
    assertEquals(new Uint8Array(await response.arrayBuffer()), bytes);
    const range = await s.get(a.id, '/0', {
      headers: { Range: 'bytes=10-99' },
    });
    assertEquals(range.status, 206);
    assertEquals(
      range.headers.get('content-range'),
      `bytes 10-99/${bytes.length}`,
    );
    assertEquals(
      new Uint8Array(await range.arrayBuffer()),
      bytes.slice(10, 100),
    );
    for (
      const n of ['1', '-1', '01', '1.0', '9007199254740992', s.songs[1].id]
    ) {
      const denied = await s.get(a.id, `/${n}`);
      assertEquals(denied.status, 404);
      await denied.body?.cancel();
    }
    const other = await s.get(b.id, '/0');
    assertEquals(
      new Uint8Array(await other.arrayBuffer()),
      await Deno.readFile(s.songs[1].path),
    );
    const cover = await s.get(a.id, '/cover?size=32&id=unrelated');
    assertEquals(cover.status, 200);
    const header = imageHeader(new Uint8Array(await cover.arrayBuffer()));
    assert(header);
    assertEquals(Math.max(header.width, header.height), 32);
    assertEquals((await s.store.shares.get(a.id))!.visitCount, 0);
  } finally {
    await s.close();
  }
});

Deno.test('public shares: M3U8 absolute ordered scoped URLs, newline-safe metadata and configured public URL prefix', async () => {
  const s = await setup();
  try {
    await s.state.set('sharing.enabled', 'true');
    const share = await s.create([s.songs[1].id, s.songs[0].id, s.songs[1].id]);
    const response = await s.get(share.id, '/m3u');
    assertEquals(response.status, 200);
    assertEquals(
      response.headers.get('content-type'),
      'audio/x-mpegurl; charset=utf-8',
    );
    const m3u = await response.text();
    assert(m3u.startsWith('#EXTM3U\n'));
    assertEquals(
      m3u.split('\n').filter((s) => s.startsWith('#EXTINF:')).length,
      3,
    );
    const urls = m3u.split('\n').filter((s) => s.startsWith('http'));
    assertEquals(urls, [0, 1, 2].map((n) => `${share.url}/${n}`));
    const played = await fetch(urls[1]);
    assertEquals(
      new Uint8Array(await played.arrayBuffer()),
      await Deno.readFile(s.songs[0].path),
    );
    await s.state.set('server.publicUrl', 'https://music.example/house/music/');
    const configured = await (await s.get(share.id, '/m3u')).text();
    assertEquals(
      configured.split('\n').filter((s) => s.startsWith('http')),
      [0, 1, 2].map((n) =>
        `https://music.example/house/music/share/${share.id}/${n}`
      ),
    );
    assertEquals((await s.store.shares.get(share.id))!.visitCount, 2);
  } finally {
    await s.close();
  }
});

Deno.test('public shares: downloadable-only ZIP contains exact tracks, safe names and visit readback', async () => {
  const s = await setup();
  try {
    await s.state.set('sharing.enabled', 'true');
    const denied = await s.create();
    const forbidden = await s.get(denied.id, '/zip');
    assertEquals(forbidden.status, 403);
    await forbidden.body?.cancel();
    assertEquals((await s.store.shares.get(denied.id))!.visitCount, 0);
    await s.state.set('sharing.downloadableByDefault', 'true');
    const share = await s.create(
      [s.songs[1].id, s.songs[0].id, s.songs[1].id],
      [['description', '../雪/"friends",\r\n.zip']],
    );
    const html = await (await s.get(share.id)).text();
    assertStringIncludes(html, `href="${share.url}/zip"`);
    const response = await s.get(share.id, '/zip');
    assertEquals(response.status, 200);
    assertEquals(response.headers.get('content-type'), 'application/zip');
    const disposition = response.headers.get('content-disposition')!;
    assert(
      !disposition.includes('../') && !disposition.includes('\r') &&
        !disposition.includes('\n'),
    );
    assertStringIncludes(disposition, "filename*=UTF-8''");
    const reader = new ZipReader(new BlobReader(await response.blob()));
    try {
      const entries = await reader.getEntries();
      assertEquals(entries.map((e) => e.filename), [
        '01 - two.mp3',
        '02 - one.mp3',
        '03 - two.mp3',
      ]);
      for (const [i, entry] of entries.entries()) {
        assert(!entry.directory);
        assertEquals(
          await entry.getData(new Uint8ArrayWriter()),
          await Deno.readFile(s.songs[i === 1 ? 0 : 1].path),
        );
      }
    } finally {
      await reader.close();
    }
    const listed = (await s.rest('getShares')).shares.share.find((
      r: { id: string },
    ) => r.id === share.id);
    assertEquals(listed.visitCount, 2);
    assert(Number.isFinite(Date.parse(listed.lastVisited)));
  } finally {
    await s.close();
  }
});

Deno.test('public shares: every route rechecks off/missing/expired/deleted shares and live playlist membership', async () => {
  const s = await setup();
  try {
    await s.state.set('sharing.enabled', 'true');
    const share = await s.create();
    const suffixes = ['', '/0', '/m3u', '/cover', '/zip'];
    const statuses = async (id: string, status: number) => {
      for (const suffix of suffixes) {
        const response = await s.get(id, suffix);
        assertEquals(response.status, status, `${id}${suffix}`);
        assertEquals(response.headers.get('cache-control'), 'no-store');
        await response.body?.cancel();
      }
    };
    await statuses('unknown', 404);
    await s.rest('updateShare', [['id', share.id], ['expires', '1']]);
    await statuses(share.id, 410);
    await s.state.set('sharing.enabled', 'false');
    await statuses(share.id, 404);
    await statuses('unknown', 404);
    assertEquals((await s.store.shares.get(share.id))!.visitCount, 0);
    await s.state.set('sharing.enabled', 'true');
    await s.rest('updateShare', [['id', share.id], ['expires', '0']]);
    const playlist = await s.playlists.create('admin', 'Changing', [
      s.songs[0].id,
      s.songs[1].id,
    ]);
    const sharedPlaylist = await s.create([playlist.id]);
    await s.playlists.setTracks('admin', playlist.id, [s.songs[1].id]);
    const current = await s.get(sharedPlaylist.id, '/0');
    assertEquals(
      new Uint8Array(await current.arrayBuffer()),
      await Deno.readFile(s.songs[1].path),
    );
    const removed = await s.get(sharedPlaylist.id, '/1');
    assertEquals(removed.status, 404);
    await removed.body?.cancel();
    await s.rest('deleteShare', [['id', share.id]]);
    await statuses(share.id, 404);
    assertEquals(await s.shares.resolve(share.id), null);
  } finally {
    await s.close();
  }
});

Deno.test('public shares: per-share admission retained until EOF/cancel/abort and live limit with independent shares', async () => {
  const s = await setup();
  const held: Response[] = [];
  try {
    await s.state.set('sharing.enabled', 'true');
    assertEquals(await s.state.getTyped('sharing.maxConcurrentStreams'), 4);
    const share = await s.create(), other = await s.create();
    // Direct facade requests keep real file bodies unconsumed deterministically;
    // the HTTP server would eagerly drain these small fixture files to a socket.
    const request = (
      id = share.id,
      signal?: AbortSignal,
      headers?: HeadersInit,
    ) => s.app(new Request(`${s.origin}/share/${id}/0`, { signal, headers }));
    for (let i = 0; i < 4; i++) {
      const r = await request();
      assertEquals(r.status, 200);
      held.push(r);
    }
    const denied = await request();
    assertEquals(denied.status, 429);
    assertEquals(denied.headers.get('Retry-After'), '1');
    await denied.body?.cancel();
    const independent = await request(other.id);
    assertEquals(independent.status, 200);
    await independent.arrayBuffer();
    await held.pop()!.body!.cancel();
    const reused = await request();
    assertEquals(reused.status, 200);
    assertEquals(
      new Uint8Array(await reused.arrayBuffer()),
      await Deno.readFile(s.songs[0].path),
    );
    for (const response of held.splice(0)) await response.body!.cancel();
    await s.state.set('sharing.maxConcurrentStreams', '1');
    const controller = new AbortController();
    const aborted = await request(share.id, controller.signal);
    held.push(aborted);
    controller.abort();
    const afterAbort = await request();
    assertEquals(afterAbort.status, 200);
    await afterAbort.arrayBuffer();
    const invalidRange = await request(share.id, undefined, {
      Range: 'bytes=999999999-',
    });
    assertEquals(invalidRange.status, 416);
    await invalidRange.body?.cancel();
    const afterError = await request();
    assertEquals(afterError.status, 200);
    await afterError.arrayBuffer();
  } finally {
    for (const response of held) await response.body?.cancel();
    await s.close();
  }
});
