import { assert, assertEquals, assertRejects } from '@std/assert';
import { Buffer } from 'node:buffer';
import { Decoder, Demuxer } from 'node-av';
import { pathfinder } from '@pathfinder/pathfinder';
import { LookupHost } from '../src/lookups/host.ts';
import { parseManifest } from '../src/lookups/manifest.ts';
import { createLookupNetwork } from '../src/lookups/net.ts';
import { createLookupRunner } from '../src/lookups/runner.ts';
import { createLibrary } from '../src/library.ts';
import { createLibraries } from '../src/libraries.ts';
import { createArtwork } from '../src/artwork.ts';
import { createUserService } from '../src/user.ts';
import { createListens } from '../src/listens.ts';
import { loadLayers } from '../src/layers.ts';
import { facade } from '../src/facade.ts';
import { referenceFixture } from './helpers/reference.ts';
import { eventually } from './helpers/lookup.ts';
import { pictured } from './helpers/pictured.ts';

const fixture = async (name: string) =>
  JSON.parse(await Deno.readTextFile(`tests/fixtures/deezer/${name}.json`));
const rawManifest = async () =>
  JSON.parse(await Deno.readTextFile('lookups/deezer/manifest.json'));
const artist = {
  version: 1,
  type: 'artist',
  id: 'beatles',
  name: 'The Beatles',
  ids: {},
  albums: ['Abbey Road'],
};
const defaults = {
  language: 'en',
  searchLimit: 50,
  topTrackLimit: 100,
  retrySeconds: 600,
};
type Hit = { url: URL; method: string; headers: Headers; body: string };

