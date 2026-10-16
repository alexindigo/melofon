// tests/lists.test.ts — M3 list/search remainder over the opensubsonic hat:
// getAlbumList (v1 envelope), the user-scoped and genre album-list types,
// getGenres (JSON + the XML mixed-content shape), getSongsByGenre, search2.
// Fixture library as one source; genres come from the fixture tags.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { seedFirstUser } from '../src/users.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createUserService } from '../src/user.ts';
import { createLibrary } from '../src/library.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { loadLayers } from '../src/layers.ts';
import { facade } from '../src/facade.ts';

const AUTH = 'u=admin&p=test&v=1.16.1&c=melofon-test';

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-lists-' });
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
    cfg,
    libraries,
    user: createUserService(store, cfg),
    library: createLibrary(store),
    annotation: createAnnotation(store),
    listens: createListens(store),
  };
  const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
  const app = facade(core, await loadLayers({ app: bag }));
  const albumIds = (await rawSql(db).all(
    'SELECT id, name FROM albums ORDER BY name',
  )) as { id: string; name: string }[];
  const songIds = (await rawSql(db).all(
    'SELECT id, title, album_id FROM files ORDER BY album_id, track',
  )) as { id: string; title: string; album_id: string }[];
  return {
    db,
    app,
    albumIds,
    songIds,
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
  const body = await res.json();
  return (body as Record<string, Envelope>)['subsonic-response'];
}

Deno.test('getAlbumList answers with the v1 envelope and legacy fields', async () => {
  const { app, close } = await setup();
  try {
    const body = await get(app, 'getAlbumList', '&type=alphabeticalByName');
    assertEquals(body.status, 'ok');
    const albums = (body.albumList as { album: Record<string, unknown>[] })
      .album;
    assertEquals(albums.map((a) => a.name), ['Fixture Album', 'Fixture OST']);
    assertEquals(albums[0].album, 'Fixture Album');
    assertEquals(albums[0].title, 'Fixture Album');
    assertEquals(albums[0].isDir, true);
  } finally {
    await close();
  }
});

Deno.test('album list types: byArtist, starred, highest, frequent, recent, byGenre', async () => {
  const { app, albumIds, songIds, close } = await setup();
  try {
    const names = (body: Envelope) =>
      (body.albumList2 as { album: { name: string }[] }).album.map((a) =>
        a.name
      );
    const byArtist = await get(
      app,
      'getAlbumList2',
      '&type=alphabeticalByArtist',
    );
    assertEquals(names(byArtist), ['Fixture Album', 'Fixture OST']);

    // starred: star the OST album → only it lists.
    await get(app, 'star', `&albumId=${albumIds[1].id}`);
    const starred = await get(app, 'getAlbumList2', '&type=starred');
    assertEquals(names(starred), ['Fixture OST']);

    // highest: rate Fixture Album 5, OST 3 → Fixture Album first.
    await get(app, 'setRating', `&id=${albumIds[0].id}&rating=5`);
    await get(app, 'setRating', `&id=${albumIds[1].id}&rating=3`);
    const highest = await get(app, 'getAlbumList2', '&type=highest');
    assertEquals(names(highest), ['Fixture Album', 'Fixture OST']);

    // frequent: two plays in Fixture Album, one in the OST → Fixture Album.
    const albumSong = songIds.find((s) => s.album_id === albumIds[0].id)!;
    const ostSong = songIds.find((s) => s.album_id === albumIds[1].id)!;
    await get(app, 'scrobble', `&id=${albumSong.id}&time=1000`);
    await get(app, 'scrobble', `&id=${albumSong.id}&time=2000`);
    await get(app, 'scrobble', `&id=${ostSong.id}&time=3000`);
    const frequent = await get(app, 'getAlbumList2', '&type=frequent');
    assertEquals(names(frequent), ['Fixture Album', 'Fixture OST']);
    // recent: the OST play is the latest → OST first.
    const recent = await get(app, 'getAlbumList2', '&type=recent');
    assertEquals(names(recent), ['Fixture OST', 'Fixture Album']);

    const byGenre = await get(
      app,
      'getAlbumList2',
      '&type=byGenre&genre=Fixture%20Rock',
    );
    assertEquals(names(byGenre), ['Fixture Album']);
    const noGenre = await get(app, 'getAlbumList2', '&type=byGenre');
    assertEquals((noGenre.error as { code: number }).code, 10);
  } finally {
    await close();
  }
});

