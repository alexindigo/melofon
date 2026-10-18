// Mathematical literal oracles through existing plugin adapters and real facade
// consumers. This file also runs against unchanged H2 production source for red.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import {
  boundedCountParam,
  intParam as subInt,
  params as requestParams,
  safeIntParam,
} from '../layers/opensubsonic/params.ts';
import type { HatRequest } from '../layers/opensubsonic/types.ts';
import {
  intParam as ownInt,
  pagingParams,
  wireInt,
} from '../layers/owntone/payloads.ts';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { seedFirstUser } from '../src/users.ts';
import { createUserService } from '../src/user.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createPlaylists } from '../src/playlists.ts';
import { createBookmarks } from '../src/bookmarks.ts';
import { createClientQueue } from '../src/clientqueue.ts';
import { createListens } from '../src/listens.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createOutputs, createPlayer } from '../src/player.ts';
import { createPlayback, type Playback } from '../src/playback.ts';
import { createNotify } from '../src/notify.ts';
import { loadLayers } from '../src/layers.ts';
import { createState } from '../src/state.ts';
import { facade } from '../src/facade.ts';

const fractions = [
  '1.0000000000000001',
  '0.99999999999999999',
  '1999.9999999999999999999',
  '5.0000000000000001',
  '9007199254740990.9',
  '9007199254740991.1',
  '-9007199254740990.9',
  '-9007199254740991.1',
  '9007199254740992.5',
  '-9007199254740992.5',
  '1e-400',
  '-1e-400',
];
const invalid = [
  ...fractions,
  '1.5',
  'NaN',
  'Infinity',
  '-Infinity',
  '+0x10',
  '-0b1',
  '0x',
  '0b2',
  '0o8',
  '1e',
  '1e+',
  '1_0',
  '1n',
  '1 0',
  '１２',
  '.',
  '+',
  '0e+',
  '0e999x',
  `1e${'9'.repeat(2000)}`,
  `1e-${'9'.repeat(2000)}`,
];
// [raw, legacy finite Number value, exact-safe value]. Unsafe integer expected
// rounding is literal; no expected value is computed with Number(raw).
const integral: [string, number, number | null][] = [
  ['', 0, 0],
  [' \t\n\u00a0\ufeff', 0, 0],
  ['-0', -0, -0],
  ['-0.0e-99999999999999999999', -0, -0],
  ['1.0', 1, 1],
  ['1.', 1, 1],
  ['.1e1', 1, 1],
  ['1000e-3', 1, 1],
  ['+001.00e+0', 1, 1],
  ['0x10', 16, 16],
  ['0b10000', 16, 16],
  ['0o20', 16, 16],
  ['077', 77, 77],
  ['-1.0', -1, -1],
  ['-1e0', -1, -1],
  ['\u00a0+2\ufeff', 2, 2],
  ['-3.3e1', -33, -33],
  ['9007199254740991', 9007199254740991, 9007199254740991],
  ['-9007199254740991', -9007199254740991, -9007199254740991],
  ['0x1fffffffffffff', 9007199254740991, 9007199254740991],
  [
    '0b11111111111111111111111111111111111111111111111111111',
    9007199254740991,
    9007199254740991,
  ],
  ['0o377777777777777777', 9007199254740991, 9007199254740991],
  ['9007199254740992', 9007199254740992, null],
  ['9007199254740993', 9007199254740992, null],
  ['-9007199254740993', -9007199254740992, null],
  ['0x20000000000000', 9007199254740992, null],
  [
    '0b100000000000000000000000000000000000000000000000000000',
    9007199254740992,
    null,
  ],
  ['0o400000000000000000', 9007199254740992, null],
  [`${'0'.repeat(2000)}1.000e+000`, 1, 1],
  [`1${'0'.repeat(2000)}e-2000`, 1, 1],
  [`0.${'0'.repeat(1999)}1e2000`, 1, 1],
  [`1e+${'0'.repeat(2000)}`, 1, 1],
  [`0e${'9'.repeat(2000)}`, 0, 0],
  [`-0e-${'9'.repeat(2000)}`, -0, -0],
];

