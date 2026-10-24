// tests/stream.test.ts — stream (original bytes, Range, no scrobble) and
// getCoverArt (cover.jpg / placeholder) over the fixture library.
import { assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { seedFirstUser } from '../src/users.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createUserService } from '../src/user.ts';
import { createLibrary } from '../src/library.ts';
import { createStream } from '../src/stream.ts';
import { createFileSource } from '../src/file-source.ts';
import { createMedia } from '../src/media.ts';
import { createArtwork } from '../src/artwork.ts';
import { loadLayers } from '../src/layers.ts';
import { createState } from '../src/state.ts';
import { facade } from '../src/facade.ts';

const AUTH = 'u=admin&p=test&v=1.16.1&c=melofon-test';

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-stream-' });
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
  const library = createLibrary(store);
  const bag = {
    state: createState(store),
    cfg,
    libraries,
    user: createUserService(store, cfg),
    library,
    stream: createStream(
      createMedia(),
      undefined,
      undefined,
      undefined,
      createFileSource(library),
    ),
    artwork: createArtwork(library),
  };
  const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
  const app = facade(core, await loadLayers({ app: bag }));
  return {
    db,
    dir,
    app,
    library,
    close: async () => {
      await db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

async function songId(
  library: ReturnType<typeof createLibrary>,
  title: string,
): Promise<string> {
  const found = await library.search3(title, {
    artistCount: 0,
    artistOffset: 0,
    albumCount: 0,
    albumOffset: 0,
    songCount: 1,
    songOffset: 0,
  });
  return found.songs[0].id;
}

Deno.test('stream returns the original file bytes', async () => {
  const { app, library, close } = await setup();
  try {
    const id = await songId(library, 'First');
    const res = await app(
      new Request(`http://x/rest/stream?${AUTH}&id=${id}`),
    );
    assertEquals(res.status, 200);
    assertEquals(res.headers.get('content-type'), 'audio/mpeg');
    const bytes = new Uint8Array(await res.arrayBuffer());
    const onDisk = await Deno.readFile(
      'tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3',
    );
    assertEquals(bytes.length, onDisk.length);
    assertEquals(bytes.slice(0, 64), onDisk.slice(0, 64));
  } finally {
    await close();
  }
});

Deno.test('stream honors Range with a 206 partial response', async () => {
  const { app, library, close } = await setup();
  try {
    const id = await songId(library, 'First');
    const res = await app(
      new Request(`http://x/rest/stream?${AUTH}&id=${id}`, {
        headers: { range: 'bytes=0-99' },
      }),
    );
    assertEquals(res.status, 206);
    const size = (await Deno.stat(
      'tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3',
    )).size;
    assertEquals(res.headers.get('content-range'), `bytes 0-99/${size}`);
    assertEquals((await res.arrayBuffer()).byteLength, 100);
  } finally {
    await close();
  }
});

Deno.test('stream with an unknown id is envelope code 70; missing id is 10', async () => {
  const { app, close } = await setup();
  try {
    const unknown = await app(
      new Request(`http://x/rest/stream?${AUTH}&id=nope&f=json`),
    );
    const body = (await unknown.json()) as Record<
      string,
      { error: { code: number } }
    >;
    assertEquals(body['subsonic-response'].error.code, 70);

    const missing = await app(
      new Request(`http://x/rest/stream?${AUTH}&f=json`),
    );
    const missingBody = (await missing.json()) as Record<
      string,
      { error: { code: number } }
    >;
    assertEquals(missingBody['subsonic-response'].error.code, 10);
  } finally {
    await close();
  }
});

Deno.test('getCoverArt serves cover.jpg when the album has one', async () => {
  const { app, library, close } = await setup();
  try {
    const found = await library.search3('Fixture Album', {
      artistCount: 0,
      artistOffset: 0,
      albumCount: 1,
      albumOffset: 0,
      songCount: 0,
      songOffset: 0,
    });
    const res = await app(
      new Request(
        `http://x/rest/getCoverArt?${AUTH}&id=${found.albums[0].id}`,
      ),
    );
    assertEquals(res.status, 200);
    assertEquals(res.headers.get('content-type'), 'image/jpeg');
    const bytes = new Uint8Array(await res.arrayBuffer());
    const onDisk = await Deno.readFile(
      'tests/fixtures/library/Fixture Artist/Fixture Album/cover.jpg',
    );
    assertEquals(bytes.length, onDisk.length);
  } finally {
    await close();
  }
});

Deno.test('getCoverArt serves embedded art for album, song, and artist ids', async () => {
  const { app, library, close } = await setup();
  try {
    const ost = await library.search3('Fixture OST', {
      artistCount: 1,
      artistOffset: 0,
      albumCount: 1,
      albumOffset: 0,
      songCount: 1,
      songOffset: 0,
    });
    const ostSong = await library.search3('Theme', {
      artistCount: 0,
      artistOffset: 0,
      albumCount: 0,
      albumOffset: 0,
      songCount: 1,
      songOffset: 0,
    });
    // Album id, song id, and the album artist's id (artist tile).
    const ids = [
      ost.albums[0].id,
      ostSong.songs[0].id,
      ost.albums[0].artistId,
    ];
    for (const id of ids) {
      const res = await app(
        new Request(`http://x/rest/getCoverArt?${AUTH}&id=${id}`),
      );
      assertEquals(res.status, 200);
      assertEquals(res.headers.get('content-type'), 'image/jpeg');
      const bytes = new Uint8Array(await res.arrayBuffer());
      // JPEG magic (the fixture's APIC), not the placeholder PNG.
      assertEquals(Array.from(bytes.slice(0, 2)), [0xff, 0xd8]);
    }
  } finally {
    await close();
  }
});

Deno.test('getCoverArt reports error 70 for unknown entities', async () => {
  const { app, close } = await setup();
  try {
    const res = await app(
      new Request(`http://x/rest/getCoverArt?${AUTH}&id=no-such-id&f=json`),
    );
    assertEquals(res.status, 200);
    // Navidrome server/subsonic/media_retrieval.go:74-76.
    assertEquals((await res.json())['subsonic-response'].error.code, 70);
  } finally {
    await close();
  }
});
