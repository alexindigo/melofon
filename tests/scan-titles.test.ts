import { assert, assertEquals, assertObjectMatch } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { scanLibrary } from '../src/scan.ts';
import { seedFirstUser } from '../src/users.ts';
import { createUserService } from '../src/user.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { createState } from '../src/state.ts';
import { loadLayers } from '../src/layers.ts';
import { facade } from '../src/facade.ts';
import { tagged } from './helpers/tagged.ts';

const searchOptions = {
  artistCount: 20,
  artistOffset: 0,
  albumCount: 20,
  albumOffset: 0,
  songCount: 20,
  songOffset: 0,
};

Deno.test('scan keeps absent titles null, searches and sorts by filename, and both hats label them', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-titles-' });
  const store = await openStore(`${dir}/db`);
  try {
    const root = `${dir}/music`;
    await Deno.mkdir(root);
    await createLibraries(store).add('Music', root);
    for (
      const [name, title] of [
        ['My_Song', null],
        ['A_File', 'Zulu'],
        ['Z_File', 'Alpha'],
        ['Blank', '   '],
      ] as const
    ) {
      await tagged(`${root}/${name}.mp3`, {
        TPE1: 'Singer',
        TCON: 'Jazz',
        ...(title === null ? {} : { TIT2: title }),
      });
    }
    assertEquals((await scanLibrary(store)).files, 4);
    const library = createLibrary(store);
    const songs = (await library.search3('', searchOptions)).songs;
    assertEquals(songs.map((s) => s.title), ['Alpha', null, null, 'Zulu']);
    const song = songs.find((s) => s.path.endsWith('/My_Song.mp3'))!;
    assertObjectMatch(song, { title: null, fileName: 'My_Song' });
    assertEquals((await library.getSong(song.id))?.title, null);
    assertEquals((await library.search3('My_Song', searchOptions)).songs, [
      song,
    ]);
    assertEquals((await library.search3('A_File', searchOptions)).songs, []);
    assertEquals(
      (await library.songsByGenre('Jazz', { size: 20, offset: 0 })).map((s) =>
        s.id
      ),
      songs.map((s) => s.id),
    );

    const cfg = {
      listen: undefined,
      dataDir: dir,
      user: 'admin',
      password: 'test',
      secret: 'test',
      version: 'test',
    };
    await seedFirstUser(store, cfg);
    const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
    const layers = await loadLayers({
      app: {
        state: createState(store),
        cfg,
        library,
        user: createUserService(store, cfg),
        annotation: createAnnotation(store),
        listens: createListens(store),
      },
    });
    const subsonic = facade(core, layers);
    const params = new URLSearchParams({
      u: 'admin',
      p: 'test',
      v: '1.16.1',
      c: 'title-test',
      f: 'json',
      id: song.id,
    });
    const response = await subsonic(
      new Request(`http://x/rest/getSong?${params}`),
    );
    assertEquals(response.status, 200);
    const body = (await response.json())['subsonic-response'];
    assertEquals(body.status, 'ok');
    assertEquals(body.song.title, '[My Song]');
    params.set('query', 'My_Song');
    const search =
      await (await subsonic(new Request(`http://x/rest/search3?${params}`)))
        .json();
    assertEquals(
      search['subsonic-response'].searchResult3.song[0].title,
      '[My Song]',
    );
    const owntone = facade(core, layers, {
      listenPort: 3689,
      defaultPort: 4534,
      env: {},
    });
    const wire = Number(BigInt(`0x${song.id.slice(0, 8)}`) & 0x7fffffffn);
    const track = await owntone(
      new Request(`http://x/api/library/tracks/${wire}`),
    );
    assertEquals(track.status, 200);
    assertEquals((await track.json()).title, '[My Song]');
    const found = await (await owntone(
      new Request('http://x/api/search?type=tracks&query=My_Song'),
    )).json();
    assertEquals(found.tracks.items[0].title, '[My Song]');
    assertEquals((await library.getSong(song.id))?.title, null);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('scan skips every dot directory, including nested and .melofon audio', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-hidden-' });
  const store = await openStore(`${dir}/db`);
  try {
    const root = `${dir}/music`;
    await Deno.mkdir(root);
    await createLibraries(store).add('Music', root);
    for (
      const rel of [
        'Visible/song.mp3',
        '.hidden/song.mp3',
        '.melofon/candidates/song.mp3',
        'Visible/.nested/song.mp3',
      ]
    ) {
      const path = `${root}/${rel}`;
      await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), {
        recursive: true,
      });
      await tagged(path, {});
    }
    assertEquals((await scanLibrary(store)).files, 1);
    const songs = await createLibrary(store).listSongs({ size: 20, offset: 0 });
    assertEquals(songs.length, 1);
    assert(songs[0].path.endsWith('/Visible/song.mp3'));
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