for (const [index, raw] of invalid.entries()) {
  Deno.test(`OpenSubsonic integer mathematical rejection ${index}: ${raw.slice(0, 70)}`, () => {
    const p = new URLSearchParams({ n: raw });
    assertEquals(subInt(p, 'n', 37), 37);
    assertEquals(safeIntParam(p, 'n', 37), 37);
    assertEquals(boundedCountParam(p, 'n'), 10);
  });
  Deno.test(`OwnTone integer mathematical rejection ${index}: ${raw.slice(0, 70)}`, () => {
    assertEquals(ownInt(raw), null);
    assert(
      pagingParams(new URLSearchParams({ offset: raw })) instanceof Response,
    );
    assert(
      pagingParams(new URLSearchParams({ limit: raw })) instanceof Response,
    );
  });
}
for (const [index, [raw, legacy, safe]] of integral.entries()) {
  Deno.test(`independent integer compatibility ${index}: ${raw.slice(0, 70)}`, () => {
    const p = new URLSearchParams({ n: raw });
    assert(
      Object.is(ownInt(raw), legacy),
      'OwnTone signed legacy value/negative zero',
    );
    assert(Object.is(subInt(p, 'n', 37), legacy < 0 ? 37 : legacy));
    assert(
      Object.is(
        safeIntParam(p, 'n', 37),
        safe === null || safe < 0 ? 37 : safe,
      ),
    );
    assert(
      Object.is(
        boundedCountParam(p, 'n'),
        safe === null || safe < 0 ? 10 : Math.min(500, safe),
      ),
    );
  });
}
Deno.test('integer missing versus blank and paging sentinels', () => {
  assertEquals(subInt(new URLSearchParams(), 'n', 37), 37);
  assertEquals(safeIntParam(new URLSearchParams(), 'n', 37), 37);
  assertEquals(ownInt(null), null);
  assertEquals(pagingParams(new URLSearchParams()), { offset: 0, limit: -1 });
  assertEquals(pagingParams(new URLSearchParams({ offset: '', limit: '' })), {
    offset: 0,
    limit: 0,
  });
  for (const limit of ['-1.0', '-1e0']) {
    assertEquals(pagingParams(new URLSearchParams({ limit })), {
      offset: 0,
      limit: -1,
    });
  }
});

