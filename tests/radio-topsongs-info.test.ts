import { assert, assertEquals, assertRejects } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { Buffer } from 'node:buffer';
import { Decoder, Demuxer } from 'node-av';
import { createReference, type Reference } from '../src/reference.ts';
import { createLibrary } from '../src/library.ts';
import { createArtwork } from '../src/artwork.ts';
import { createLibraries } from '../src/libraries.ts';
import { createListens } from '../src/listens.ts';
import { createUserService } from '../src/user.ts';
import { encryptPassword } from '../src/users.ts';
import { rawSql } from '../src/store/testing.ts';
import { createLookupRunner } from '../src/lookups/runner.ts';
import { createLookupNetwork } from '../src/lookups/net.ts';
import { loadLayers } from '../src/layers.ts';
import { facade } from '../src/facade.ts';
import { resizeImage } from '../src/media.ts';
import { tagged } from './helpers/tagged.ts';
import { referenceFixture } from './helpers/reference.ts';
import { eventually, lookupManifest, lookupPlugin } from './helpers/lookup.ts';
import type { ReferenceProvider } from '../src/reference.ts';

type Fixture = Awaited<ReturnType<typeof referenceFixture>>;
async function consumer(f: Fixture, reference: Reference) {
  const cfg = {
    dataDir: `${f.dir}/data`,
    secret: 'secret',
    listen: undefined,
    user: 'admin',
    password: 'test',
  };
  const library = createLibrary(f.store, undefined, { dataDir: cfg.dataDir });
  const http = facade(
    await pathfinder({
      roots: ['core/'],
      app: { store: f.store, cfg, state: f.state },
    }),
    await loadLayers({
      app: {
        cfg,
        library,
        reference,
        state: f.state,
        libraries: createLibraries(f.store),
        artwork: createArtwork(library, {
          state: f.state,
          dataDir: cfg.dataDir,
        }),
        annotation: f.annotation,
        listens: createListens(f.store),
        user: createUserService(f.store, cfg),
      },
    }),
  );
  const request = (
    op: string,
    params: Record<string, string> = {},
    method = 'GET',
  ) => {
    const query = new URLSearchParams({
      u: 'admin',
      p: 'test',
      v: '1.16.1',
      c: 'g10',
      f: 'json',
      ...params,
    });
    return http(
      new Request(
        `http://x/rest/${op}.view${method === 'GET' ? `?${query}` : ''}`,
        method === 'POST' ? { method, body: query } : { method },
      ),
    );
  };
  return {
    http,
    request,
    async call(
      op: string,
      params: Record<string, string> = {},
      method = 'GET',
    ) {
      const res = await request(op, params, method);
      assertEquals(res.status, 200);
      return (await res.json())['subsonic-response'];
    },
  };
}
const localReference = (f: Fixture) =>
  createReference({
    store: f.store,
    state: f.state,
    providers: () => Promise.resolve([]),
    enqueue: () => Promise.resolve(),
  });
async function add(
  f: Fixture,
  title: string,
  album: string,
  artist: string,
  track = 1,
  disc = 1,
  root = f.root,
) {
  const folder = `${root}/${artist}/${album}`;
  await Deno.mkdir(folder, { recursive: true });
  await tagged(`${folder}/${title}.mp3`, {
    TIT2: title,
    TALB: album,
    TPE1: artist,
    TPE2: artist,
    TRCK: String(track),
    TPOS: String(disc),
  });
}

