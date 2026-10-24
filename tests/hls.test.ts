// tests/hls.test.ts — M4.6 HLS for iSub video: /rest/hls.m3u8 serves the
// playlist (media shape for zero/one bitRate, variant for several) with
// credential-carrying segment URLs under /rest/, and /rest/hls/segment.ts
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

const AUTH = 'u=admin&p=test&v=1.16.1&c=melofon-test';

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-hls-' });
  const store = await openStore(dir);
  const db = store;
  const cfg = {
    listen: undefined,
    dataDir: dir,
    user: 'admin',
    password: 'test',
    secret: 's3cret',
    version: '0.0.0-test',
  };
  await seedFirstUser(store, cfg);
  const libraries = createLibraries(store);
  await libraries.add('Music', await Deno.realPath('tests/fixtures/library'));
  await scanLibrary(store);
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
    const segmentLine = lines.find((l) => l.startsWith('/rest/hls/'));
    assert(segmentLine !== undefined, `no segment URL in:\n${body}`);
    assert(segmentLine!.includes('/rest/hls/segment.ts?'));
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
    const segmentLine = body.split('\n').find((l) =>
      l.startsWith('/rest/hls/')
    )!;
    const res = await app(new Request(`http://x${segmentLine}`));
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
        `http://x/rest/hls.m3u8?id=${videoId}&bitRate=1000@480x360&bitRate=2000&${AUTH}`,
      ),
    );
    assertEquals(res.status, 200);
    const body = await res.text();
    const lines = body.split('\n');
    assert(
      lines.some((l) =>
        /^#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=\d+,RESOLUTION=480x360$/
          .test(l)
      ),
    );
    assert(
      lines.filter((l) => l.startsWith('#EXT-X-STREAM-INF:')).length === 2,
    );
    const rung = lines.find((l) => l.startsWith('/rest/hls.m3u8?'));
    assert(rung !== undefined, `no rung URL in:\n${body}`);
    assert(
      new URL(`http://x${rung}`).searchParams.get('bitRate') === '1000@480x360',
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