const id = (n: number) => n.toString(16).padStart(8, '0') + '0'.repeat(24);
const songIds = [101, 102, 103, 104, 105, 106].map(id);
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
type Envelope = Record<string, unknown> & {
  status: string;
  error?: { code: number; message: string };
};
type Page = {
  items: { id?: number | string; name?: string; title?: string }[];
  total: number;
  offset: number;
  limit: number;
};

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-protocol-params-' });
  const store = await openStore(dir);
  const db = store;
  const cfg = {
    dataDir: dir,
    user: 'U + 雪',
    password: 'p&=+% café 🔑',
    secret: 'fixture',
    version: 'test',
    listen: undefined,
  };
  await seedFirstUser(store, cfg);
  const libraries = createLibraries(store);
  await Deno.mkdir(`${dir}/music`);
  const source = await libraries.add('Music', `${dir}/music`);
  for (let n = 1; n <= 3; n++) {
    await rawSql(db).run(
      `INSERT INTO artists VALUES (${quote(id(10 + n))}, 'Artist ${n}')`,
    );
    await rawSql(db).run(
      `INSERT INTO albums (id, name, album_artist_id) VALUES (${
        quote(id(20 + n))
      }, 'Album ${n}', ${quote(id(10 + n))})`,
    );
  }
  for (let n = 1; n <= 6; n++) {
    const album = Math.ceil(n / 2);
    const path = `${dir}/music/${n}.mp3`;
    await Deno.copyFile(
      'tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3',
      path,
    );
    await rawSql(db).run(
      `INSERT INTO files (id,path,library_id,title,album_id,artist_id,genre,year,is_video,mtime,duration_ms)
      VALUES (${quote(id(100 + n))},${quote(path)},${
        quote(source.id)
      },'Track ${n}',${quote(id(20 + album))},${quote(id(10 + album))},'Jazz',${
        n === 1 ? -5 : 2000
      },${n === 6},1000,600000)`,
    );
  }
  const library = createLibrary(store);
  const annotation = createAnnotation(store);
  const playlists = createPlaylists(store);
  const playlist = await playlists.create(cfg.user, 'Mix', songIds);
  const bookmarks = createBookmarks(store);
  const clientQueue = createClientQueue(store);
  const nowPlaying = createNowPlaying(store);
  const notify = createNotify();
  const player = createPlayer();
  const playback = createPlayback({ player, library, nowPlaying, cfg, notify });
  const outputs = createOutputs({ notify });
  outputs.register({
    id: '0',
    name: 'in-process fixture',
    type: 'AirPlay',
    selected: false,
    volume: 50,
  });
  const calls = {
    search: [] as Parameters<typeof library.search3>[1][],
    volume: [] as Parameters<Playback['setVolume']>[0][],
    seek: [] as Parameters<Playback['seek']>[0][],
    queue: [] as Parameters<Playback['queueAdd']>[1][],
    remove: [] as number[][],
    stars: [] as string[],
    hls: [] as string[],
  };
  let recordSearchOnly = false;
  const bag = {
    state: createState(store),
    cfg,
    libraries,
    user: createUserService(store, cfg),
    library: {
      ...library,
      search3: async (...args: Parameters<typeof library.search3>) => {
        calls.search.push(args[1]);
        return recordSearchOnly
          ? { artists: [], albums: [], songs: [] }
          : await library.search3(...args);
      },
    },
    annotation: {
      ...annotation,
      star: async (...args: Parameters<typeof annotation.star>) => {
        calls.stars.push(args[1]);
        return await annotation.star(...args);
      },
    },
    playlists: {
      ...playlists,
      update: async (...args: Parameters<typeof playlists.update>) => {
        calls.remove.push(args[2].removeAtPositions ?? []);
        return await playlists.update(...args);
      },
    },
    bookmarks,
    clientQueue,
    listens: createListens(store),
    nowPlaying,
    player,
    outputs,
    notify,
    playback: {
      ...playback,
      setVolume: (...args: Parameters<Playback['setVolume']>) => {
        calls.volume.push(args[0]);
        playback.setVolume(...args);
      },
      seek: (...args: Parameters<Playback['seek']>) => {
        calls.seek.push(args[0]);
        return playback.seek(...args);
      },
      queueAdd: (...args: Parameters<Playback['queueAdd']>) => {
        calls.queue.push(args[1]);
        return playback.queueAdd(...args);
      },
    },
    media: {
      hlsRemux: async (_path: string, out: string) => {
        calls.hls.push(out);
        await Deno.mkdir(out, { recursive: true });
        await Deno.writeTextFile(`${out}/index.m3u8`, '#EXTM3U\n');
        await Deno.writeTextFile(`${out}/seg0.ts`, 'fixture-segment');
        return 1;
      },
    },
  };
  const core = await pathfinder({ roots: ['core/'], app: { store, ...bag } });
  const layers = await loadLayers({ app: bag });
  const app = facade(core, layers);
  const own = facade(core, layers, {
    listenPort: 3689,
    defaultPort: 4534,
    env: {},
  });
  const auth = () =>
    new URLSearchParams({
      u: cfg.user,
      p: cfg.password,
      c: 'params',
      v: '1.16.1',
      f: 'json',
    });
  const rest = async (
    op: string,
    p: URLSearchParams | Record<string, string> = {},
  ) => {
    const query = auth();
    for (
      const [k, v] of p instanceof URLSearchParams ? p : new URLSearchParams(p)
    ) query.append(k, v);
    return await app(new Request(`http://x/rest/${op}?${query}`));
  };
  const get = async (
    op: string,
    p: URLSearchParams | Record<string, string> = {},
  ): Promise<Envelope> => {
    const response = await rest(op, p);
    assertEquals(response.status, 200);
    return (await response.json())['subsonic-response'];
  };
  const ownRequest = async (
    path: string,
    p: Record<string, string> = {},
    method = 'GET',
  ) =>
    await own(
      new Request(`http://x${path}?${new URLSearchParams(p)}`, { method }),
    );
  return {
    dir,
    db,
    cfg,
    source,
    app,
    own,
    auth,
    rest,
    get,
    ownRequest,
    library,
    annotation,
    playlists,
    playlist,
    bookmarks,
    clientQueue,
    playback,
    outputs,
    calls,
    recordSearchOnly: () => recordSearchOnly = true,
    close: async () => {
      playback.close();
      await db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('numeric facade all six search2/search3 fields retain independent fallback and range', async () => {
  const s = await setup();
  try {
    const fields = [
      'artistCount',
      'artistOffset',
      'albumCount',
      'albumOffset',
      'songCount',
      'songOffset',
    ];
    for (const op of ['search2', 'search3']) {
      for (const field of fields) {
        const body = await s.get(op, {
          query: 'Track',
          [field]: '1.0000000000000001',
        });
        assertEquals(body.status, 'ok');
        assertEquals(
          s.calls.search.at(-1)![field as keyof typeof s.calls.search[number]],
          field.endsWith('Count') ? 20 : 0,
          `${op}.${field}`,
        );
      }
    }
    const page = await s.get('search3', {
      query: '',
      artistCount: '0',
      albumCount: '0',
      songCount: '2',
      songOffset: '1.0000000000000001',
    });
    assertEquals(
      (page.searchResult3 as { song: { id: string }[] }).song.map((v) => v.id),
      [id(101), id(102)],
    );
    s.recordSearchOnly();
    for (const field of fields) {
      for (const op of ['search2', 'search3']) {
        assertEquals(
          (await s.get(op, { query: 'Track', [field]: '9007199254740993' }))
            .status,
          'ok',
        );
        assertEquals(
          s.calls.search.at(-1)![field as keyof typeof s.calls.search[number]],
          op === 'search2'
            ? 9007199254740992
            : field.endsWith('Count')
            ? 20
            : 0,
        );
      }
    }
    assertEquals(
      (await s.get('search3', { query: '', songCount: '601' })).status,
      'ok',
    );
    assertEquals(
      s.calls.search.at(-1)!.songCount,
      601,
      'uncapped search3 callback',
    );
    assertEquals(
      (await s.get('search2', { query: 'Track', songCount: '601' })).status,
      'ok',
    );
    assertEquals(
      s.calls.search.at(-1)!.songCount,
      601,
      'uncapped search2 callback',
    );
  } finally {
    await s.close();
  }
});

Deno.test('numeric bounded counts offsets and signed years reach actual catalog consumers', async () => {
  const s = await setup();
  try {
    for (const raw of fractions) {
      for (const bound of ['fromYear', 'toYear']) {
        assertEquals(
          (await s.get('getRandomSongs', { [bound]: raw })).error?.code,
          10,
        );
        for (const op of ['getAlbumList', 'getAlbumList2']) {
          assertEquals(
            (await s.get(op, {
              type: 'byYear',
              fromYear: '-5',
              toYear: '2000',
              [bound]: raw,
            })).error?.code,
            10,
          );
        }
      }
    }
    const random = await s.get('getRandomSongs', {
      size: '1.0000000000000001',
    });
    assertEquals(
      (random.randomSongs as { song: { id: string }[] }).song.map((v) => v.id)
        .sort(),
      [...songIds].sort(),
    );
    const genre = await s.get('getSongsByGenre', {
      genre: 'Jazz',
      count: '1.0000000000000001',
      offset: '1.0000000000000001',
    });
    assertEquals(
      (genre.songsByGenre as { song: { id: string }[] }).song.map((v) => v.id),
      songIds,
    );
    for (const op of ['getAlbumList', 'getAlbumList2']) {
      const body = await s.get(op, {
        type: 'alphabeticalByName',
        size: '1.0000000000000001',
        offset: '1.0000000000000001',
      });
      assertEquals(
        (body[op === 'getAlbumList' ? 'albumList' : 'albumList2'] as {
          album: { id: string }[];
        }).album.map((v) => v.id),
        [21, 22, 23].map(id),
      );
      assertEquals(
        (await s.get(op, {
          type: 'byYear',
          fromYear: '-5.0',
          toYear: '2000e0',
        })).status,
        'ok',
      );
    }
    const signed = await s.get('getRandomSongs', {
      fromYear: '-5e0',
      toYear: '-5.0',
    });
    assertEquals(
      (signed.randomSongs as { song: { id: string }[] }).song.map((v) => v.id),
      [id(101)],
    );
    assertEquals(
      (await s.get('getRandomSongs', { fromYear: '' })).error?.code,
      10,
    );
    assertEquals(
      (await s.get('getRandomSongs', { fromYear: '9007199254740993' })).error
        ?.code,
      10,
    );
  } finally {
    await s.close();
  }
});

Deno.test('numeric rating fractions cannot set or clear persisted rating; id precedence and zero preserved', async () => {
  const s = await setup();
  try {
    for (
      const raw of [
        '1.0000000000000001',
        '5.0000000000000001',
        '1e-400',
        '-1e-400',
      ]
    ) {
      await s.annotation.setRating(s.cfg.user, id(101), 4);
      assertEquals(
        (await s.get('setRating', { id: id(101), rating: raw })).error?.code,
        0,
      );
      const rows = await rawSql(s.db).all('SELECT rating FROM ratings');
      assertEquals(rows, [{ rating: 4 }]);
    }
    for (const rating of ['', '-0', '0e999999999999999999']) {
      assertEquals(
        (await s.get('setRating', { id: id(101), rating })).status,
        'ok',
      );
      assertEquals(
        await rawSql(s.db).all('SELECT rating FROM ratings'),
        [],
      );
    }
    assertEquals(
      (await s.get('setRating', { rating: '1.0000000000000001' })).error
        ?.message,
      'Required parameter is missing',
    );
    assertEquals(
      (await s.get('setRating', { id: id(101), rating: '+005.0' })).status,
      'ok',
    );
    assertEquals(
      await rawSql(s.db).all('SELECT rating FROM ratings'),
      [{ rating: 5 }],
    );
  } finally {
    await s.close();
  }
});

Deno.test('numeric playlist independently filters removals and preserves ordered valid edits', async () => {
  const s = await setup();
  try {
    const p = new URLSearchParams({ playlistId: s.playlist.id });
    for (const value of ['1.0000000000000001', '1e-400', '-1', 'junk']) {
      p.append('songIndexToRemove', value);
    }
    assertEquals((await s.get('updatePlaylist', p)).status, 'ok');
    assertEquals(
      (await s.playlists.get(s.cfg.user, s.playlist.id))!.trackIds,
      songIds,
    );
    assertEquals(s.calls.remove.at(-1), []);
    p.append('songIndexToRemove', '2.0');
    p.append('songIndexToRemove', '2.0');
    p.append('songIndexToRemove', '9007199254740993');
    p.append('songIdToAdd', id(106));
    p.append('songIdToAdd', id(101));
    p.set('name', 'Edited');
    assertEquals((await s.get('updatePlaylist', p)).status, 'ok');
    assertEquals(s.calls.remove.at(-1), [2, 2, 9007199254740992]);
    const readback = (await s.get('getPlaylist', { id: s.playlist.id }))
      .playlist as { name: string; entry: { id: string }[] };
    assertEquals(readback.name, 'Edited');
    assertEquals(
      readback.entry.map((v) => v.id),
      [101, 102, 104, 105, 106, 106, 101].map(id),
    );
  } finally {
    await s.close();
  }
});

Deno.test('numeric HLS rejects rounded fractions before remux and preserves existence precedence and legacy range', async () => {
  const s = await setup();
  try {
    // Establish route/auth/song readiness with an ordinary invalid index first.
    assertEquals(
      (await s.get('hls/segment.ts', { id: id(106), segmentIndex: 'junk' }))
        .error?.code,
      10,
    );
    for (const segmentIndex of fractions) {
      assertEquals(
        (await s.get('hls/segment.ts', { id: id(106), segmentIndex })).error
          ?.code,
        10,
      );
      assertEquals(s.calls.hls, []);
    }
    assertEquals(
      (await s.get('hls/segment.ts', {
        id: id(999),
        segmentIndex: '1.0000000000000001',
      })).error?.code,
      70,
    );
    assertEquals(
      (await s.get('hls/segment.ts', { segmentIndex: '1.0000000000000001' }))
        .error?.message,
      'Required parameter is missing',
    );
    assertEquals(
      (await s.get('hls/segment.ts', { id: id(106) })).error?.code,
      10,
    );
    assertEquals(
      (await s.rest('hls/segment.ts', {
        id: id(106),
        segmentIndex: '9007199254740993',
      })).status,
      404,
    );
    assertEquals(
      s.calls.hls.length,
      1,
      'legacy unsafe integral boundary accepted before past-end',
    );
    assertEquals(
      await (await s.rest('hls/segment.ts', { id: id(106), segmentIndex: '' }))
        .text(),
      'fixture-segment',
    );
  } finally {
    await s.close();
  }
});

Deno.test('numeric OwnTone volume/output and seek preserve first-valid precedence and legacy forwarding', async () => {
  const s = await setup();
  try {
    s.playback.setVolume({ volume: 50 });
    assertEquals(
      (await s.ownRequest('/api/player/volume', {
        volume: '33.0000000000000001',
        step: '-3',
      }, 'PUT')).status,
      204,
    );
    assertEquals(s.calls.volume.at(-1), { step: -3 });
    assertEquals((await (await s.ownRequest('/api/player')).json()).volume, 47);
    assertEquals(
      (await s.ownRequest(
        '/api/player/volume',
        { volume: '3.3e1', step: '-3' },
        'PUT',
      )).status,
      204,
    );
    assertEquals((await (await s.ownRequest('/api/player')).json()).volume, 33);
    assertEquals(
      (await s.ownRequest('/api/player/volume', {
        volume: '33.0000000000000001',
        step: '-3',
        output_id: '0',
      }, 'PUT')).status,
      204,
    );
    assertEquals(
      (await (await s.ownRequest('/api/outputs/0')).json()).volume,
      47,
    );
    assertEquals(
      (await s.ownRequest('/api/player/volume', { volume: '1e-400' }, 'PUT'))
        .status,
      400,
    );
    assertEquals(
      (await s.ownRequest(
        '/api/player/volume',
        { volume: '9007199254740993' },
        'PUT',
      )).status,
      204,
    );
    assertEquals(s.calls.volume.at(-1), { volume: 9007199254740992 });
    assertEquals(
      (await s.ownRequest('/api/player/seek', {
        position_ms: '1.0000000000000001',
      }, 'PUT')).status,
      400,
    );
    assertEquals(
      (await s.ownRequest('/api/player/seek', { position_ms: '1.0' }, 'PUT'))
        .status,
      500,
      'valid seek empty engine',
    );
    const song = (await s.library.getSong(id(101)))!;
    s.playback.queueAdd([song]);
    assertEquals(
      (await s.ownRequest('/api/player/seek', {
        position_ms: '1.0000000000000001',
        seek_ms: '1000',
      }, 'PUT')).status,
      204,
    );
    assertEquals(s.calls.seek.at(-1), { seekMs: 1000 });
    const player = await (await s.ownRequest('/api/player')).json();
    assertEquals(player.state, 'play');
    assert(
      player.item_progress_ms >= 1000 && player.item_progress_ms < 1500,
      'actual relative-seek engine readback',
    );
    assertEquals(
      (await s.ownRequest('/api/player/seek', {
        position_ms: '9007199254740993',
        seek_ms: '1',
      }, 'PUT')).status,
      204,
    );
    assertEquals(s.calls.seek.at(-1), { positionMs: 9007199254740992 });
    assertEquals(
      (await s.ownRequest('/api/player/seek', { position_ms: '-1.0' }, 'PUT'))
        .status,
      204,
      'signed legacy seek reaches core',
    );
  } finally {
    await s.close();
  }
});

Deno.test('numeric OwnTone queue invalid positioning cannot clear/start; signed unsafe values forwarded', async () => {
  const s = await setup();
  try {
    const song = (await s.library.getSong(id(101)))!;
    s.playback.queueAdd([song]);
    const initial = s.playback.queueView();
    for (const key of ['position', 'playback_from_position']) {
      for (const raw of fractions) {
        assertEquals(
          (await s.ownRequest('/api/queue/items/add', {
            uris: 'library:track:102',
            clear: 'true',
            playback: 'start',
            [key]: raw,
          }, 'POST')).status,
          400,
        );
        assertEquals(s.playback.queueView(), initial);
        assertEquals(s.playback.playerView().state, 'stop');
        assertEquals(s.calls.queue, []);
      }
    }
    for (const position of ['9007199254740993', '-1.0']) {
      assertEquals(
        (await s.ownRequest('/api/queue/items/add', {
          uris: 'library:track:102',
          position,
          playback_from_position: '9007199254740993',
        }, 'POST')).status,
        200,
      );
      assertEquals(
        s.calls.queue.at(-1)!.position,
        position === '-1.0' ? -1 : 9007199254740992,
      );
      assertEquals(
        s.calls.queue.at(-1)!.playbackFromPosition,
        9007199254740992,
      );
    }
    assertEquals(s.playback.queueView().items.length, 3);
  } finally {
    await s.close();
  }
});

Deno.test('numeric OwnTone all nine paging routes prove items total offsets limits and search branches', async () => {
  const s = await setup();
  try {
    const routes: [
      string,
      Record<string, string>,
      string | undefined,
      (number | string)[],
      string,
    ][] = [
      ['/api/library/albums', {}, undefined, ['21', '22', '23'], 'id'],
      ['/api/library/albums/21/tracks', {}, undefined, [101, 102], 'id'],
      ['/api/library/artists', {}, undefined, ['11', '12', '13'], 'id'],
      ['/api/library/artists/11/albums', {}, undefined, ['21'], 'id'],
      ['/api/library/playlists', {}, undefined, [wireInt(s.playlist.id)], 'id'],
      [
        `/api/library/playlists/${wireInt(s.playlist.id)}/tracks`,
        {},
        undefined,
        [101, 102, 103, 104, 105, 106],
        'id',
      ],
      ['/api/library/genres', {}, undefined, ['Jazz'], 'name'],
      ['/api/library/files', { directory: `${s.dir}/music` }, 'tracks', [
        101,
        102,
        103,
        104,
        105,
        106,
      ], 'id'],
      ['/api/search', { type: 'tracks', query: 'Track' }, 'tracks', [
        101,
        102,
        103,
        104,
        105,
        106,
      ], 'id'],
    ];
    for (const [path, base, group, expected, key] of routes) {
      const page = async (p: Record<string, string> = {}): Promise<Page> => {
        const r = await s.ownRequest(path, { ...base, ...p });
        assertEquals(r.status, 200, path);
        const result = await r.json();
        return group ? result[group] : result;
      };
      for (const limit of ['-1.0', '-1e0']) {
        const got = await page({ limit });
        assertEquals(
          got.items.map((v) => v[key as keyof typeof v]),
          expected,
          path,
        );
        assertEquals(
          { total: got.total, offset: got.offset, limit: got.limit },
          { total: expected.length, offset: 0, limit: -1 },
        );
      }
      const got = await page({ offset: '1.0', limit: '1e0' });
      assertEquals(
        got.items.map((v) => v[key as keyof typeof v]),
        expected.slice(1, 2),
      );
      assertEquals({ total: got.total, offset: got.offset, limit: got.limit }, {
        total: expected.length,
        offset: 1,
        limit: 1,
      });
      const suppressed = await page({ limit: '0' });
      assertEquals(suppressed.items, []);
      assertEquals(suppressed.total, expected.length);
      for (const key of ['offset', 'limit']) {
        for (
          const value of ['1.0000000000000001', '1e-400', '9007199254740992.5']
        ) {
          assertEquals(
            (await s.ownRequest(path, { ...base, [key]: value })).status,
            400,
            `${path}.${key}`,
          );
        }
        const unsafe = await page({ [key]: '9007199254740993' });
        assertEquals(unsafe[key as 'offset' | 'limit'], 9007199254740992);
        assertEquals(
          unsafe.items.map((v) => v.id ?? v.name),
          key === 'offset' ? [] : expected,
        );
      }
    }
    const pipe = await s.ownRequest('/api/search', {
      type: 'tracks,artists,albums,playlists,genres,composers',
      expression: 'data_kind is pipe',
      offset: '1.0',
      limit: '-1e0',
    });
    assertEquals(pipe.status, 200);
    for (const page of Object.values(await pipe.json()) as Page[]) {
      assertEquals(page, { items: [], total: 0, offset: 1, limit: -1 });
    }
    assertEquals(
      (await s.ownRequest('/api/search', {
        type: 'tracks',
        expression: 'data_kind is pipe',
        limit: '1e-400',
      })).status,
      400,
    );
    const genre = await s.ownRequest('/api/search', {
      type: 'tracks',
      expression: 'genre is "Jazz"',
      limit: '1.0',
    });
    assertEquals(
      (await genre.json()).tracks.items.map((v: { id: number }) => v.id),
      [101],
    );
  } finally {
    await s.close();
  }
});

Deno.test('fractional bookmark client queue and scrobble seconds remain fractional inputs', async () => {
  const s = await setup();
  try {
    assertEquals(
      (await s.get('createBookmark', { id: id(101), position: '1234.75' }))
        .status,
      'ok',
    );
    assertEquals((await s.bookmarks.list(s.cfg.user))[0].positionMs, 1234);
    assertEquals(
      (await s.get('savePlayQueue', {
        id: id(101),
        current: id(101),
        position: '1234.75',
      })).status,
      'ok',
    );
    assertEquals((await s.clientQueue.get(s.cfg.user))!.positionMs, 1234);
    assertEquals(
      (await s.get('scrobble', {
        id: id(101),
        submission: 'false',
        position: '1.25',
      })).status,
      'ok',
    );
    assertEquals((await s.playback.nowPlayingView())[0].positionMs, 1250);
  } finally {
    await s.close();
  }
});

const formTypes = [
  'application/x-www-form-urlencoded',
  'Application/X-Www-Form-Urlencoded',
  'APPLICATION/X-WWW-FORM-URLENCODED',
  'aPpLiCaTiOn/x-WwW-fOrM-uRlEnCoDeD; charset=UTF-8',
  'application/x-www-form-urlencoded \t; charset="utf-8"; fixture="a;b"',
  '\t application/x-www-form-urlencoded\t ',
];
const nonFormTypes = [
  undefined,
  'application/x-www-form-urlencodedjunk',
  'application/x-www-form-urlencoded+json',
  'junkapplication/x-www-form-urlencoded',
  'application/json',
  'multipart/form-data; boundary=fixture',
  'text/plain',
];
for (const [index, contentType] of [...formTypes, ...nonFormTypes].entries()) {
  for (const method of ['POST', 'GET']) {
    Deno.test(`MIME exact essence decoder recognition ${index} ${method}`, async () => {
      const form = new FormData();
      form.append('n', '');
      form.append('n', 'form-second');
      let decoded = 0;
      const headers = new Headers(
        contentType ? { 'content-type': contentType } : {},
      );
      const originalHeader = headers.get('content-type');
      const request: HatRequest = {
        method,
        headers,
        params: {},
        query: new URLSearchParams('n=query-first&n=query-second'),
        _raw: new Request('http://x'),
        body: {
          json: () => Promise.reject(new Error('Params must not decode JSON')),
          form: () => {
            decoded++;
            return Promise.resolve(form);
          },
        },
      };
      const result = await requestParams(request);
      const shouldDecode = method === 'POST' && index < formTypes.length;
      assertEquals(
        decoded,
        shouldDecode ? 1 : 0,
        'exact normalized essence selects original decoder',
      );
      assertEquals(
        [...result],
        shouldDecode
          ? [['n', ''], ['n', 'form-second'], ['n', 'query-first'], [
            'n',
            'query-second',
          ]]
          : [['n', 'query-first'], ['n', 'query-second']],
      );
      assertEquals(
        result.get('n'),
        shouldDecode ? '' : 'query-first',
        'empty first scalar does not fall through',
      );
      assertEquals(
        headers.get('content-type'),
        originalHeader,
        'original header unchanged',
      );
    });
  }
}

for (const [index, contentType] of formTypes.entries()) {
  Deno.test(`MIME facade Unicode authentication and scalar numeric precedence ${index}`, async () => {
    const s = await setup();
    try {
      const post = async (
        op: string,
        form: URLSearchParams,
        query = 'u=wrong&p=wrong&f=json',
      ): Promise<Envelope> => {
        const response = await s.app(
          new Request(`http://x/rest/${op}?${query}`, {
            method: 'POST',
            headers: { 'content-type': contentType },
            body: form.toString(),
          }),
        );
        assertEquals(response.status, 200);
        assert(
          response.headers.get('content-type')?.startsWith('application/json'),
        );
        return (await response.json())['subsonic-response'];
      };
      const user = await post('getUser', s.auth());
      assertEquals(user.status, 'ok');
      assertEquals((user.user as { username: string }).username, s.cfg.user);
      const rating = s.auth();
      rating.set('id', id(101));
      rating.set('rating', '+2.0');
      assertEquals(
        (await post(
          'setRating.view',
          rating,
          'u=wrong&p=wrong&f=json&rating=5',
        )).status,
        'ok',
      );
      assertEquals(
        await rawSql(s.db).all('SELECT rating FROM ratings'),
        [{ rating: 2 }],
      );
      rating.set('rating', '');
      assertEquals(
        (await post('setRating', rating, 'rating=5&f=json')).status,
        'ok',
      );
      assertEquals(
        await rawSql(s.db).all('SELECT rating FROM ratings'),
        [],
      );
      await s.annotation.setRating(s.cfg.user, id(101), 4);
      rating.set('rating', '1e-400');
      assertEquals(
        (await post('setRating', rating, 'rating=5&f=json')).error?.code,
        0,
      );
      assertEquals(
        await rawSql(s.db).all('SELECT rating FROM ratings'),
        [{ rating: 4 }],
      );
      const catalog = s.auth();
      catalog.set('query', '');
      catalog.set('artistCount', '0');
      catalog.set('albumCount', '0');
      catalog.set('songCount', '1.0000000000000001');
      const page = await post('search3', catalog, 'query=absent&f=json');
      assertEquals(page.status, 'ok');
      assertEquals(
        (page.searchResult3 as { song: { id: string }[] }).song.map((v) =>
          v.id
        ),
        songIds,
      );
      // The empty first form u is absent (H1C row 5): code 10, never a
      // fall-through to the valid query u, which would succeed.
      const emptyCredential = s.auth();
      emptyCredential.set('u', '');
      assertEquals(
        (await post('getMusicFolders', emptyCredential, s.auth().toString()))
          .error?.code,
        10,
      );
    } finally {
      await s.close();
    }
  });
}

Deno.test('MIME facade ordered repeated form/query fields reach recording and persisted consumers', async () => {
  const s = await setup();
  try {
    const post = async (
      op: string,
      p: URLSearchParams,
      query: URLSearchParams,
    ): Promise<Envelope> => {
      const response = await s.app(
        new Request(`http://x/rest/${op}?${query}`, {
          method: 'POST',
          headers: {
            'content-type':
              'Application/X-Www-Form-Urlencoded; charset="utf-8"',
          },
          body: p.toString(),
        }),
      );
      assertEquals(response.status, 200);
      return (await response.json())['subsonic-response'];
    };
    const star = s.auth();
    for (const n of [105, 101, 105]) star.append('id', id(n));
    const query = new URLSearchParams({ f: 'json', id: id(102) });
    assertEquals((await post('star.view', star, query)).status, 'ok');
    assertEquals(
      s.calls.stars,
      [105, 101, 105, 102].map(id),
      'service call order, including duplicate',
    );
    const readback = await s.get('getStarred2');
    assertEquals(
      (readback.starred2 as { song: { id: string }[] }).song.map((v) => v.id)
        .sort(),
      [101, 102, 105].map(id).sort(),
    );
    const form = s.auth();
    form.set('name', 'Form + café 雪');
    for (const n of [106, 101, 106]) form.append('songId', id(n));
    const qp = new URLSearchParams({ name: 'wrong query name', f: 'json' });
    for (const n of [102, 105]) qp.append('songId', id(n));
    const created = (await post('createPlaylist', form, qp)).playlist as {
      id: string;
      name: string;
      entry: { id: string }[];
    };
    assertEquals(created.name, 'Form + café 雪');
    const expected = [106, 101, 106, 102, 105].map(id);
    assertEquals(created.entry.map((v) => v.id), expected);
    assertEquals(
      (await s.playlists.get(s.cfg.user, created.id))!.trackIds,
      expected,
    );
    const bookmark = s.auth();
    bookmark.set('id', id(101));
    bookmark.set('position', '+1234.75');
    bookmark.set('comment', 'memo &=+% café 雪');
    assertEquals(
      (await post(
        'createBookmark',
        bookmark,
        new URLSearchParams({ position: '9999', comment: 'wrong', f: 'json' }),
      )).status,
      'ok',
    );
    const persisted = (await s.bookmarks.list(s.cfg.user))[0];
    assertEquals({
      id: persisted.trackId,
      position: persisted.positionMs,
      comment: persisted.comment,
    }, { id: id(101), position: 1234, comment: 'memo &=+% café 雪' });
    const fetched = (await s.get('getBookmarks')).bookmarks as {
      bookmark: { position: number; comment: string }[];
    };
    assertEquals(fetched.bookmark[0].position, 1234);
    assertEquals(fetched.bookmark[0].comment, 'memo &=+% café 雪');
  } finally {
    await s.close();
  }
});

Deno.test('MIME facade non-form types retain query auth and exact public discovery JSON/XML', async () => {
  const s = await setup();
  try {
    for (const type of nonFormTypes) {
      const headers = new Headers(type ? { 'content-type': type } : {});
      const response = await s.app(
        new Request(`http://x/rest/getMusicFolders?${s.auth()}`, {
          method: 'POST',
          headers,
          body: new TextEncoder().encode('u=wrong&p=wrong&f=xml'),
        }),
      );
      assertEquals(response.status, 200);
      assertEquals((await response.json())['subsonic-response'].status, 'ok');
    }
    for (const format of ['json', 'xml']) {
      const form = new URLSearchParams({ f: format, u: 'wrong', p: 'wrong' });
      const response = await s.app(
        new Request('http://x/rest/getOpenSubsonicExtensions.view?f=json', {
          method: 'POST',
          headers: { 'content-type': 'APPLICATION/X-WWW-FORM-URLENCODED' },
          body: form.toString(),
        }),
      );
      assertEquals(response.status, 200);
      if (format === 'json') {
        const body = (await response.json())['subsonic-response'];
        assertEquals(body.openSubsonicExtensions, [
          {
            name: 'formPost',
            versions: [1],
          },
          { name: 'transcodeOffset', versions: [1] },
          { name: 'transcoding', versions: [1] },
          { name: 'songLyrics', versions: [1, 2] },
        ]);
        assertEquals(Object.keys(body).sort(), [
          'openSubsonic',
          'openSubsonicExtensions',
          'serverVersion',
          'status',
          'type',
          'version',
        ]);
      } else {
        const text = await response.text();
        assert(
          response.headers.get('content-type')?.startsWith('application/xml'),
        );
        assert(
          text.includes(
            '<openSubsonicExtensions name="formPost"><versions>1</versions></openSubsonicExtensions>',
          ),
        );
        assert(text.includes('status="ok"'));
      }
    }
  } finally {
    await s.close();
  }
});