Deno.test('getGenres lists tag genres with counts, XML uses mixed content', async () => {
  const { app, close } = await setup();
  try {
    const body = await get(app, 'getGenres');
    const genres = (body.genres as {
      genre: { value: string; songCount: number; albumCount: number }[];
    }).genre;
    assertEquals(genres, [
      { value: 'Fixture Rock', songCount: 2, albumCount: 1 },
      { value: 'Fixture Soundtrack', songCount: 1, albumCount: 1 },
    ]);

    const res = await app(
      new Request(`http://x/rest/getGenres?${AUTH}`),
    );
    const xml = await res.text();
    assert(
      xml.includes(
        '<genre songCount="2" albumCount="1">Fixture Rock</genre>',
      ),
      `genre is mixed content in XML, got: ${xml}`,
    );
  } finally {
    await close();
  }
});

Deno.test('getSongsByGenre filters by genre and musicFolderId', async () => {
  const { app, close } = await setup();
  try {
    const body = await get(app, 'getSongsByGenre', '&genre=Fixture%20Rock');
    const songs = (body.songsByGenre as { song: { title: string }[] }).song;
    assertEquals(songs.map((s) => s.title), ['First Song', 'Second Song']);

    const folders = await get(app, 'getMusicFolders');
    const folderId = (
      folders.musicFolders as { musicFolder: { id: string }[] }
    ).musicFolder[0].id;
    const inFolder = await get(
      app,
      'getSongsByGenre',
      `&genre=Fixture%20Rock&musicFolderId=${folderId}`,
    );
    assertEquals(
      (inFolder.songsByGenre as { song: unknown[] }).song.length,
      2,
    );
    const otherFolder = await get(
      app,
      'getSongsByGenre',
      '&genre=Fixture%20Rock&musicFolderId=no-such-folder',
    );
    assertEquals(
      (otherFolder.songsByGenre as { song: unknown[] }).song.length,
      0,
    );
  } finally {
    await close();
  }
});

Deno.test('byYear lists albums in range, both directions, with the year field', async () => {
  const { app, close } = await setup();
  try {
    const names = (body: Envelope) =>
      (body.albumList2 as { album: { name: string }[] }).album.map((a) =>
        a.name
      );
    const all = await get(
      app,
      'getAlbumList2',
      '&type=byYear&fromYear=1900&toYear=2100',
    );
    assertEquals(names(all), ['Fixture Album', 'Fixture OST']);
    const years = (all.albumList2 as { album: { year: number }[] }).album.map(
      (a) => a.year,
    );
    assertEquals(years, [2001, 2019]);

    // fromYear > toYear is reverse chronological (spec).
    const reverse = await get(
      app,
      'getAlbumList2',
      '&type=byYear&fromYear=2100&toYear=1900',
    );
    assertEquals(names(reverse), ['Fixture OST', 'Fixture Album']);

    const narrow = await get(
      app,
      'getAlbumList2',
      '&type=byYear&fromYear=2000&toYear=2010',
    );
    assertEquals(names(narrow), ['Fixture Album']);

    const v1 = await get(
      app,
      'getAlbumList',
      '&type=byYear&fromYear=1900&toYear=2100',
    );
    assertEquals(
      (v1.albumList as { album: { name: string }[] }).album.length,
      2,
    );
  } finally {
    await close();
  }
});

Deno.test('search2 answers with the v1 envelope', async () => {
  const { app, close } = await setup();
  try {
    const body = await get(app, 'search2', '&query=Fixture');
    assertEquals(body.status, 'ok');
    const result = body.searchResult2 as {
      artist: { name: string }[];
      album: Record<string, unknown>[];
      song: { title: string }[];
    };
    assertEquals(result.artist.map((a) => a.name), ['Fixture Artist']);
    assertEquals(result.album.length, 2);
    assertEquals(result.album[0].isDir, true);
    assertEquals(result.song.length, 0);

    const songs = await get(app, 'search2', '&query=Song');
    assertEquals(
      (songs.searchResult2 as { song: { title: string }[] }).song.map((s) =>
        s.title
      ),
      ['First Song', 'Second Song'],
    );
  } finally {
    await close();
  }
});
