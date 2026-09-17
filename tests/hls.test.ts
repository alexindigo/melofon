// tests/hls.test.ts — M4.6 HLS for iSub video: /rest/hls.m3u8 serves the
// playlist (media shape for zero/one bitRate, variant for several) with
// credential-carrying segment URLs under /rest/, and /rest/hls/segment.ts
// serves cached 10s MPEG-TS slices remuxed by app.media (stream copy — no
// re-encode, no ffmpeg CLI). Fixture: 03 - Clip.mp4 (2s, H.264+AAC).
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openDb } from '../src/db.ts';
import { seedFirstUser } from '../src/users.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createUserService } from '../src/user.ts';
import { createLibrary } from '../src/library.ts';
import { createMedia } from '../src/media.ts';
import { loadLayers } from '../src/layers.ts';
import { facade } from '../src/facade.ts';

const AUTH = 'u=admin&p=test&v=1.16.1&c=melofon-test';

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-hls-' });
  const db = await openDb(dir);
  const cfg = {
    listen: undefined,
    dataDir: dir,
    user: 'admin',
    password: 'test',
    secret: 's3cret',
    version: '0.0.0-test',
  };
  await seedFirstUser(db, cfg);
  const libraries = createLibraries(db);
  await libraries.add('Music', 'tests/fixtures/library');
  await scanLibrary(db);
  const bag = {
    cfg,
    libraries,
    user: createUserService(db, cfg),
    library: createLibrary(db),
    media: createMedia(),
  };
  const core = await pathfinder({ roots: ['core/'], app: { db, cfg } });
  const app = facade(core, await loadLayers({ app: bag }));
  const clips = await db.conn.runAndReadAll(
    "SELECT id FROM files WHERE title = 'Clip'",
  );
  const videoId = (clips.getRowObjects() as { id: string }[])[0].id;
  return {
    db,
    dir,
    app,
    videoId,
    close: async () => {
      db.close();
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
    assert(lines.includes('#EXT-X-TARGETDURATION:10'));
    // The 2s fixture: one 2s segment, then ENDLIST (VOD).
    assert(lines.includes('#EXTINF:2,'));
    const segmentLine = lines.find((l) => l.startsWith('/rest/hls/'));
    assert(segmentLine !== undefined, `no segment URL in:\n${body}`);
    assert(segmentLine!.includes('/rest/hls/segment.ts?'));
    assert(segmentLine!.includes(`id=${videoId}`));
    assert(segmentLine!.includes('segmentIndex=0'));
    assert(segmentLine!.includes('duration=2'));
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
    const stat = await Deno.stat(
      `${dir}/hls/${videoId}/source/seg0.ts`,
    );
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
      lines.includes('#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=1000000'),
    );
    assert(
      lines.includes('#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2000000'),
    );
    const rung = lines.find((l) => l.startsWith('/rest/hls.m3u8?'));
    assert(rung !== undefined, `no rung URL in:\n${body}`);
    assert(rung!.includes('bitRate=1000@480x360'));
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
