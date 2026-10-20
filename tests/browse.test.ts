// tests/browse.test.ts — browse + search ops over the fixture library:
// getArtists (ID3 index), getArtist, getAlbum, getSong, search3, plus the
// Feishin pull-forwards (getMusicFolders, getOpenSubsonicExtensions,
// getAlbumList2). JSON shapes and XML spot-checks.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { seedFirstUser } from '../src/users.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createUserService } from '../src/user.ts';
import { createLibrary } from '../src/library.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { loadLayers } from '../src/layers.ts';
import { createState } from '../src/state.ts';
import { facade } from '../src/facade.ts';

const AUTH = 'u=admin&p=test&v=1.16.1&c=melofon-test';

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-browse-' });
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
  await libraries.add('Music', 'tests/fixtures/library');
  await scanLibrary(store);
  const bag = {
    state: createState(store),
    cfg,
    libraries,
    user: createUserService(store, cfg),
    library: createLibrary(store),
    annotation: createAnnotation(store),
    listens: createListens(store),
  };
  const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
  const app = facade(core, await loadLayers({ app: bag }));
  return {
    db,
    dir,
    app,
    close: async () => {
      await db.close();
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
  const body = (await res.json()) as Record<string, Envelope>;
  return body['subsonic-response'];
}

Deno.test('getArtists returns the ID3 index of album artists', async () => {
  const { app, close } = await setup();
  try {
    const body = await get(app, 'getArtists');
    const artists = body.artists as {
      ignoredArticles: string;
      index: { name: string; artist: { name: string; albumCount: number }[] }[];
    };
    assertEquals(typeof artists.ignoredArticles, 'string');
    assertEquals(
      artists.index.map((i) => [i.name, i.artist.map((a) => a.name)]),
      [
        ['F', ['Fixture Artist']],
        ['V', ['Various Artists']],
      ],
    );
    assertEquals(artists.index[0].artist[0].albumCount, 1);

    const xml = await app(new Request(`http://x/rest/getArtists?${AUTH}`));
    const text = await xml.text();
    // The envelope carries the Subsonic namespace (strict parsers need it).
    assert(
      text.includes('<subsonic-response xmlns="http://subsonic.org/restapi"'),
    );
    assert(text.includes('<artists ignoredArticles='));
    assert(text.includes('<index name="F">'));
    assert(text.includes('name="Fixture Artist" albumCount="1"'));
  } finally {
    await close();
  }
});

Deno.test('getArtist returns the artist with their albums', async () => {
  const { app, close } = await setup();
  try {
    const artists = await get(app, 'getArtists');
    const index = (artists.artists as { index: { artist: { id: string }[] }[] })
      .index;
    const id = index[0].artist[0].id;
    const body = await get(app, 'getArtist', `&id=${id}`);
    const artist = body.artist as {
      name: string;
      album: { name: string; songCount: number }[];
    };
    assertEquals(artist.name, 'Fixture Artist');
    assertEquals(artist.album.map((a) => [a.name, a.songCount]), [
      ['Fixture Album', 3],
    ]);

    const missing = await get(app, 'getArtist', '&id=nope');
    assertEquals((missing.error as { code: number }).code, 70);
    const noId = await get(app, 'getArtist');
    assertEquals((noId.error as { code: number }).code, 10);
  } finally {
    await close();
  }
});

Deno.test('getAlbum returns the album with ordered child songs', async () => {
  const { app, close } = await setup();
  try {
    const found = await get(app, 'search3', '&query=Fixture%20Album');
    const albumId = (found.searchResult3 as { album: { id: string }[] })
      .album[0].id;
    const body = await get(app, 'getAlbum', `&id=${albumId}`);
    const album = body.album as {
      name: string;
      artist: string;
      artistId: string;
      coverArt: string;
      songCount: number;
      duration: number;
      created: string;
      song: Record<string, unknown>[];
    };
    assertEquals(album.name, 'Fixture Album');
    assertEquals(album.artist, 'Fixture Artist');
    assertEquals(album.coverArt, albumId);
    assertEquals(album.songCount, 3);
    assert(album.duration >= 2);
    // Required by the OpenSubsonic schema: ISO 8601 "date the album was
    // added" (the earliest retained first-seen among its files).
    assertEquals(typeof album.created, 'string');
    assert(album.created.endsWith('Z'));
    assertEquals(album.song.map((s) => [s.track, s.title]), [
      [1, 'First Song'],
      [2, 'Second Song'],
      [3, 'Clip'],
    ]);
    const first = album.song[0];
    assertEquals(first.isDir, false);
    assertEquals(first.type, 'music');
    assertEquals(first.isVideo, false);
    assertEquals(first.contentType, 'audio/mpeg');
    assertEquals(first.suffix, 'mp3');
    assertEquals(first.albumId, albumId);
    assertEquals(typeof first.artistId, 'string');
    assertEquals(typeof first.duration, 'number');
    assertEquals(typeof first.size, 'number');
    assertEquals(
      first.path,
      'Fixture Artist/Fixture Album/01 - First Song.mp3',
    );

    const xml = await app(
      new Request(`http://x/rest/getAlbum?${AUTH}&id=${albumId}`),
    );
    const text = await xml.text();
    assert(text.includes('<album id="'));
    assert((text.match(/<song /g) ?? []).length === 3);

    const missing = await get(app, 'getAlbum', '&id=nope');
    assertEquals((missing.error as { code: number }).code, 70);
  } finally {
    await close();
  }
});

Deno.test('getSong returns one Child', async () => {
  const { app, close } = await setup();
  try {
    const found = await get(app, 'search3', '&query=Theme');
    const songId = (found.searchResult3 as { song: { id: string }[] }).song[0]
      .id;
    const body = await get(app, 'getSong', `&id=${songId}`);
    const song = body.song as Record<string, unknown>;
    assertEquals(song.id, songId);
    assertEquals(song.title, 'Theme');
    assertEquals(song.artist, 'Probe Performer');
    assertEquals(song.album, 'Fixture OST');

    const missing = await get(app, 'getSong', '&id=nope');
    assertEquals((missing.error as { code: number }).code, 70);
    const noId = await get(app, 'getSong');
    assertEquals((noId.error as { code: number }).code, 10);
  } finally {
    await close();
  }
});

Deno.test('search3 matches artists, albums, songs; counts limit results', async () => {
  const { app, close } = await setup();
  try {
    const body = await get(app, 'search3', '&query=fixture');
    const result = body.searchResult3 as {
      artist: { name: string }[];
      album: { name: string }[];
      song: { title: string }[];
    };
    assertEquals(result.artist.map((a) => a.name), ['Fixture Artist']);
    assertEquals(result.album.map((a) => a.name), [
      'Fixture Album',
      'Fixture OST',
    ]);
    assertEquals(result.song.length, 0);

    const songsOnly = await get(
      app,
      'search3',
      '&query=fixture&artistCount=0&albumCount=0&songCount=5',
    );
    const limited = songsOnly.searchResult3 as {
      artist: unknown[];
      album: unknown[];
      song: unknown[];
    };
    assertEquals(limited.artist.length, 0);
    assertEquals(limited.album.length, 0);

    const noQuery = await get(app, 'search3');
    assertEquals((noQuery.error as { code: number }).code, 10);
  } finally {
    await close();
  }
});

Deno.test('getMusicFolders and getOpenSubsonicExtensions answer Feishin probes', async () => {
  const { app, close } = await setup();
  try {
    const folders = await get(app, 'getMusicFolders');
    const musicFolder = (
      folders.musicFolders as { musicFolder: { id: number; name: string }[] }
    ).musicFolder;
    assertEquals(musicFolder.length, 1);
    assertEquals(musicFolder[0].name, 'Music');
    // Folder ids are spec ints on the wire (storage hashes never leave core).
    assertEquals(typeof musicFolder[0].id, 'number');
    const extensions = await get(app, 'getOpenSubsonicExtensions');
    assertEquals(
      extensions.openSubsonicExtensions,
      [
        { name: 'formPost', versions: [1] },
        {
          name: 'transcodeOffset',
          versions: [1],
        },
        { name: 'transcoding', versions: [1] },
        { name: 'songLyrics', versions: [1, 2] },
        { name: 'indexBasedQueue', versions: [1] },
      ],
    );
  } finally {
    await close();
  }
});

Deno.test('getAlbumList2 supports name/random/newest, rejects other types', async () => {
  const { app, close } = await setup();
  try {
    const byName = await get(app, 'getAlbumList2', '&type=alphabeticalByName');
    assertEquals(
      (byName.albumList2 as { album: { name: string }[] }).album.map((a) =>
        a.name
      ),
      ['Fixture Album', 'Fixture OST'],
    );

    const random = await get(app, 'getAlbumList2', '&type=random&size=1');
    assertEquals(
      (random.albumList2 as { album: unknown[] }).album.length,
      1,
    );

    const newest = await get(app, 'getAlbumList2', '&type=newest');
    assertEquals(
      (newest.albumList2 as { album: unknown[] }).album.length,
      2,
    );

    const starred = await get(app, 'getAlbumList2', '&type=starred');
    assertEquals(starred.status, 'ok');
    assertEquals(
      (starred.albumList2 as { album: unknown[] }).album.length,
      0,
    );

    const byYear = await get(app, 'getAlbumList2', '&type=byYear');
    assertEquals((byYear.error as { code: number }).code, 10);

    const unknown = await get(app, 'getAlbumList2', '&type=notAType');
    assertEquals((unknown.error as { code: number }).code, 0);

    const noType = await get(app, 'getAlbumList2');
    assertEquals((noType.error as { code: number }).code, 10);
  } finally {
    await close();
  }
});
