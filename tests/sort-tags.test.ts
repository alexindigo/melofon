import { assert, assertEquals } from '@std/assert';
import { dirname } from 'node:path';
import { scanFixture } from './helpers/scans.ts';
import { tagged } from './helpers/tagged.ts';
import { createLibrary } from '../src/library.ts';
import { createLibraries } from '../src/libraries.ts';
import { createScan } from '../src/scan.ts';
import { createState } from '../src/state.ts';
import { createTagReader } from '../src/scan-tags.ts';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { stableId } from '../src/albums.ts';

const page = { size: 100, offset: 0 };
const search = {
  artistCount: 100,
  artistOffset: 0,
  albumCount: 100,
  albumOffset: 0,
  songCount: 100,
  songOffset: 0,
};
const names = (rows: { name: string | null }[]) => rows.map((r) => r.name);
const titles = (rows: { title: string | null }[]) => rows.map((r) => r.title);
async function write(path: string, tags: Record<string, string>) {
  await Deno.mkdir(dirname(path), { recursive: true });
  await tagged(path, tags);
}

Deno.test('sort tags: real scan facts and every core name-list opt in; hats retain their order', async () => {
  const f = await scanFixture();
  try {
    for (
      const [artist, sort] of [
        ['The Beatles', 'Beatles, The'],
        ['Calvin', ''],
        ['Zebra', 'Aardvark'],
        ['Delta', 'The First'],
      ]
    ) {
      await write(`${f.root}/A/${artist}/song.mp3`, {
        TIT2: artist,
        TALB: artist,
        TPE1: artist,
        TPE2: artist,
        TSOP: sort,
        TSO2: sort,
        TSOA: sort,
        TSOT: sort,
        TCON: 'Rock',
        TDRC: '2000',
      });
    }
    const folder = await f.add('A');
    await f.scan({ mode: 'full' });
    const library = createLibrary(f.store);
    const normal = ['Calvin', 'Delta', 'The Beatles', 'Zebra'];
    const sorted = ['Zebra', 'The Beatles', 'Calvin', 'Delta'];
    const options = { sortTags: true, ignoredArticles: ['The'] };
    assertEquals(names(await library.listArtists()), normal);
    assertEquals(
      names(await library.listArtists(undefined, { sortTags: false })),
      normal,
    );
    assertEquals(names(await library.listArtists(folder.id, options)), sorted);
    assertEquals(
      names(await library.listArtists(undefined, { ignoredArticles: ['The'] })),
      ['The Beatles', 'Calvin', 'Delta', 'Zebra'],
    );
    const artists = await library.listArtists(undefined, options);
    assertEquals(artists.map((a) => a.sortKey), [
      'aardvark',
      'beatles, the',
      'calvin',
      'the first',
    ]);
    assertEquals(
      (await library.listArtists(undefined, { sortTags: true })).map((a) =>
        a.sortKey
      ),
      ['Aardvark', 'Beatles, The', 'Calvin', 'The First'],
    );
    const beatles = artists.find((a) => a.name === 'The Beatles')!;
    assertEquals(
      (await library.getArtist(beatles.id))?.sortName,
      'Beatles, The',
    );
    const song = (await library.listSongs(page)).find((s) =>
      s.artistId === beatles.id
    )!;
    assertEquals(song.metadata?.artistSortName, 'Beatles, The');
    assertEquals(song.metadata?.albumArtistSortName, 'Beatles, The');
    assertEquals(song.metadata?.sortTitle, 'Beatles, The');
    assertEquals(
      (await library.getAlbum(song.albumId!))?.album.metadata?.sortName,
      'Beatles, The',
    );
    for (const sort of ['name', 'artist'] as const) {
      assertEquals(names(await library.listAlbums({ ...page, sort })), normal);
      assertEquals(
        names(await library.listAlbums({ ...page, sort, ...options })),
        sorted,
      );
    }
    // The remaining modes retain their primary key and use sort tags only for
    // name ties. All primary values here are equal by construction.
    const q = rawSql(f.store);
    await q.run(
      `INSERT INTO ratings SELECT u.id, al.id, 4 FROM users u CROSS JOIN albums al WHERE u.name = 'admin'`,
    );
    await q.run(
      `INSERT INTO listens SELECT u.id, f.id, '2026-01-01T00:00:00Z', 1000, 'test' FROM users u CROSS JOIN files f WHERE u.name = 'admin'`,
    );
    for (
      const sort of ['highest', 'frequent', 'recent', 'genre', 'year'] as const
    ) {
      const args = {
        ...page,
        sort,
        username: 'admin',
        genre: 'Rock',
        fromYear: 2000,
        toYear: 2000,
      };
      assertEquals(
        names(await library.listAlbums({ ...args, ignoredArticles: ['The'] })),
        normal,
      );
      assertEquals(
        names(await library.listAlbums({ ...args, ...options })),
        sorted,
      );
    }
    assertEquals(titles(await library.songsByGenre('Rock', page)), normal);
    assertEquals(
      titles(await library.songsByGenre('Rock', { ...page, ...options })),
      sorted,
    );
    const found = await library.search3('', { ...search, ...options });
    assertEquals(names(found.artists), sorted);
    assertEquals(names(found.albums), sorted);
    assertEquals(titles(found.songs), sorted);
    const off = await library.search3('', search);
    assertEquals(names(off.artists), normal);
    assertEquals(names(off.albums), normal);
    assertEquals(titles(off.songs), normal);

    // Real HTTP on the non-loopback VM name: both protocol consumers stay off.
    const rest = (await f.rest('search3', { query: '' })).searchResult3;
    assertEquals(names(rest.artist), normal);
    assertEquals(names(rest.album), normal);
    assertEquals(titles(rest.song), normal);
    const indexed = (await f.rest('getArtists')).artists.index;
    assertEquals(indexed.map((i: { name: string }) => i.name), [
      'B',
      'C',
      'D',
      'X-Z',
    ]);
    const response = await fetch(
      `${f.origin.replace(/:\d+$/, `:${f.extraPorts[0]}`)}/api/library/artists`,
      { signal: AbortSignal.timeout(5000) },
    );
    assertEquals(response.status, 200);
    const own = await response.json();
    assertEquals(names(own.items), normal);
  } finally {
    await f.close();
  }
});

