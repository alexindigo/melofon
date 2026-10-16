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
import { parseBuffer } from 'music-metadata';
import { openStore } from '../src/store/index.ts';
import { seedFirstUser } from '../src/users.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createUserService } from '../src/user.ts';
import { createLibrary } from '../src/library.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { createStream } from '../src/stream.ts';
import { createMedia } from '../src/media.ts';
import { loadLayers } from '../src/layers.ts';
import { facade } from '../src/facade.ts';

const AUTH = 'u=admin&p=test&v=1.16.1&c=melofon-test';

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-video-' });
  const store = await openStore(dir);
  const db = store.legacy;
  const cfg = {
    listen: undefined,
    dataDir: dir,
    user: 'admin',
    password: 'test',
    secret: 's3cret',
    version: '0.0.0-test',
  };
  await seedFirstUser(store, cfg);
  const libraries = createLibraries(db);
  await libraries.add('Music', 'tests/fixtures/library');
  await scanLibrary(db);
  const library = createLibrary(db);
  const bag = {
    cfg,
    libraries,
    user: createUserService(store, cfg),
    library,
    annotation: createAnnotation(db),
    listens: createListens(store),
    stream: createStream(createMedia()),
  };
  const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
  const app = facade(core, await loadLayers({ app: bag }));
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
    new Request(`http://x/rest/${op}?${AUTH}&f=json${extra}`),
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
    assertEquals(clip.type, 'video');
    assertEquals(clip.isDir, false);
    assertEquals(clip.album, 'Fixture Album');
    assertEquals(clip.artist, 'Fixture Artist');
    assertEquals(clip.contentType, 'video/mp4');
    assertEquals(clip.suffix, 'mp4');
    assertEquals(clip.path, 'Fixture Artist/Fixture Album/03 - Clip.mp4');
    assertEquals(typeof clip.id, 'string');

    const xml = await app(
      new Request(`http://x/rest/getVideos?${AUTH}`),
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

async function videoId(
  app: (req: Request) => Promise<Response>,
): Promise<string> {
  const videos = await get(app, 'getVideos');
  return (videos.videos as { video: { id: string }[] }).video[0].id;
}

Deno.test('stream on a video id DirectPlays the original container', async () => {
  const { app, close } = await setup();
  try {
    const id = await videoId(app);
    const res = await app(
      new Request(`http://x/rest/stream?${AUTH}&id=${id}`),
    );
    assertEquals(res.status, 200);
    assertEquals(res.headers.get('content-type'), 'video/mp4');
    const bytes = new Uint8Array(await res.arrayBuffer());
    const onDisk = await Deno.readFile(
      'tests/fixtures/library/Fixture Artist/Fixture Album/03 - Clip.mp4',
    );
    assertEquals(bytes.length, onDisk.length);
    // ISO BMFF magic: bytes 4..8 are 'ftyp'.
    assertEquals(new TextDecoder().decode(bytes.slice(4, 8)), 'ftyp');

    // Range still applies (DirectPlay keeps serveFile semantics).
    const partial = await app(
      new Request(`http://x/rest/stream?${AUTH}&id=${id}`, {
        headers: { range: 'bytes=0-99' },
      }),
    );
    assertEquals(partial.status, 206);
    assertEquals((await partial.arrayBuffer()).byteLength, 100);
  } finally {
    await close();
  }
});

Deno.test('stream with format=mp3 ExtractsAudio: audio, not a container', async () => {
  const { app, close } = await setup();
  try {
    const id = await videoId(app);
    const res = await app(
      new Request(`http://x/rest/stream?${AUTH}&id=${id}&format=mp3`),
    );
    assertEquals(res.status, 200);
    assertEquals(res.headers.get('content-type'), 'audio/mpeg');
    const bytes = new Uint8Array(await res.arrayBuffer());
    // ID3v2 magic (tags carried over) or an MPEG frame sync.
    const isId3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
    const isSync = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
    assert(isId3 || isSync, 'mp3 magic missing');
    // Stronger than magic: the bytes really parse as audio with a duration.
    const meta = await parseBuffer(bytes, 'audio/mpeg');
    assert(meta.format.duration !== undefined && meta.format.duration > 0);
    assertEquals(meta.common.title, 'Clip'); // tags carried over the transcode
  } finally {
    await close();
  }
});

Deno.test('stream decision boundaries: raw/unknown formats and audio files', async () => {
  const { app, close } = await setup();
  try {
    const id = await videoId(app);
    // format=raw is Subsonic's "no transcode" — DirectPlay the container.
    const raw = await app(
      new Request(`http://x/rest/stream?${AUTH}&id=${id}&format=raw`),
    );
    assertEquals(raw.headers.get('content-type'), 'video/mp4');
    await raw.body?.cancel();

    // An unknown format is not an audio codec — DirectPlay, not an error.
    const unknown = await app(
      new Request(`http://x/rest/stream?${AUTH}&id=${id}&format=mkv`),
    );
    assertEquals(unknown.headers.get('content-type'), 'video/mp4');
    await unknown.body?.cancel();

    // format=mp3 on an AUDIO file is not ExtractAudio (that branch needs a
    // video) — the original mp3 ships untouched.
    const song = await get(app, 'search3', '&query=First&songCount=1');
    const songId = (song.searchResult3 as { song: { id: string }[] }).song[0]
      .id;
    const res = await app(
      new Request(`http://x/rest/stream?${AUTH}&id=${songId}&format=mp3`),
    );
    assertEquals(res.status, 200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const onDisk = await Deno.readFile(
      'tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3',
    );
    assertEquals(bytes, onDisk);
  } finally {
    await close();
  }
});
