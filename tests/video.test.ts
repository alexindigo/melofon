// tests/video.test.ts — M4 music videos: getVideos lists the fixture video,
// getVideoInfo answers the minimal shape, and Child payloads carry isVideo —
// the video shares the song id namespace (Blue Tattoo: one album folder).
//
// The fixture (tests/fixtures/library/Fixture Artist/Fixture Album/03 -
// Clip.mp4) was authored ONCE with the host's ffmpeg CLI:
//   ffmpeg -f lavfi -i "testsrc2=size=160x120:rate=10:duration=2" \
//     -f lavfi -i "sine=frequency=440:duration=2:sample_rate=44100" \
//     -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 96k \
//     -metadata title="Clip" -metadata artist="Fixture Artist" \
//     -metadata album="Fixture Album" \
//     -metadata album_artist="Fixture Artist" -metadata track="3" \
//     -movflags +faststart "03 - Clip.mp4"
// Authoring only: product code never spawns ffmpeg/ffprobe (plan §8).
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openDb } from '../src/db.ts';
import { seedFirstUser } from '../src/users.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createUserService } from '../src/user.ts';
import { createLibrary } from '../src/library.ts';

const AUTH = 'u=admin&p=test&v=1.16.1&c=melofon-test';

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-video-' });
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
  const library = createLibrary(db);
  const bag = {
    cfg,
    libraries,
    user: createUserService(db, cfg),
    library,
  };
  const app = await pathfinder({ roots: ['layers/opensubsonic/'], app: bag });
  return {
    db,
    dir,
    app,
    library,
    close: async () => {
      db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

type Envelope = Record<string, unknown> & { status: string };

async function get(
  app: (req: Request) => Promise<Response>,
  op: string,
  extra = '',
): Promise<Envelope> {
  const res = await app(
    new Request(`http://x/rest/${op}.view?${AUTH}&f=json${extra}`),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  return (body as Record<string, Envelope>)['subsonic-response'];
}

Deno.test('getVideos lists the fixture video as a Child with isVideo', async () => {
  const { app, close } = await setup();
  try {
    const body = await get(app, 'getVideos');
    const videos = (body.videos as { video: Record<string, unknown>[] }).video;
    assertEquals(videos.length, 1);
    const clip = videos[0];
    assertEquals(clip.title, 'Clip');
    assertEquals(clip.isVideo, true);
    assertEquals(clip.isDir, false);
    assertEquals(clip.album, 'Fixture Album');
    assertEquals(clip.artist, 'Fixture Artist');
    assertEquals(clip.contentType, 'video/mp4');
    assertEquals(clip.suffix, 'mp4');
    assertEquals(clip.path, 'Fixture Artist/Fixture Album/03 - Clip.mp4');
    assertEquals(typeof clip.id, 'string');

    const xml = await app(
      new Request(`http://x/rest/getVideos.view?${AUTH}`),
    );
    const text = await xml.text();
    assert(text.includes('<videos>'));
    assert((text.match(/<video /g) ?? []).length === 1);
    assert(text.includes('isVideo="true"'));
  } finally {
    await close();
  }
});

Deno.test('getVideoInfo answers the minimal shape; errors on bad ids', async () => {
  const { app, close } = await setup();
  try {
    const videos = await get(app, 'getVideos');
    const id = (videos.videos as { video: { id: string }[] }).video[0].id;
    const body = await get(app, 'getVideoInfo', `&id=${id}`);
    assertEquals(body.videoInfo, { id });

    const unknown = await get(app, 'getVideoInfo', '&id=nope');
    assertEquals((unknown.error as { code: number }).code, 70);
    const missing = await get(app, 'getVideoInfo');
    assertEquals((missing.error as { code: number }).code, 10);

    // A plain song id is not a video — same not-found, not a videoInfo.
    const song = await get(app, 'search3', '&query=First&songCount=1');
    const songId =
      (song.searchResult3 as { song: { id: string }[] }).song[0].id;
    const notVideo = await get(app, 'getVideoInfo', `&id=${songId}`);
    assertEquals((notVideo.error as { code: number }).code, 70);
  } finally {
    await close();
  }
});

Deno.test('the video id resolves as a song child with isVideo (one namespace)', async () => {
  const { app, close } = await setup();
  try {
    const videos = await get(app, 'getVideos');
    const id = (videos.videos as { video: { id: string }[] }).video[0].id;
    const body = await get(app, 'getSong', `&id=${id}`);
    const song = body.song as Record<string, unknown>;
    assertEquals(song.id, id);
    assertEquals(song.isVideo, true);
    assertEquals(song.title, 'Clip');
  } finally {
    await close();
  }
});
