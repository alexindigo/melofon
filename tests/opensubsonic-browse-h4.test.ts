// H4 browsing outcomes over the real scan, DuckDB services and HTTP facade.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { seedFirstUser } from '../src/users.ts';
import { createScan } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createUserService } from '../src/user.ts';
import { createLibrary } from '../src/library.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { loadLayers } from '../src/layers.ts';
import { facade } from '../src/facade.ts';
import { tagged } from './helpers/tagged.ts';

type Item = Record<string, unknown> & { id: string; name: string };
const ARTICLES = 'The El La Los Las Le Les Os As O A';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function items(container: unknown, key: string): Item[] {
  const list = (container as Record<string, unknown>)?.[key];
  assert(Array.isArray(list), `${key} is an array`);
  return list as Item[];
}

async function setup(fixture = true) {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-h4-' });
  const store = await openStore(`${dir}/db`);
  const db = store;
  const cfg = {
    listen: undefined,
    dataDir: dir,
    user: 'admin',
    password: 'test',
    secret: 's3cret',
    version: 'test',
  };
  await seedFirstUser(store, cfg);
  const libraries = createLibraries(store);
  const scan = createScan(store);
  const library = createLibrary(store);
  if (fixture) {
    await libraries.add('Music', 'tests/fixtures/library');
    await scan.run();
  }
  const bag = {
    cfg,
    libraries,
    scan,
    library,
    user: createUserService(store, cfg),
    annotation: createAnnotation(store),
    listens: createListens(store),
  };
  const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
  const app = facade(core, await loadLayers({ app: bag }));
  const request = async (
    op: string,
    params: Record<string, string> = {},
    format = 'json',
  ) => {
    const p = new URLSearchParams({
      u: 'admin',
      p: 'test',
      v: '1.16.1',
      c: 'h4',
      f: format,
      ...params,
    });
    return await app(new Request(`http://x/rest/${op}?${p}`));
  };
  const get = async (op: string, params: Record<string, string> = {}) => {
    const response = await request(op, params);
    assertEquals(response.status, 200);
    const body = (await response.json())['subsonic-response'];
    assertEquals(body.status, 'ok', `${op}: ${JSON.stringify(body.error)}`);
    return body as Record<string, unknown>;
  };
  return {
    dir,
    db,
    libraries,
    scan,
    library,
    get,
    request,
    async close() {
      await db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;
async function withSetup(fn: (s: Setup) => Promise<void>, fixture = true) {
  const s = await setup(fixture);
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

async function theme(s: Setup) {
  const songs = items(
    (await s.get('search3', { query: 'Theme' })).searchResult3,
    'song',
  );
  assertEquals(songs.length, 1);
  return songs[0];
}

Deno.test('H4 performer-only artist resolves from song links and favourites', async () => {
  await withSetup(async (s) => {
    const song = await theme(s);
    const id = String(song.artistId);
    const artist = (await s.get('getArtist', { id })).artist as Item;
    assertEquals([artist.name, artist.albumCount, artist.album], [
      'Probe Performer',
      0,
      [],
    ]);
    const dir = (await s.get('getMusicDirectory', { id })).directory as Item;
    assertEquals([dir.name, dir.child], ['Probe Performer', []]);
    await s.get('star', { artistId: id });
    for (
      const [op, key] of [['getStarred', 'starred'], [
        'getStarred2',
        'starred2',
      ]]
    ) {
      assertEquals(items((await s.get(op))[key], 'artist').map((a) => a.id), [
        id,
      ]);
    }
    // OwnTone's existing album-only resolver retains its contract.
    assertEquals(await s.library.getArtist(id), null);
  });
});

Deno.test('H4 artist play facts credit track artist rather than album artist', async () => {
  await withSetup(async (s) => {
    const song = await theme(s);
    await s.get('scrobble', { id: song.id, time: '1700000001000' });
    const va = (await s.get('getAlbum', { id: String(song.albumId) }))
      .album as Item;
    const albumArtist =
      (await s.get('getMusicDirectory', { id: String(va.artistId) }))
        .directory as Item;
    assertEquals(albumArtist.playCount, undefined);
    const performer =
      (await s.get('getMusicDirectory', { id: String(song.artistId) }))
        .directory as Item;
    assertEquals([performer.playCount, performer.played], [
      1,
      '2023-11-14T22:13:21.000Z',
    ]);
  });
});

Deno.test('H4 articles and accent folding order artists, album lists and default index groups', async () => {
  await withSetup(async (s) => {
    const root = `${s.dir}/names`;
    await Deno.mkdir(root);
    const names = [
      'The Beatles',
      'Ábc',
      'Le Foo',
      'Xylophone',
      'Zulu',
      '[Unknown Artist]',
      '123',
      'the Beta',
      'A Zebra',
    ];
    for (const [i, name] of names.entries()) {
      await tagged(`${root}/${i}.mp3`, {
        TIT2: `Song ${i}`,
        TPE1: name,
        TPE2: name,
        TALB: name,
      });
    }
    await s.libraries.add('Names', root);
    await s.scan.run();
    for (
      const [op, key] of [['getArtists', 'artists'], ['getIndexes', 'indexes']]
    ) {
      const index = (await s.get(op))[key] as Item;
      assertEquals(index.ignoredArticles, ARTICLES);
      assertEquals(
        items(index, 'index').map((
          group,
        ) => [group.name, items(group, 'artist').map((a) => a.name)]),
        [
          ['#', ['123']],
          ['A', ['Ábc']],
          ['B', ['The Beatles']],
          ['F', ['Le Foo']],
          ['T', ['the Beta']],
          ['X-Z', ['Xylophone', 'A Zebra', 'Zulu']],
          ['[Unknown]', ['[Unknown Artist]']],
        ],
      );
    }
    const sorted = [
      '123',
      '[Unknown Artist]',
      'Ábc',
      'The Beatles',
      'Le Foo',
      'the Beta',
      'Xylophone',
      'A Zebra',
      'Zulu',
    ];
    for (const type of ['alphabeticalByName', 'alphabeticalByArtist']) {
      assertEquals(
        items((await s.get('getAlbumList2', { type })).albumList2, 'album').map(
          (a) => a.name,
        ),
        sorted,
      );
    }
    assertEquals(
      (await s.library.listArtists()).map((a) => a.name),
      [...names].sort(),
    );
  }, false);
});

Deno.test('H4 getIndexes lastModified is scan start and conditional index is omitted', async () => {
  await withSetup(async (s) => {
    const status = await s.scan.status() as
      & Awaited<ReturnType<typeof s.scan.status>>
      & { lastScanStartedMs?: number };
    assert(
      typeof status.lastScanStartedMs === 'number',
      'scan exposes its start time',
    );
    assert(status.lastScanStartedMs <= status.lastScanMs!);
    const ms = status.lastScanStartedMs;
    const before =
      (await s.get('getIndexes', { ifModifiedSince: String(ms - 1) }))
        .indexes as Item;
    assertEquals(before.lastModified, ms);
    assert(items(before, 'index').length > 0);
    for (const time of [ms, ms + 1]) {
      const after =
        (await s.get('getIndexes', { ifModifiedSince: String(time) }))
          .indexes as Item;
      assertEquals([after.lastModified, after.ignoredArticles, after.index], [
        ms,
        ARTICLES,
        undefined,
      ]);
    }
    const xml = await (await s.request(
      'getIndexes',
      { ifModifiedSince: String(ms) },
      'xml',
    )).text();
    assert(!xml.includes('<index '), xml);
    assert(xml.includes(`lastModified="${ms}"`), xml);
    const malformed =
      (await s.get('getIndexes', { ifModifiedSince: '1.0000000000000001' }))
        .indexes;
    assert(items(malformed, 'index').length > 0);
  });
});

Deno.test('H4 recent and frequent album lists exclude unplayed albums', async () => {
  await withSetup(async (s) => {
    const song = await theme(s);
    for (
      const [op, key] of [['getAlbumList', 'albumList'], [
        'getAlbumList2',
        'albumList2',
      ]]
    ) {
      for (const type of ['recent', 'frequent']) {
        assertEquals(items((await s.get(op, { type }))[key], 'album'), []);
      }
    }
    await s.get('scrobble', { id: song.id, time: '1700000001000' });
    for (
      const [op, key] of [['getAlbumList', 'albumList'], [
        'getAlbumList2',
        'albumList2',
      ]]
    ) {
      for (const type of ['recent', 'frequent']) {
        assertEquals(
          items((await s.get(op, { type }))[key], 'album').map((a) => a.id),
          [song.albumId],
        );
      }
    }
  });
});

Deno.test('H4 byGenre and byYear select whole albums rather than matching files', async () => {
  await withSetup(async (s) => {
    const album = items(
      (await s.get('getAlbumList2', { type: 'alphabeticalByName' }))
        .albumList2,
      'album',
    )[0];
    assertEquals(album.songCount, 3);
    const selections: Record<string, string>[] = [{
      type: 'byGenre',
      genre: 'Fixture Rock',
    }, { type: 'byYear', fromYear: '2001', toYear: '2001' }];
    for (const params of selections) {
      const selected = items(
        (await s.get('getAlbumList2', params)).albumList2,
        'album',
      );
      assertEquals(selected.length, 1);
      assertEquals([
        selected[0].songCount,
        selected[0].duration,
        selected[0].created,
      ], [album.songCount, album.duration, album.created]);
    }
  });
});

Deno.test('H4 getArtist albums sort by ascending year, then name and id', async () => {
  await withSetup(async (s) => {
    const root = `${s.dir}/albums`;
    await Deno.mkdir(root);
    for (
      const [i, name, year] of [[0, 'A Late', '2020'], [1, 'Z Early', '1990'], [
        2,
        'B Late',
        '2020',
      ]] as const
    ) {
      await tagged(`${root}/${i}.mp3`, {
        TIT2: `Song ${i}`,
        TPE1: 'Artist',
        TPE2: 'Artist',
        TALB: name,
        TDRC: year,
      });
    }
    await s.libraries.add('Albums', root);
    await s.scan.run();
    const id = (await s.library.listArtists())[0].id;
    assertEquals(
      items((await s.get('getArtist', { id })).artist, 'album').map((a) =>
        a.name
      ),
      ['Z Early', 'A Late', 'B Late'],
    );
  }, false);
});

Deno.test('H4 shared Child parent links cover album/song/list/directory/search2 paths', async () => {
  await withSetup(async (s) => {
    const song = await theme(s);
    const album = (await s.get('getAlbum', { id: String(song.albumId) }))
      .album as Item;
    const fromSong = (await s.get('getSong', { id: song.id })).song as Item;
    assertEquals(fromSong.parent, album.id);
    assertEquals(items(album, 'song')[0].parent, album.id);
    const songDir =
      (await s.get('getMusicDirectory', { id: album.id })).directory;
    assertEquals(items(songDir, 'child')[0].parent, album.id);
    const artistDir =
      (await s.get('getMusicDirectory', { id: String(album.artistId) }))
        .directory;
    const childAlbum = items(artistDir, 'child')[0];
    assertEquals([childAlbum.parent, childAlbum.created], [
      album.artistId,
      album.created,
    ]);
    const albums = items(
      (await s.get('getAlbumList', { type: 'alphabeticalByName' })).albumList,
      'album',
    );
    for (const row of albums) assertEquals(row.parent, row.artistId);
    const searchAlbums = items(
      (await s.get('search2', { query: 'Fixture' })).searchResult2,
      'album',
    );
    for (const row of searchAlbums) assertEquals(row.parent, row.artistId);
    assertEquals(
      items(
        (await s.get('search2', { query: 'Theme' })).searchResult2,
        'song',
      )[0].parent,
      album.id,
    );
  });
});

Deno.test('H4 created and newest use first-seen across later imports and retags', async () => {
  await withSetup(async (s) => {
    const a = `${s.dir}/a`, b = `${s.dir}/b`;
    await Deno.mkdir(a);
    await Deno.mkdir(b);
    await tagged(`${a}/a.mp3`, {
      TIT2: 'A',
      TPE1: 'Artist',
      TPE2: 'Artist',
      TALB: 'A',
    });
    await Deno.utime(`${a}/a.mp3`, 1800000000, 1800000000);
    await s.libraries.add('A', a);
    await s.scan.run();
    const first = items(
      (await s.get('getAlbumList2', { type: 'newest' })).albumList2,
      'album',
    )[0];
    await sleep(20);
    await tagged(`${b}/b.mp3`, {
      TIT2: 'B',
      TPE1: 'Artist',
      TPE2: 'Artist',
      TALB: 'B',
    });
    await Deno.utime(`${b}/b.mp3`, 1000000000, 1000000000);
    await s.libraries.add('B', b);
    await s.scan.run();
    const list = async () =>
      items(
        (await s.get('getAlbumList2', { type: 'newest' })).albumList2,
        'album',
      );
    const initial = await list();
    assertEquals(initial.map((row) => row.name), ['B', 'A']);
    assert(
      Date.parse(String(initial[0].created)) >
        Date.parse(String(first.created)),
    );
    const got = (await s.get('getAlbum', { id: first.id })).album as Item;
    const child = items(got, 'song')[0];
    assertEquals(child.created, first.created);
    const identity = (await rawSql(s.db).all(
      `SELECT epoch_ms(first_seen_at) AS ms FROM file_identity WHERE id = '${child.id}'`,
    ))[0];
    assertEquals(child.created, new Date(Number(identity.ms)).toISOString());
    await tagged(`${a}/a.mp3`, {
      TIT2: 'A retagged',
      TPE1: 'Artist',
      TPE2: 'Artist',
      TALB: 'A',
    });
    await Deno.utime(`${a}/a.mp3`, 1900000000, 1900000000);
    await s.scan.run();
    assertEquals(
      (await list()).map((row) => [row.id, row.created]),
      initial.map((row) => [row.id, row.created]),
    );
    const retagged = (await s.get('getSong', { id: child.id })).song as Item;
    assertEquals([retagged.title, retagged.created], [
      'A retagged',
      first.created,
    ]);
  }, false);
});