Deno.test('sort tags: album-by-artist and artistless lists honor fallback articles and stable id ties', async () => {
  const f = await scanFixture();
  try {
    for (const role of ['Artist', '']) {
      for (
        const [name, sort] of [['The Beta', 'Same'], ['The Alpha', 'Same'], [
          'The Coda',
          '',
        ]]
      ) {
        await write(`${f.root}/A/${role || 'unknown'}/${name}/song.mp3`, {
          TIT2: name,
          TALB: name,
          TPE1: role,
          TSOT: sort,
          TSOA: sort,
          TCON: 'Rock',
        });
      }
    }
    await f.add('A');
    await f.scan();
    const library = createLibrary(f.store);
    const id = await stableId('artist', 'Artist');
    const opts = { sortTags: true, ignoredArticles: ['The'] };
    const normal = ['The Alpha', 'The Beta', 'The Coda'];
    assertEquals(names(await library.albumsByArtist(id)), normal);
    assertEquals(names(await library.albumsWithoutArtist('unknown')), normal);
    for (
      const rows of [
        await library.albumsByArtist(id, opts),
        await library.albumsWithoutArtist('unknown', opts),
      ]
    ) {
      assertEquals(rows[0].name, 'The Coda');
      assertEquals(
        rows.slice(1).map((r) => r.id),
        rows.slice(1).map((r) => r.id).sort(),
      );
    }
    const songs = await library.songsByGenre('Rock', { ...page, ...opts });
    assertEquals(titles(songs).slice(0, 2), ['The Coda', 'The Coda']);
    assertEquals(
      songs.slice(2).map((s) => s.id),
      songs.slice(2).map((s) => s.id).sort(),
    );
    const albums = await library.listAlbums({ ...page, sort: 'name', ...opts });
    assertEquals(
      albums.slice(2).map((a) => a.id),
      albums.slice(2).map((a) => a.id).sort(),
    );
    const paged = await library.listAlbums({
      ...opts,
      sort: 'name',
      size: 1,
      offset: 2,
    });
    assertEquals(paged, [albums[2]]);
    const found = await library.search3('', {
      ...search,
      ...opts,
      songCount: 1,
      songOffset: 2,
    });
    assertEquals(found.songs, [songs[2]]);
  } finally {
    await f.close();
  }
});