Deno.test('top songs HTTP: exact user history ordering, played-album pool, track credits, library union and id/name precedence', async () => {
  const f = await referenceFixture();
  try {
    const otherRoot = `${f.dir}/other`;
    await Deno.mkdir(otherRoot);
    await createLibraries(f.store).add('Other', otherRoot);
    for (
      const [title, album, track, disc] of [
        ['a1', 'A', 1, 1],
        ['a2', 'A', 2, 1],
        ['a3', 'A', 3, 1],
        ['a4', 'A', 1, 2],
        ['b1', 'B', 2, 1],
        ['b2', 'B', 1, 1],
        ['b3', 'B', 1, 2],
        ['c1', 'C', 1, 1],
        ['d1', 'D', 1, 1],
      ] as const
    ) {
      await add(
        f,
        title,
        album,
        'Artist',
        track,
        disc,
        album === 'B' ? otherRoot : f.root,
      );
    }
    // A compilation credits Artist on the track, another artist on the album.
    await Deno.mkdir(`${f.root}/Compilation`);
    await tagged(`${f.root}/Compilation/guest.mp3`, {
      TIT2: 'guest',
      TALB: 'Compilation',
      TPE1: 'Artist',
      TPE2: 'Owner',
    });
    await tagged(`${otherRoot}/Artist/B/other.mp3`, {
      TIT2: 'other',
      TALB: 'B',
      TPE1: 'Other Performer',
      TPE2: 'Artist',
    });
    await f.scan.run();
    const reference = localReference(f);
    const { call } = await consumer(f, reference);
    const songs = await f.store.catalog.listSongs({ offset: 0, size: 100 });
    const song = (title: string) => songs.find((s) => s.title === title)!;
    const artist = song('a1').artistId!;
    const tops = async (params: Record<string, string> = { id: artist }) =>
      (await call('getTopSongs', params)).topSongs.song as {
        id: string;
        title: string;
        playCount: number;
      }[];
    assertEquals(await tops(), [], 'no plays means no local top songs');
    // A real second user with the same password, isolated listen history.
    const encrypted = await encryptPassword('secret', 'test');
    await rawSql(f.store).run(
      `INSERT INTO users (id,name,password_enc,role,created_at) VALUES ('other','other','${encrypted}','user',now())`,
    );
    await call('scrobble', { id: song('d1').id, time: '9000', u: 'other' });
    assertEquals(await tops(), [], 'another user cannot open the album pool');
    const play = async (title: string, times: number[]) => {
      for (const time of times) {
        assertEquals(
          (await call('scrobble', { id: song(title).id, time: String(time) }))
            .status,
          'ok',
        );
      }
    };
    await play('a1', [1000, 2000]);
    await play('a2', [3000, 4000]);
    await play('b1', [5000]);
    await play('other', [1000, 2000, 3000, 4000, 5000]);
    await play('guest', [6000]);
    const expected = ['a2', 'a1', 'guest', 'b1', 'b2', 'b3', 'a3', 'a4'];
    const result = await tops();
    assertEquals(
      result.map((s) => s.title),
      expected,
      'played counts, recent-play tie, then unplayed grouped by album plays/disc/track',
    );
    assertEquals(result.map((s) => s.playCount), [
      2,
      2,
      1,
      1,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    assertEquals(
      (await tops({ artist: 'aRtIsT' })).map((s) => s.id),
      result.map((s) => s.id),
    );
    assertEquals(
      (await call(
        'getTopSongs',
        { id: artist, artist: 'Owner', count: '3' },
        'POST',
      )).topSongs.song.map((s: { title: string }) => s.title),
      expected.slice(0, 3),
    );
    assertEquals(
      (await call('getTopSongs', { id: 'missing', artist: 'Artist' })).topSongs
        .song,
      [],
      'id wins even when unknown',
    );
    assertEquals(
      (await call('getTopSongs', { artist: 'Art' })).topSongs.song,
      [],
      'no substring matching',
    );
    assertEquals(
      (await call('getTopSongs', { id: song('guest').albumId! })).topSongs.song,
      [],
      'id must identify an artist',
    );
    assertEquals((await call('getTopSongs')).error.code, 10);
    assertEquals(
      (await call('getTopSongs', { id: artist, count: '0' })).topSongs.song,
      [],
    );
    assertEquals(
      (await call('getTopSongs', { artist: 'Owner' })).topSongs.song,
      [],
      'album owner gets no performer credit',
    );
    assertEquals(
      (await call('getTopSongs', { id: artist, u: 'other' })).topSongs.song.map(
        (s: { title: string }) => s.title,
      ),
      ['d1'],
    );
    assert(
      (await call('getOpenSubsonicExtensions')).openSubsonicExtensions.some((
        e: { name: string; versions: number[] },
      ) => e.name === 'topSongsByArtistId' && e.versions.join() === '1'),
    );
    const xml = await (await consumer(f, reference)).request('getTopSongs', {
      id: artist,
      count: '1',
      f: 'xml',
    });
    assert(
      (await xml.text()).includes(`<topSongs><song id="${song('a2').id}"`),
    );
  } finally {
    await f.close();
  }
});

Deno.test('radio and artist info HTTP: real background Worker facts, matched library mixes, local image URLs and empty/unknown contracts', async () => {
  const f = await referenceFixture();
  let runner: Awaited<ReturnType<typeof createLookupRunner>> | undefined;
  const blocked = Promise.withResolvers<void>();
  let hits = 0;
  const mbid = '12345678-1234-1234-1234-123456789abc';
  const taggedMbid = '87654321-4321-4321-4321-cba987654321';
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (req) => {
      hits++;
      const bundle = await req.json();
      await blocked.promise;
      if (bundle.type === 'track') {
        return Response.json({
          values: {
            'track.similar': [
              { title: 'seed', artist: 'Main' },
              { title: 'remoteMatch', artist: 'Related' },
              { title: 'remoteMatch', artist: 'Related' },
              { title: 'Absent', artist: 'Absent' },
            ],
          },
        });
      }
      return Response.json({
        values: {
          'artist.biography': { text: '<p>Biography &amp; facts</p>' },
          'artist.url': { url: 'https://example.test/artist' },
          'artist.id.mbid': mbid,
          'artist.similar': bundle.name === 'Main'
            ? [{ name: 'Not Here' }, { name: 'Related' }]
            : [],
          'artist.topTracks': bundle.name === 'Main'
            ? [
              { title: 'mainTop', artist: 'Main' },
              { title: 'seed', artist: 'Main' },
              { title: 'Absent', artist: 'Absent' },
              { title: 'mainTop', artist: 'Main' },
            ]
            : [{ title: 'remoteMatch', artist: 'Related' }, {
              title: 'relatedTop',
              artist: 'Related',
            }],
        },
      });
    },
  );
  try {
    for (
      const [title, artist] of [
        ['seed', 'Main'],
        ['mainTop', 'Main'],
        ['genreOnly', 'Main'],
        ['remoteMatch', 'Related'],
        ['relatedTop', 'Related'],
      ] as const
    ) {
      await add(
        f,
        title,
        artist === 'Main' ? 'Main Album' : 'Related Album',
        artist,
      );
    }
    // Only these two tracks share a genre; top-up must come from reference tops.
    for (const title of ['seed', 'genreOnly']) {
      await tagged(`${f.root}/Main/Main Album/${title}.mp3`, {
        TIT2: title,
        TALB: 'Main Album',
        TPE1: 'Main',
        TPE2: 'Main',
        TCON: 'Rock',
        TXXX: `MusicBrainz Artist Id\0${taggedMbid}`,
      });
    }
    await Deno.mkdir(`${f.root}/Unknown`);
    await tagged(`${f.root}/Unknown/untagged.mp3`, { TIT2: 'untagged' });
    const cover = await Deno.readFile(
      'tests/fixtures/library/Fixture Artist/Fixture Album/cover.jpg',
    );
    const photo = new Uint8Array(
      await resizeImage(cover, 1500, 1000, 'jpeg', 90),
    );
    await Deno.writeFile(`${f.root}/Main/artist.jpg`, photo);
    await Deno.writeFile(`${f.root}/Related/Related Album/cover.jpg`, cover);
    await f.scan.run();
    await lookupPlugin(
      `${f.dir}/data/plugins/lookups`,
      `const fetchValues = async (facts, ctx) => await (await ctx.fetch('https://fixture.test/facts', {method:'POST',body:JSON.stringify(facts)})).json(); export default { artist: fetchValues, track: fetchValues };`,
      'fixture',
      lookupManifest({
        capabilities: [
          {
            id: 'artist',
            accepts: 'artist',
            provides: [
              'artist.biography',
              'artist.url',
              'artist.id.mbid',
              'artist.similar',
              'artist.topTracks',
            ],
            requires: [],
          },
          {
            id: 'track',
            accepts: 'track',
            provides: ['track.similar'],
            requires: [],
          },
        ],
        network: { hosts: ['fixture.test'], ratePerMinute: 600000 },
      }),
    );
    await f.state.set('lookups.plugin.fixture.hosts', 'fixture.test');
    const network = createLookupNetwork({
      state: f.state,
      fixtures: { 'fixture.test': `http://127.0.0.1:${server.addr.port}` },
    });
    runner = await createLookupRunner({
      store: f.store,
      state: f.state,
      dataDir: `${f.dir}/data`,
      builtin: `${f.dir}/empty`,
      network,
    });
    const c = await consumer(f, runner.reference);
    const songs = await f.store.catalog.listSongs({ offset: 0, size: 100 });
    const song = (title: string) => songs.find((s) => s.title === title)!;
    const main = song('seed').artistId!;
    const related = song('remoteMatch').artistId!;
    const within = async (promise: ReturnType<typeof c.call>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('HTTP waited for blocked plugin')),
              2000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const first = await within(
      c.call('getSimilarSongs', { id: song('seed').id }),
    );
    assertEquals(first.similarSongs.song.map((s: { id: string }) => s.id), [
      song('genreOnly').id,
    ]);
    assertEquals(
      (await within(c.call('getTopSongs', { id: main }))).topSongs.song,
      [],
    );
    const firstInfo =
      (await within(c.call('getArtistInfo', { id: main }))).artistInfo;
    assertEquals(firstInfo.biography, undefined);
    assert(firstInfo.smallImageUrl);
    await eventually(() => hits > 0);
    assert((await rawSql(f.store).all('SELECT * FROM lookup_jobs')).length > 0);
    assertEquals(
      await f.store.reference.get('artist', main),
      [],
      'blocked network has not recorded facts',
    );
    blocked.resolve();
    await eventually(async () =>
      (await f.store.reference.get('artist', main)).length === 5 &&
      (await f.store.reference.get('track', song('seed').id)).length === 1
    );
    assertEquals(
      (await c.call('getTopSongs', { id: main })).topSongs.song.map((
        s: { title: string },
      ) => s.title),
      ['mainTop', 'seed'],
    );
    // Queue and observe the related artist's stored top list before the mix.
    await c.call('getTopSongs', { id: related });
    await eventually(async () =>
      (await f.store.reference.get('artist', related)).length === 5
    );
    for (const op of ['getSimilarSongs', 'getSimilarSongs2']) {
      const result = (await c.call(op, { id: song('seed').id, count: '50' }))[
        op === 'getSimilarSongs' ? 'similarSongs' : 'similarSongs2'
      ].song as { id: string }[];
      assertEquals(
        new Set(result.map((s) => s.id)),
        new Set(
          ['remoteMatch', 'mainTop', 'relatedTop'].map((t) => song(t).id),
        ),
      );
      assertEquals(result.length, 3);
      assertEquals(
        result[0].id,
        song('remoteMatch').id,
        'track recommendations precede artist top-up',
      );
      assertEquals(
        (await c.call(op, { id: song('seed').id, count: '0' }))[
          op === 'getSimilarSongs' ? 'similarSongs' : 'similarSongs2'
        ].song,
        [],
      );
      assertEquals((await c.call(op, { id: 'missing' })).error.code, 70);
      assertEquals((await c.call(op)).error.code, 10);
    }
    const artistRadio = (await c.call('getSimilarSongs2', { id: main }))
      .similarSongs2.song as { id: string }[];
    assertEquals(
      new Set(artistRadio.map((s) => s.id)),
      new Set(
        ['seed', 'mainTop', 'remoteMatch', 'relatedTop'].map((t) => song(t).id),
      ),
    );
    assertEquals(artistRadio.length, 4);
    // All tracks of the main album obtain the same fixture list. Seed exclusion is per-track.
    await c.call('getSimilarSongs', { id: song('seed').albumId! });
    await eventually(async () =>
      (await f.store.reference.get('track', song('mainTop').id)).length === 1 &&
      (await f.store.reference.get('track', song('genreOnly').id)).length === 1
    );
    assertEquals(
      new Set(
        (await c.call('getSimilarSongs', { id: song('seed').albumId! }))
          .similarSongs.song.map((s: { id: string }) => s.id),
      ),
      new Set([song('seed').id, song('remoteMatch').id]),
    );
    await f.state.set('opensubsonic.similarSongsMax', '1');
    assertEquals(
      (await c.call('getSimilarSongs', { id: main, count: '99999999' }))
        .similarSongs.song.length,
      1,
    );
    await assertRejects(() => f.state.set('opensubsonic.similarSongsMax', '0'));
    for (const op of ['getArtistInfo', 'getArtistInfo2']) {
      const key = op === 'getArtistInfo' ? 'artistInfo' : 'artistInfo2';
      const info =
        (await c.call(op, { id: main, includeNotPresent: 'true' }))[key];
      assertEquals(info.biography, 'Biography & facts');
      assertEquals(
        info.musicBrainzId,
        taggedMbid,
        'tag identity precedes external reference identity',
      );
      assertEquals(info.lastFmUrl, 'https://example.test/artist');
      assertEquals(info.similarArtist.map((a: { id: string }) => a.id), [
        related,
        '-1',
      ]);
      assertEquals(info.similarArtist[1].name, 'Not Here');
      assertEquals(
        info.similarArtist[0].albumCount,
        op === 'getArtistInfo2' ? 1 : undefined,
      );
      assertEquals(
        (await c.call(op, { id: main, count: '1' }))[key].similarArtist.map((
          a: { id: string },
        ) => a.id),
        [related],
      );
      assertEquals(
        (await c.call(op, { id: main, count: '0' }))[key].similarArtist,
        undefined,
      );
      for (const id of [song('seed').id, song('seed').albumId!]) {
        assertEquals(
          (await c.call(op, { id }))[key],
          (await c.call(op, { id: main }))[key],
        );
      }
      assertEquals(
        (await c.call(op, { id: related }))[key].smallImageUrl,
        undefined,
        'album art is not an artist photo',
      );
      assertEquals(
        (await c.call(op, { id: related }))[key].musicBrainzId,
        mbid,
        'reference identity fills missing tags',
      );
      assertEquals((await c.call(op, { id: 'missing' })).error.code, 70);
      const indexes = await c.call('getArtists');
      const unknown = indexes.artists.index.flatMap((
        i: { artist: { id: string; name: string }[] },
      ) => i.artist).find((a: { name: string }) =>
        a.name === '[Unknown Artist]'
      );
      assert(unknown);
      assertEquals((await c.call(op, { id: unknown.id }))[key], {});
      assertEquals((await c.call(op, { id: song('untagged').id }))[key], {});
      const post = (await c.call(op, { id: main }, 'POST'))[key];
      for (
        const [field, size] of [
          ['smallImageUrl', 300],
          ['mediumImageUrl', 600],
          ['largeImageUrl', 1200],
        ] as const
      ) {
        const url = new URL(post[field]);
        assertEquals(url.origin, 'http://x');
        assertEquals(url.pathname, '/rest/getCoverArt');
        assertEquals(url.searchParams.get('id'), main);
        assertEquals(url.searchParams.get('size'), String(size));
        const response = await c.http(new Request(url));
        assertEquals(response.status, 200);
        await using input = await Demuxer.open(
          Buffer.from(await response.arrayBuffer()),
        );
        const stream = input.video()!;
        await using decoder = await Decoder.create(stream);
        let observed = false;
        for await (const frame of decoder.frames(input.packets(stream.index))) {
          if (!frame) continue;
          try {
            assertEquals([frame.width, frame.height], [size, size * 2 / 3]);
            observed = true;
          } finally {
            frame.free();
          }
        }
        assert(
          observed,
          'URL fetch decodes a real photo of the requested size',
        );
      }
      const xml = await c.request(op, {
        id: main,
        includeNotPresent: 'true',
        f: 'xml',
      });
      const text = await xml.text();
      assert(text.includes('<biography>Biography &amp; facts</biography>'));
      assert(text.includes('id="-1" name="Not Here"'));
    }
    // Missing/stale facts still return their stored value while a refresh is queued.
    await f.state.set('reference.refreshHours', '0.001');
    await rawSql(f.store).run(
      'UPDATE reference_facts SET fetched_at = to_timestamp(1)',
    );
    assertEquals(
      (await c.call('getArtistInfo2', { id: main })).artistInfo2.biography,
      'Biography & facts',
    );
  } finally {
    blocked.resolve();
    await runner?.close();
    await server.shutdown();
    await f.close();
  }
});

Deno.test('reference HTTP defaults and live sampling/weight settings operate on complete recorded library pools', async () => {
  const f = await referenceFixture();
  try {
    const mainTitles = Array.from(
      { length: 60 },
      (_, i) => `Main Track ${String(i).padStart(3, '0')}`,
    );
    const relatedNames = Array.from({ length: 21 }, (_, i) => `Related ${i}`);
    for (const title of mainTitles) await add(f, title, 'Main Album', 'Main');
    for (const name of relatedNames) {
      await add(f, 'Other Track', 'Other Album', name);
    }
    await f.scan.run();
    const songs = await f.store.catalog.listSongs({ offset: 0, size: 100 });
    const main = songs.find((s) => s.title === mainTitles[0])!;
    const artistProvider: ReferenceProvider = {
      plugin: 'fixture',
      capability: {
        id: 'artist',
        accepts: 'artist',
        provides: ['artist.topTracks', 'artist.similar'],
        requires: [],
      },
    };
    const trackProvider: ReferenceProvider = {
      plugin: 'fixture',
      capability: {
        id: 'track',
        accepts: 'track',
        provides: ['track.similar'],
        requires: [],
      },
    };
    const reference = createReference({
      store: f.store,
      state: f.state,
      providers: (type) =>
        Promise.resolve([type === 'artist' ? artistProvider : trackProvider]),
      enqueue: () => Promise.resolve(),
      random: () => 0.6,
    });
    const c = await consumer(f, reference);
    await reference.record(
      'artist',
      main.artistId!,
      'fixture',
      artistProvider.capability.provides,
      {
        'artist.topTracks': mainTitles.map((title) => ({
          title,
          artist: 'Main',
        })),
        'artist.similar': relatedNames.map((name) => ({ name })),
      },
    );
    for (const name of relatedNames) {
      const artist = songs.find((s) => s.artistName === name)!;
      await reference.record(
        'artist',
        artist.artistId!,
        'fixture',
        artistProvider.capability.provides,
        {
          'artist.topTracks': [{ title: 'Other Track', artist: name }],
        },
      );
    }
    for (let i = 0; i < mainTitles.length; i++) {
      const song = songs.find((s) => s.title === mainTitles[i])!;
      await reference.record('track', song.id, 'fixture', ['track.similar'], {
        'track.similar': [{
          title: mainTitles[(i + 1) % mainTitles.length],
          artist: 'Main',
        }],
      });
    }
    assertEquals(
      (await c.call('getTopSongs', { id: main.artistId! })).topSongs.song
        .length,
      50,
    );
    assertEquals(
      (await c.call('getTopSongs', { id: main.artistId!, count: '100' }))
        .topSongs.song.length,
      60,
    );
    assertEquals(
      (await c.call('getSimilarSongs', { id: main.artistId! })).similarSongs
        .song.length,
      50,
    );
    assertEquals(
      (await c.call('getArtistInfo2', { id: main.artistId! })).artistInfo2
        .similarArtist.length,
      20,
    );
    assertEquals(
      (await c.call('getArtistInfo2', { id: main.artistId!, count: '21' }))
        .artistInfo2.similarArtist.length,
      21,
    );
    assertEquals(await f.state.getTyped('opensubsonic.similarSongsMax'), 500);
    assertEquals(await f.state.getTyped('reference.radioAlbumSeeds'), 5);
    const albumRadio =
      (await c.call('getSimilarSongs', { id: main.albumId!, count: '100' }))
        .similarSongs.song as { id: string }[];
    assertEquals(
      albumRadio.length,
      5,
      'five distinct sampled seeds contribute their stored recommendation',
    );
    assertEquals(new Set(albumRadio.map((s) => s.id)).size, 5);
    await f.state.set('reference.radioAlbumSeeds', '1');
    assertEquals(
      (await c.call('getSimilarSongs2', { id: main.albumId!, count: '100' }))
        .similarSongs2.song.length,
      1,
    );
    await f.state.set('reference.radioMinTopTracks', '1');
    await f.state.set('reference.radioSimilarArtists', '1');
    const pick = async () =>
      (await c.call('getSimilarSongs', { id: main.artistId!, count: '1' }))
        .similarSongs.song[0];
    assertEquals(
      (await pick()).id,
      main.id,
      'weighted draw favors the seed artist',
    );
    await f.state.set('reference.radioArtistWeight', '1');
    assertEquals(
      (await pick()).artist,
      relatedNames[0],
      'same draw chooses the related artist with equal weights',
    );
    for (const count of ['0', '-1']) {
      assertEquals(
        (await c.call('getSimilarSongs', { id: main.artistId!, count }))
          .similarSongs.song,
        [],
      );
    }
  } finally {
    await f.close();
  }
});