async function replay() {
  const bodies: Record<string, unknown> = {
    '/search/artist': await fixture('search'),
    '/artist/1/related': await fixture('related'),
    '/artist/1/top': await fixture('top'),
    '/login/anonymous': await fixture('auth'),
    '/api': await fixture('biography'),
  };
  const errors = new Map<string, () => Response>();
  const hits: Hit[] = [];
  const image = await Deno.readFile(
    'tests/fixtures/library/Fixture Artist/Fixture Album/cover.jpg',
  );
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      const url = new URL(request.url);
      hits.push({
        url,
        method: request.method,
        headers: request.headers,
        body: await request.text(),
      });
      const error = errors.get(url.pathname);
      if (error) return error();
      if (url.pathname.startsWith('/images/artist/')) {
        return new Response(image, {
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      return bodies[url.pathname]
        ? Response.json(bodies[url.pathname])
        : new Response('No fixture', { status: 404 });
    },
  );
  const manifest = parseManifest(await rawManifest(), 'deezer');
  const network = createLookupNetwork({
    fixtures: Object.fromEntries(
      manifest.network.hosts.map((
        host,
      ) => [host, `http://127.0.0.1:${server.addr.port}`]),
    ),
  });
  // Only accelerate spacing in offline fixtures; original production manifest
  // and host approvals remain intact. Every call still uses the real network.
  const fastNetwork: typeof network = {
    ...network,
    fetch(authority, input, init, limits) {
      return network.fetch(
        { ...authority, ratePerMinute: 600000 },
        input,
        init,
        limits,
      );
    },
  };
  return {
    bodies,
    errors,
    hits,
    image,
    manifest,
    network: fastNetwork,
    async close() {
      await server.shutdown();
    },
  };
}
async function withHost(
  fn: (
    f: Awaited<ReturnType<typeof replay>>,
    call: (
      capability: string,
      item?: typeof artist,
    ) => ReturnType<LookupHost['call']>,
    host: LookupHost,
  ) => Promise<void>,
) {
  const f = await replay();
  const host = new LookupHost({
    id: 'deezer',
    dir: await Deno.realPath('lookups/deezer'),
    manifest: f.manifest,
  }, f.network);
  await host.configure(true, f.manifest.network.hosts, defaults);
  const call = (id: string, item = artist) =>
    host.call(f.manifest.capabilities.find((c) => c.id === id)!, item, {
      timeoutMs: 10000,
      maxBytes: 1024 * 1024,
    });
  try {
    await fn(f, call, host);
  } finally {
    await host.stop();
    await f.close();
  }
}

Deno.test('Deezer manifest separates photo candidates and reference facts, declares bounded settings and only verified hosts', async () => {
  const m = parseManifest(await rawManifest(), 'deezer');
  assertEquals(m.capabilities, [
    {
      id: 'artist-photo',
      accepts: 'artist',
      provides: ['artist.image.primary'],
      requires: [],
    },
    {
      id: 'artist-reference',
      accepts: 'artist',
      provides: [
        'artist.similar',
        'artist.topTracks',
        'artist.biography',
        'artist.url',
      ],
      requires: [],
    },
  ]);
  assertEquals(m.network.hosts, [
    'api.deezer.com',
    'auth.deezer.com',
    'pipe.deezer.com',
    'cdn-images.dzcdn.net',
  ]);
  assertEquals(m.network.ratePerMinute, 20);
  assertEquals(
    Object.fromEntries(
      Object.entries(m.settings).map(([key, s]) => [key, s.default]),
    ),
    defaults,
  );
});

Deno.test('Deezer photo Worker ranks exact case before folded case and fans; homonyms stay medium, unmatched/placeholder photos absent', async () => {
  await withHost(async (f, call) => {
    const original = (await fixture('search')).data[0];
    const cases = [
      { rows: [original], id: 1, confidence: 'strong', exact: 1 },
      {
        rows: [
          { ...original, id: 2, name: 'THE BEATLES', nb_fan: 99999999 },
          original,
        ],
        id: 1,
        confidence: 'strong',
        exact: 1,
      },
      {
        rows: [original, { ...original, id: 2, nb_fan: 99999999 }],
        id: 2,
        confidence: 'medium',
        exact: 2,
      },
      {
        rows: [{ ...original, id: 2 }, original],
        id: 1,
        confidence: 'medium',
        exact: 2,
      },
      {
        rows: [{ ...original, id: 2, name: 'the beatles', nb_fan: 1 }, {
          ...original,
          id: 3,
          name: 'THE BEATLES',
          nb_fan: 2,
        }],
        id: 3,
        confidence: 'medium',
        exact: 0,
      },
      {
        rows: [
          { ...original, name: 'The Beatles Tribute', nb_fan: 99999999 },
          original,
        ],
        id: 1,
        confidence: 'strong',
        exact: 1,
      },
      { rows: [{ ...original, name: 'Beatles' }], id: null },
      { rows: [], id: null },
      {
        rows: [{
          ...original,
          picture_xl:
            'https://cdn-images.dzcdn.net/images/artist//1000x1000-000000-80-0-0.jpg',
        }],
        id: null,
      },
      { rows: [{ ...original, picture_xl: '' }], id: null },
    ];
    for (const c of cases) {
      f.bodies['/search/artist'] = { data: c.rows };
      const result = await call('artist-photo');
      assert('candidates' in result);
      assertEquals(result.candidates.length, c.id === null ? 0 : 1);
      if (c.id !== null) {
        const candidate = result.candidates[0];
        assertEquals(candidate.target, { type: 'artist', id: artist.id });
        assertEquals(candidate.confidence, c.confidence);
        assertEquals(candidate.evidence?.deezerId, c.id);
        assertEquals(candidate.evidence?.exactMatches, c.exact);
        assertEquals(
          candidate.values['artist.image.primary']?.url,
          original.picture_xl,
        );
      }
    }
    assertEquals(Object.fromEntries(f.hits[0].url.searchParams), {
      q: 'The Beatles',
      limit: '50',
      order: 'RANKING',
    });
    const n = f.hits.length;
    assertEquals(await call('artist-photo', { ...artist, name: '' }), {
      candidates: [],
    });
    assertEquals(f.hits.length, n);
    assertEquals(await call('artist-reference', { ...artist, name: '' }), {
      values: {},
    });
  });
});

Deno.test('Deezer reference Worker returns g6 values, optional ISRC, plain biography and requested GraphQL language', async () => {
  await withHost(async (f, call, host) => {
    const top = await fixture('top');
    top.data[0].isrc = 'GBAYE0601696'; // Optional field absent in the captured top response.
    f.bodies['/artist/1/top'] = top;
    await host.configure(true, f.manifest.network.hosts, {
      ...defaults,
      language: 'fr',
      topTrackLimit: 7,
    });
    const result = await call('artist-reference');
    assert('values' in result);
    assertEquals(result.values['artist.similar'], [{ name: 'John Lennon' }, {
      name: 'Paul McCartney',
    }, { name: 'The Rolling Stones' }]);
    assertEquals(
      result.values['artist.topTracks'],
      top.data.map((
        t: {
          title: string;
          artist: { name: string };
          album: { title: string };
          duration: number;
          isrc?: string;
        },
      ) => ({
        title: t.title,
        artist: t.artist.name,
        album: t.album.title,
        durationMs: t.duration * 1000,
        ...(t.isrc ? { isrc: t.isrc } : {}),
      })),
    );
    assertEquals(result.values['artist.url'], {
      url: 'https://www.deezer.com/artist/1',
    });
    const bio = result.values['artist.biography'];
    assert(bio);
    assert(
      bio.text.startsWith('Known as one of the most successful British bands'),
    );
    assert(!/<\/?(?:p|em)>|&nbsp;/.test(bio.text));
    assertEquals(bio.language, 'fr');
    const auth = f.hits.find((h) => h.url.pathname === '/login/anonymous')!;
    assertEquals(auth.method, 'GET');
    assertEquals(Object.fromEntries(auth.url.searchParams), {
      jo: 'p',
      rto: 'c',
    });
    const graph = f.hits.find((h) => h.url.pathname === '/api')!;
    assertEquals(graph.method, 'POST');
    assertEquals(
      graph.headers.get('authorization'),
      'Bearer synthetic-anonymous-fixture-token',
    );
    assertEquals(graph.headers.get('accept-language'), 'fr');
    assertEquals(graph.headers.get('content-type'), 'application/json');
    const query = JSON.parse(graph.body);
    assertEquals(query.operationName, 'ArtistBio');
    assertEquals(query.variables, { artistId: '1' });
    assert(query.query.includes('bio { full }'));
    assertEquals(
      f.hits.find((h) => h.url.pathname.endsWith('/top'))?.url.searchParams.get(
        'limit',
      ),
      '7',
    );
    f.bodies['/api'] = {
      data: {
        artist: {
          bio: {
            full:
              '<p>A &amp; B &#169;</p><script>bad()</script><p>C &lt; D</p>',
          },
        },
      },
    };
    const plain = await call('artist-reference');
    assert('values' in plain);
    assertEquals(plain.values['artist.biography'], {
      text: 'A & B © C < D',
      language: 'fr',
    });
  });
});

Deno.test('Deezer quota at every stage retries without freshness; individual HTTP/JSON/GraphQL failures retain other facts', async () => {
  await withHost(async (f, call, host) => {
    const all = [
      'artist.url',
      'artist.similar',
      'artist.topTracks',
      'artist.biography',
    ];
    for (
      const [path, missing] of [
        ['/artist/1/related', 'artist.similar'],
        ['/artist/1/top', 'artist.topTracks'],
        ['/login/anonymous', 'artist.biography'],
        ['/api', 'artist.biography'],
      ]
    ) {
      for (
        const response of [
          () => new Response('unavailable', { status: 500 }),
          () => new Response('{'),
          () => Response.json({ data: null }),
        ]
      ) {
        f.errors.set(path, response);
        const result = await call('artist-reference');
        assert('values' in result);
        assertEquals(
          Object.keys(result.values).sort(),
          all.filter((name) => name !== missing).sort(),
        );
      }
      f.errors.delete(path);
    }
    f.errors.set(
      '/api',
      () =>
        Response.json({
          errors: [{ message: 'not found' }],
          data: { artist: null },
        }),
    );
    const partial = await call('artist-reference');
    assert('values' in partial);
    assertEquals(
      Object.keys(partial.values).sort(),
      all.filter((name) => name !== 'artist.biography').sort(),
    );
    f.errors.clear();
    await host.configure(true, f.manifest.network.hosts, {
      ...defaults,
      retrySeconds: 42,
    });
    for (
      const path of [
        '/search/artist',
        '/artist/1/related',
        '/artist/1/top',
        '/login/anonymous',
        '/api',
      ]
    ) {
      f.errors.set(
        path,
        () =>
          Response.json({
            error: {
              type: 'Exception',
              code: 4,
              message: 'Quota limit exceeded',
            },
          }),
      );
      assertEquals(await call('artist-reference'), {
        retryAfter: 42,
        reason: 'Deezer quota exceeded',
      });
      if (path === '/search/artist') {
        assertEquals(await call('artist-photo'), {
          retryAfter: 42,
          reason: 'Deezer quota exceeded',
        });
      }
      f.errors.delete(path);
    }
    for (const status of [429, 503]) {
      f.errors.set(
        '/search/artist',
        () => new Response('', { status, headers: { 'retry-after': '0' } }),
      );
      assertEquals(await call('artist-photo'), {
        retryAfter: 0,
        reason: `Deezer HTTP ${status}`,
      });
      f.errors.set('/search/artist', () => new Response('', { status }));
      assertEquals(await call('artist-reference'), {
        retryAfter: 42,
        reason: `Deezer HTTP ${status}`,
      });
    }
    f.errors.set(
      '/search/artist',
      () => Response.json({ error: { code: 800, message: 'Unknown' } }),
    );
    await assertRejects(() => call('artist-photo'), Error, 'Deezer API error');
    f.errors.set('/search/artist', () => Response.json({ data: [{}] }));
    await assertRejects(
      () => call('artist-photo'),
      Error,
      'Invalid Deezer artist',
    );
    f.errors.clear();
    f.bodies['/search/artist'] = { data: [] };
    assertEquals(await call('artist-reference'), { values: {} });
  });
});

Deno.test('Deezer through core defaults to no network; approved fixture facts match real library and photo reaches getCoverArt', async () => {
  const f = await replay(), s = await referenceFixture();
  let runner: Awaited<ReturnType<typeof createLookupRunner>> | undefined;
  try {
    const top = await fixture('top');
    for (const [index, track] of top.data.slice(0, 2).entries()) {
      await pictured(`${s.root}/Beatles/Abbey Road/${index}.mp3`, undefined, {
        TIT2: track.title,
        TPE1: 'The Beatles',
        TPE2: 'The Beatles',
        TALB: track.album.title,
      });
    }
    await pictured(`${s.root}/Lennon/Album/song.mp3`, undefined, {
      TIT2: 'Imagine',
      TPE1: 'John Lennon',
      TPE2: 'John Lennon',
      TALB: 'Imagine',
    });
    await s.scan.run();
    const songs = await s.store.catalog.listSongs({ offset: 0, size: 10 });
    const beatles = songs.find((song) => song.artistName === 'The Beatles')!
      .artistId!;
    const lennon = songs.find((song) => song.artistName === 'John Lennon')!
      .artistId!;
    await s.state.set('lookups.plugin.itunes-covers.enabled', 'false');
    await s.state.set('lookups.maxAttempts', '1');
    runner = await createLookupRunner({
      store: s.store,
      state: s.state,
      dataDir: `${s.dir}/data`,
      builtin: await Deno.realPath('lookups'),
      network: f.network,
    });
    assertEquals(await s.state.getTyped('lookups.plugin.deezer.enabled'), true);
    assertEquals(await s.state.getTyped('lookups.plugin.deezer.hosts'), []);
    assertEquals(
      await s.state.getTyped('lookups.plugin.deezer.settings.language'),
      'en',
    );
    await runner.request({ type: 'artist', id: beatles }, 'all');
    await eventually(async () =>
      (await s.store.lookups.stats('deezer')).failed === 1
    );
    assertEquals(f.hits.length, 0, 'No network before explicit host approval');
    await s.state.set(
      'lookups.plugin.deezer.hosts',
      f.manifest.network.hosts.join(','),
    );
    await runner.request({ type: 'artist', id: beatles }, 'all');
    assertEquals(
      await runner.reference.get('artist', beatles, [
        'artist.topTracks',
        'artist.similar',
        'artist.biography',
        'artist.url',
      ]),
      {},
    );
    await eventually(async () =>
      (await s.store.lookups.stats('deezer')).done === 2
    );
    const [candidate] = await s.store.candidates.candidatesFor(
      'artist',
      beatles,
    );
    assertEquals(candidate.source, 'deezer');
    assertEquals(candidate.confidence, 'strong');
    const topIds = await runner.reference.topTracks(beatles, 100, 'admin');
    assertEquals(
      topIds,
      top.data.slice(0, 2).map((t: { title: string }) =>
        songs.find((song) => song.title === t.title)!.id
      ),
    );
    assertEquals(await runner.reference.similarArtists(beatles, 20), [
      { present: true, id: lennon },
      { present: false, name: 'Paul McCartney' },
      { present: false, name: 'The Rolling Stones' },
    ]);
    const library = createLibrary(s.store, undefined, {
      dataDir: `${s.dir}/data`,
    });
    const cfg = {
      dataDir: `${s.dir}/data`,
      user: 'admin',
      password: 'test',
      secret: 'secret',
      listen: undefined,
    };
    const http = facade(
      await pathfinder({
        roots: ['core/'],
        app: { store: s.store, cfg, state: s.state },
      }),
      await loadLayers({
        app: {
          cfg,
          state: s.state,
          reference: runner.reference,
          library,
          libraries: createLibraries(s.store),
          annotation: s.annotation,
          listens: createListens(s.store),
          artwork: createArtwork(library, {
            state: s.state,
            dataDir: cfg.dataDir,
          }),
          user: createUserService(s.store, cfg),
        },
      }),
    );
    const response = await http(
      new Request(
        `http://x/rest/getCoverArt?${new URLSearchParams({
          u: 'admin',
          p: 'test',
          v: '1.16.1',
          c: 'g9',
          id: beatles,
        })}`,
      ),
    );
    assertEquals(response.status, 200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assertEquals(
      bytes,
      f.image,
      'HTTP consumer receives downloaded photo bytes',
    );
    await using input = await Demuxer.open(Buffer.from(bytes));
    const stream = input.video()!;
    await using decoder = await Decoder.create(stream);
    let decoded = false;
    for await (const frame of decoder.frames(input.packets(stream.index))) {
      if (!frame) continue;
      try {
        assert(frame.width > 0 && frame.height > 0);
        decoded = true;
        break;
      } finally {
        frame.free();
      }
    }
    assert(decoded, 'HTTP response decodes as an actual image');
    const get = await s.consumer(runner.reference);
    assertEquals(
      (await get('getSong', { id: topIds[0] })).song.title,
      top.data[0].title,
    );
    assertEquals(
      (await runner.reference.get('artist', beatles, ['artist.biography']))[
        'artist.biography'
      ]?.language,
      'en',
    );
    const beforeQuota = await s.store.reference.get('artist', beatles);
    f.errors.set(
      '/artist/1/related',
      () =>
        Response.json({ error: { code: 4, message: 'Quota limit exceeded' } }),
    );
    await runner.reference.refresh('artist', beatles);
    await eventually(async () => {
      const stats = await s.store.lookups.stats('deezer');
      return stats.active === 0 && stats.waiting === 1;
    });
    assertEquals(
      await s.store.reference.get('artist', beatles),
      beforeQuota,
      'Quota never marks partial/absent facts fresh',
    );
    assertEquals(
      await runner.reference.topTracks(beatles, 100, 'admin'),
      topIds,
      'Previous facts remain usable during cooldown',
    );
  } finally {
    await runner?.close();
    await f.close();
    await s.close();
  }
});