Deno.test('sort tags: artist id ties, library scoping and paged search share the chosen keys', async () => {
  const f = await scanFixture();
  try {
    for (const name of ['Beta', 'Alpha']) {
      await write(`${f.root}/A/${name}/song.mp3`, {
        TIT2: name,
        TALB: name,
        TPE1: name,
        TSOP: 'Same',
        TSOA: 'Same',
        TSOT: 'Same',
        TCON: 'Rock',
      });
    }
    await write(`${f.root}/B/song.mp3`, {
      TIT2: 'Outside',
      TALB: 'Outside',
      TPE1: 'Outside',
      TSOP: 'First',
    });
    const a = await f.add('A');
    await f.add('B');
    await f.scan();
    const library = createLibrary(f.store);
    const options = { sortTags: true, folderId: a.id, ignoredArticles: [] };
    const artists = await library.listArtists(a.id, options);
    assertEquals(artists.map((r) => r.id), artists.map((r) => r.id).sort());
    assertEquals(artists.map((r) => r.sortKey), ['same', 'same']);
    const albums = await library.listAlbums({
      ...options,
      ...page,
      sort: 'artist',
    });
    assertEquals(albums.map((r) => r.id), albums.map((r) => r.id).sort());
    const found = await library.search3('', { ...options, ...search });
    assertEquals(
      found.artists,
      artists.map(({ sortKey: _key, ...row }) => row),
    );
    assertEquals(names(found.artists).sort(), ['Alpha', 'Beta']);
    const next = await library.search3('', {
      ...options,
      ...search,
      artistOffset: 1,
      artistCount: 1,
    });
    assertEquals(next.artists, [found.artists[1]]);
    assertEquals(titles(found.songs).sort(), ['Alpha', 'Beta']);
    assertEquals(names(found.albums).sort(), ['Alpha', 'Beta']);
  } finally {
    await f.close();
  }
});

Deno.test('sort tags: artist votes count files and real credit roles, resolve ties deterministically and clear removed tags', async () => {
  const f = await scanFixture();
  try {
    const files: Record<string, Record<string, string>> = {
      a: { TPE1: 'Majority', TSOP: 'Zebra' },
      b: { TPE1: 'Majority', TSOP: 'Beta' },
      c: { TPE1: 'Performer', TPE2: 'Majority', TSO2: 'Beta' },
      d: { TPE1: 'Double', TPE2: 'Double', TSOP: 'Zebra', TSO2: 'Zebra' },
      e: { TPE1: 'Double', TSOP: 'Alpha' },
      f: { TPE1: 'Orphan', TSO2: 'Incorrect' },
      g: { TPE2: 'Album Only', TSO2: 'Album, Only' },
      h: { TPE1: 'Blank', TSOP: '   ' },
    };
    for (const [path, tags] of Object.entries(files)) {
      await write(`${f.root}/A/${path}/song.mp3`, {
        TIT2: path,
        TALB: path,
        ...tags,
      });
    }
    await f.add('A');
    await f.scan();
    const library = createLibrary(f.store);
    const sortName = async (name: string) =>
      (await library.artistById(await stableId('artist', name)))?.sortName;
    assertEquals(await sortName('Majority'), 'Beta');
    assertEquals(await sortName('Double'), 'Alpha');
    assertEquals(await sortName('Orphan'), undefined);
    assertEquals(await sortName('Album Only'), 'Album, Only');
    assertEquals(await sortName('Blank'), undefined);
    // A scoped quick scan still aggregates the preserved files' stored facts.
    await f.scan({
      folder: {
        library: (await f.store.catalog.listLibraries())[0].id,
        path: 'a',
      },
    });
    assertEquals(await sortName('Majority'), 'Beta');
    for (const path of ['a', 'b', 'c']) {
      const { TSOP: _track, TSO2: _album, ...tags } = files[path];
      await write(`${f.root}/A/${path}/song.mp3`, {
        TIT2: path,
        TALB: path,
        ...tags,
      });
    }
    await f.scan({ mode: 'full' });
    assertEquals(await sortName('Majority'), undefined);
  } finally {
    await f.close();
  }
});

