// tests/hls.test.ts — M4.6 HLS for iSub video: /rest/hls.m3u8 serves the
// playlist (media shape for zero/one bitRate, variant for several) with
// credential-carrying playlist-relative URLs, and /rest/hls/segment.ts
// serves cached 10s MPEG-TS slices remuxed by app.media (stream copy — no
// re-encode, no ffmpeg CLI). Fixture: 03 - Clip.mp4 (2s, H.264+AAC).
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { seedFirstUser } from '../src/users.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createUserService } from '../src/user.ts';
import { createLibrary } from '../src/library.ts';
import { createMedia } from '../src/media.ts';
import { loadLayers } from '../src/layers.ts';
import { createState } from '../src/state.ts';
import { facade } from '../src/facade.ts';
import { restored } from './helpers/prepared.ts';

const AUTH = 'u=admin&p=test&v=1.16.1&c=melofon-test';

function config(dir: string) {
  return {
    listen: undefined,
    dataDir: dir,
    user: 'admin',
    password: 'test',
    secret: 's3cret',
    version: '0.0.0-test',
  };
}

async function setup() {
  const dir = await restored('hls', async (dir) => {
    const store = await openStore(dir);
    try {
      await seedFirstUser(store, config(dir));
      const libraries = createLibraries(store);
      await libraries.add(
        'Music',
        await Deno.realPath('tests/fixtures/library'),
      );
      await scanLibrary(store);
    } finally {
      await store.close();
    }
  }, 'melofon-hls-');
  const store = await openStore(dir);
  const db = store;
  const cfg = config(dir);
  const libraries = createLibraries(store);
  const bag = {
    state: createState(store),
    cfg,
    libraries,
    user: createUserService(store, cfg),
    library: createLibrary(store),
    media: createMedia(),
  };
  const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
  const app = facade(core, await loadLayers({ app: bag }));
  const clips = await rawSql(db).all(
    "SELECT id FROM files WHERE title = 'Clip'",
  );
  const videoId = (clips as { id: string }[])[0].id;
  return {
    db,
    dir,
    app,
    videoId,
    close: async () => {
      await db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('hls.m3u8 serves a VOD media playlist with credential-carrying segment URLs', async () => {
  const { app, videoId, close } = await setup();
  try {
    const res = await app(
      new Request(`http://x/rest/hls.m3u8?id=${videoId}&${AUTH}`),
    );
    assertEquals(res.status, 200);
    assertEquals(
      res.headers.get('content-type'),
      'application/vnd.apple.mpegurl',
    );
    const body = await res.text();
    const lines = body.split('\n');
    assertEquals(lines[0], '#EXTM3U');
    const duration = parseFloat(
      lines.find((l) => l.startsWith('#EXTINF:'))!.slice(8),
    );
    assert(duration >= 2 && duration < 2.1);
    assert(lines.includes(`#EXT-X-TARGETDURATION:${Math.ceil(duration)}`));
    const segmentLine = lines.find((l) => l.startsWith('hls/'));
    assert(segmentLine !== undefined, `no segment URL in:\n${body}`);
    assert(segmentLine!.startsWith('hls/segment.ts?'));
    assert(segmentLine!.includes(`id=${videoId}`));
    assert(segmentLine!.includes('segmentIndex=0'));
    assert(segmentLine!.includes(`duration=${duration}`));
    // AVPlayer sends no cookies: the credentials ride the URL.
    assert(segmentLine!.includes('u=admin'));
    assert(segmentLine!.includes('p=test'));
    assert(segmentLine!.includes('c=melofon-test'));
    assert(body.trimEnd().endsWith('#EXT-X-ENDLIST'));
  } finally {
    await close();
  }
});

Deno.test('a listed segment serves video/MP2T with the TS sync byte, cached under dataDir', async () => {
  const { app, dir, videoId, close } = await setup();
  try {
    const playlist = await app(
      new Request(`http://x/rest/hls.m3u8?id=${videoId}&${AUTH}`),
    );
    const body = await playlist.text();
    const segmentLine = body.split('\n').find((l) => l.startsWith('hls/'))!;
    const res = await app(
      new Request(new URL(segmentLine, 'http://x/rest/hls.m3u8')),
    );
    assertEquals(res.status, 200);
    assertEquals(res.headers.get('content-type'), 'video/MP2T');
    const bytes = new Uint8Array(await res.arrayBuffer());
    assertEquals(bytes[0], 0x47); // MPEG-TS sync byte
    assert(bytes.length > 1000);

    // The remux landed in the dataDir cache (not /tmp).
    const outputs = [];
    for await (const entry of Deno.readDir(`${dir}/hls`)) {
      outputs.push(entry.name);
    }
    assertEquals(outputs.length, 1);
    const stat = await Deno.stat(`${dir}/hls/${outputs[0]}/seg0.ts`);
    assert(stat.isFile);
  } finally {
    await close();
  }
});

Deno.test('several bitRate params answer a variant playlist', async () => {
  const { app, videoId, close } = await setup();
  try {
    const res = await app(
      new Request(
        `http://x/rest/hls.m3u8?id=${videoId}&bitRate=1000@160x120&bitRate=2000&${AUTH}`,
      ),
    );
    assertEquals(res.status, 200);
    const body = await res.text();
    const lines = body.split('\n');
    assert(
      lines.some((l) =>
        /^#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=\d+,RESOLUTION=160x120$/
          .test(l)
      ),
    );
    assert(
      lines.filter((l) => l.startsWith('#EXT-X-STREAM-INF:')).length === 2,
    );
    const rung = lines.find((l) => l.startsWith('hls.m3u8?'));
    assert(rung !== undefined, `no rung URL in:\n${body}`);
    assert(
      new URL(rung, 'http://x/rest/hls.m3u8').searchParams.get('bitRate') ===
        '1000@160x120',
    );
    assert(rung!.includes('u=admin'));
    assert(
      !body.includes('#EXT-X-ENDLIST'),
      'variant playlists list rungs only',
    );
  } finally {
    await close();
  }
});

Deno.test('missing id is envelope code 10; unknown id is 70', async () => {
  const { app, close } = await setup();
  try {
    const missing = await app(
      new Request(`http://x/rest/hls.m3u8?${AUTH}&f=json`),
    );
    const missingBody = (await missing.json())['subsonic-response'];
    assertEquals(missingBody.status, 'failed');
    assertEquals(missingBody.error.code, 10);

    const unknown = await app(
      new Request(`http://x/rest/hls.m3u8?id=nope&${AUTH}&f=json`),
    );
    assertEquals(
      (await unknown.json())['subsonic-response'].error.code,
      70,
    );
  } finally {
    await close();
  }
});

Deno.test('a segment index past the last slice is 404; a bad index is code 10', async () => {
  const { app, videoId, close } = await setup();
  try {
    const bad = await app(
      new Request(
        `http://x/rest/hls/segment.ts?id=${videoId}&segmentIndex=x&duration=10&${AUTH}&f=json`,
      ),
    );
    assertEquals(
      (await bad.json())['subsonic-response'].error.code,
      10,
    );

    const pastEnd = await app(
      new Request(
        `http://x/rest/hls/segment.ts?id=${videoId}&segmentIndex=9&duration=10&${AUTH}`,
      ),
    );
    assertEquals(pastEnd.status, 404);
  } finally {
    await close();
  }
});

// RFC 8216 §4.1: every URI is relative to its containing playlist. Resolve
// without repairing server output; the proxy exposes ONLY its prefixed paths.
Deno.test('HLS HTTP consumers stay inside root, forced and proxy mounts through every variant and segment', async () => {
  const { app, videoId, close } = await setup();
  const server = Deno.serve(
    { hostname: '0.0.0.0', port: 0, onListen() {} },
    app,
  );
  const origin = `http://melofon.home:${server.addr.port}`;
  const proxy = Deno.serve(
    { hostname: '0.0.0.0', port: 0, onListen() {} },
    (request) => {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/music/')) {
        return new Response(null, { status: 404 });
      }
      url.pathname = url.pathname.slice('/music'.length);
      return fetch(
        new Request(new URL(url.pathname + url.search, origin), request),
      );
    },
  );
  const proxyOrigin = `http://melofon.home:${proxy.addr.port}`;
  const auth = new URLSearchParams({
    u: 'admin',
    p: 'test',
    v: '1.16.1',
    c: 'mount & +',
  });
  const uris = (text: string) =>
    text.split('\n').filter((line) => line.length > 0 && !line.startsWith('#'));
  async function playlist(url: URL, post = false) {
    const response = post
      ? await fetch(new URL(url.pathname, url), {
        method: 'POST',
        body: url.searchParams,
      })
      : await fetch(url);
    assertEquals(response.status, 200);
    assertEquals(
      response.headers.get('content-type'),
      'application/vnd.apple.mpegurl',
    );
    const text = await response.text();
    assert(text.startsWith('#EXTM3U\n'));
    return text;
  }
  function resolve(uri: string, parent: URL, prefix: string) {
    const url = new URL(uri, parent);
    assert(!uri.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(uri), uri);
    assertEquals(url.origin, parent.origin);
    assert(url.pathname.startsWith(prefix), `${uri} escaped ${prefix}`);
    for (const [key, value] of auth) {
      assertEquals(url.searchParams.get(key), value);
    }
    assertEquals(url.searchParams.get('id'), videoId);
    assertEquals(url.searchParams.get('audioTrack'), '1');
    return url;
  }
  try {
    // A root-absolute URI cannot accidentally succeed via the backend's /rest.
    const outsideProxy = await fetch(`${proxyOrigin}/rest/hls.m3u8`);
    assertEquals(outsideProxy.status, 404);
    await outsideProxy.body?.cancel();
    for (
      const [base, prefix] of [
        [origin, '/rest/'],
        [origin, '/_opensubsonic/rest/'],
        [proxyOrigin, '/music/rest/'],
        [proxyOrigin, '/music/_opensubsonic/rest/'],
      ]
    ) {
      for (const post of [false, true]) {
        for (const master of [false, true]) {
          const url = new URL(`${base}${prefix}hls.m3u8`);
          url.search = `${auth}&id=${videoId}&audioTrack=1`;
          if (master) {
            url.searchParams.append('bitRate', '100@160x120');
            url.searchParams.append('bitRate', '200@160x120');
          }
          const text = await playlist(url, post);
          const variants = master
            ? uris(text).map((uri) => resolve(uri, url, prefix))
            : [url];
          assertEquals(variants.length, master ? 2 : 1);
          for (const [rung, variant] of variants.entries()) {
            if (master) {
              assertEquals(variant.pathname, url.pathname);
              assertEquals(
                variant.searchParams.get('bitRate'),
                `${rung ? 200 : 100}@160x120`,
              );
            }
            let media = master ? await playlist(variant) : text;
            for (
              let attempt = 0;
              !media.includes('#EXT-X-ENDLIST') && attempt < 200;
              attempt++
            ) {
              await new Promise((r) => setTimeout(r, 10));
              media = await playlist(variant);
            }
            assert(media.includes('#EXT-X-ENDLIST'), 'fixture HLS completed');
            const segments = uris(media);
            assert(segments.length > 0);
            for (const [index, uri] of segments.entries()) {
              const segment = resolve(uri, variant, prefix);
              assertEquals(segment.pathname, `${prefix}hls/segment.ts`);
              assertEquals(
                segment.searchParams.get('bitRate'),
                variant.searchParams.get('bitRate'),
              );
              assertEquals(
                segment.searchParams.get('segmentIndex'),
                String(index),
              );
              assert(Number(segment.searchParams.get('duration')) > 0);
              const response = await fetch(segment);
              assertEquals(response.status, 200);
              assertEquals(response.headers.get('content-type'), 'video/MP2T');
              const bytes = new Uint8Array(await response.arrayBuffer());
              assert(bytes.length > 1000);
              assertEquals(bytes.length % 188, 0);
              for (let offset = 0; offset < bytes.length; offset += 188) {
                assertEquals(bytes[offset], 0x47);
              }
            }
          }
        }
      }
    }
  } finally {
    await proxy.shutdown();
    await server.shutdown();
    await close();
  }
});