Deno.test('sort tags: missing title and album tags keep filesystem fallbacks and null facts', async () => {
  const f = await scanFixture();
  try {
    await write(`${f.root}/A/zebra/zebra.mp3`, {
      TSOA: 'Alpha',
      TSOT: 'Alpha',
      TCON: 'Rock',
    });
    await write(`${f.root}/A/beta/beta.mp3`, { TCON: 'Rock' });
    await f.add('A');
    await f.scan();
    const library = createLibrary(f.store);
    const normal = await library.listAlbums({ ...page, sort: 'name' });
    assertEquals(normal.map((a) => a.folderName), ['beta', 'zebra']);
    const sorted = await library.listAlbums({
      ...page,
      sort: 'name',
      sortTags: true,
    });
    assertEquals(sorted.map((a) => a.folderName), ['zebra', 'beta']);
    assertEquals(names(sorted), [null, null]);
    assertEquals(
      (await library.albumsWithoutArtist('unknown', { sortTags: true })).map((
        a,
      ) => a.id),
      sorted.map((a) => a.id),
    );
    const songs = await library.songsByGenre('Rock', {
      ...page,
      sortTags: true,
    });
    assertEquals(songs.map((s) => s.fileName), ['zebra', 'beta']);
    assertEquals(titles(songs), [null, null]);
    assertEquals(
      (await library.songsByGenre('Rock', page)).map((s) => s.fileName),
      ['beta', 'zebra'],
    );
  } finally {
    await f.close();
  }
});

Deno.test('sort tags: existing schema upgrades and the unchanged files gain facts through the full startup scan', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'sort-upgrade-' });
  let store = await openStore(`${dir}/data`);
  try {
    await write(`${dir}/music/song.mp3`, {
      TIT2: 'Song',
      TALB: 'Album',
      TPE1: 'The Beatles',
      TPE2: 'Album Artist',
      TSOP: 'Beatles, The',
      TSO2: 'Artist, Album',
      TSOA: 'Album sort',
      TSOT: 'Song sort',
    });
    await createLibraries(store).add('Music', `${dir}/music`);
    await createScan(store).run();
    const [before] = await store.catalog.listSongs(page);
    const stat = await Deno.stat(before.path);
    assert((await store.catalog.scanFilesSnapshot())[0].scanFacts);
    const q = rawSql(store);
    await q.run(`INSERT INTO ratings VALUES ('kept-user', '${before.id}', 4)`);
    await q.run('ALTER TABLE artists DROP COLUMN sort_name');
    await q.run('ALTER TABLE files DROP COLUMN artist_sort_name');
    await q.run('ALTER TABLE files DROP COLUMN album_artist_sort_name');
    await store.close();
    store = await openStore(`${dir}/data`);
    assertEquals(
      (await store.catalog.getSong(before.id))?.metadata?.artistSortName,
      null,
    );
    let reads = 0;
    const state = createState(store);
    const scan = createScan(store, undefined, {
      state,
      tagReader: () => {
        const reader = createTagReader(state);
        return {
          read(path) {
            reads++;
            return reader.read(path);
          },
          [Symbol.dispose]() {
            reader[Symbol.dispose]();
          },
        };
      },
    });
    // server.ts uses precisely this entry point without a mode: full, not quick.
    await scan.run();
    assertEquals(reads, 1);
    const after = (await store.catalog.getSong(before.id))!;
    assertEquals(after.metadata?.artistSortName, 'Beatles, The');
    assertEquals(after.metadata?.albumArtistSortName, 'Artist, Album');
    assertEquals(
      (await store.catalog.artistById(after.artistId!))?.sortName,
      'Beatles, The',
    );
    assertEquals(
      (await store.catalog.getArtist(await stableId('artist', 'Album Artist')))
        ?.sortName,
      'Artist, Album',
    );
    assertEquals(after.firstSeenMs, before.firstSeenMs);
    assertEquals(after.albumId, before.albumId);
    assertEquals((await Deno.stat(before.path)).mtime, stat.mtime);
    assertEquals(await rawSql(store).all('SELECT * FROM ratings'), [
      { user_id: 'kept-user', target_id: before.id, rating: 4 },
    ]);
    reads = 0;
    await scan.run({ mode: 'quick' });
    assertEquals(reads, 0);
    assertEquals(await store.catalog.getSong(before.id), after);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('natural sort: scanned sort tags and missing-name fallbacks compose across core consumers', async () => {
  const f = await scanFixture();
  try {
    for (const role of ['Member', '']) {
      for (
        const [name, key] of [['The Zulu 10', 'Étage 2'], [
          'The Alpha 2',
          'Etage 10',
        ], ['The Coda 3', '   ']]
      ) {
        await write(`${f.root}/A/${role || 'unknown'}/${name}/${name}.mp3`, {
          TIT2: role ? name : '',
          TALB: role ? name : '',
          TPE1: role,
          TCON: 'Fixture',
          TDRC: '2000',
          TSOT: key,
          TSOA: key,
          TSOP: role ? 'The Member 2' : '',
        });
      }
    }
    const folder = await f.add('A');
    await f.scan();
    const library = createLibrary(f.store);
    const opts = {
      natural: true,
      sortTags: true,
      ignoredArticles: ['The'],
      folderId: folder.id,
    };
    const member = (await library.listArtists())[0];
    const expected = ['The Coda 3', 'The Zulu 10', 'The Alpha 2'];
    assertEquals(
      names(await library.albumsByArtist(member.id, opts)),
      expected,
    );
    assertEquals(
      (await library.artistAlbumsPage({ kind: 'artist', id: member.id }, {
        ...opts,
        offset: 0,
        limit: 10,
      })).rows.map((r) => r.name),
      expected,
    );
    const missing = await library.albumsWithoutArtist('unknown', opts);
    assertEquals(missing.map((r) => r.folderName), expected);
    assertEquals(names(missing), [null, null, null]);
    const ordered = await library.listAlbums({
      ...page,
      ...opts,
      sort: 'name',
    });
    const expectedNames = [
      'The Coda 3',
      'The Coda 3',
      'The Zulu 10',
      'The Zulu 10',
      'The Alpha 2',
      'The Alpha 2',
    ];
    assertEquals(ordered.map((r) => r.name ?? r.folderName), expectedNames);
    for (const sort of ['genre', 'year'] as const) {
      assertEquals(
        (await library.listAlbums({
          ...page,
          ...opts,
          sort,
          genre: 'Fixture',
          fromYear: 0,
          toYear: 9999,
        })).map((r) => r.id),
        ordered.map((r) => r.id),
      );
    }
    const songs = await library.songsByGenre('Fixture', { ...page, ...opts });
    assertEquals(songs.map((r) => r.title ?? r.fileName), expectedNames);
    assertEquals(songs.filter((r) => r.title === null).length, 3);
    const found = await library.search3('', { ...search, ...opts });
    assertEquals(found.albums.map((r) => r.id), ordered.map((r) => r.id));
    assertEquals(found.songs.map((r) => r.id), songs.map((r) => r.id));
    // Nonempty sort tags are authoritative: don't strip their leading article.
    assertEquals(
      (await library.listArtists(folder.id, opts))[0].sortKey,
      'the member 2',
    );
    const untagged = await library.albumsByArtist(member.id, {
      natural: true,
      ignoredArticles: ['The'],
    });
    assertEquals(names(untagged), ['The Alpha 2', 'The Coda 3', 'The Zulu 10']);
    // Historical callers do not opt in merely because the capability exists.
    const rest = (await f.rest('search3', { query: '' })).searchResult3;
    assertEquals(
      rest.album.map((r: { id: string }) => r.id),
      (await library.search3('', search)).albums.map((r) => r.id),
    );
    const ownResponse = await fetch(
      `${f.origin.replace(/:\d+$/, `:${f.extraPorts[0]}`)}/api/library/artists`,
      { signal: AbortSignal.timeout(5000) },
    );
    assertEquals(ownResponse.status, 200);
    assertEquals(
      (await ownResponse.json()).items.map((r: { name: string }) => r.name)
        .filter((r: string) => r === 'Member'),
      ['Member'],
    );
  } finally {
    await f.close();
  }
});
