import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { Demuxer, Dictionary, Muxer } from 'node-av';
import { apiFixture, error } from './helpers/api.ts';
import { tagged } from './helpers/tagged.ts';
import { eventually, lookupManifest, lookupPlugin } from './helpers/lookup.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLookupRunner } from '../src/lookups/runner.ts';
import { createListens } from '../src/listens.ts';
import { createAnnotation } from '../src/annotation.ts';
import { artistReferenceNames } from '../src/reference-types.ts';
import { rawSql } from '../src/store/testing.ts';

const mbid = '11111111-1111-4111-8111-111111111111';
const emptyInfo = {
  biography: null,
  musicBrainzId: null,
  url: null,
  similarArtists: [],
};

async function referenceFixture() {
  const root = await Deno.makeTempDir({ prefix: 'melofon-api-reference-' });
  let runner: Awaited<ReturnType<typeof createLookupRunner>> | undefined;
  try {
    const f = await apiFixture({
      services: async (f) => {
        const libraries = createLibraries(f.store);
        for (const name of ['Music', 'Second', 'Empty']) {
          await Deno.mkdir(`${root}/${name}`);
          await libraries.add(name, `${root}/${name}`);
        }
        const tracks: [string, Record<string, string>][] = [
          ['Music/A/a.mp3', {
            TIT2: 'Duplicate',
            TALB: 'A',
            TPE1: 'Artist',
            TSRC: 'USAAA0100001',
          }],
          ['Music/A/b.mp3', { TIT2: 'Two', TALB: 'A', TPE1: 'Artist' }],
          ['Music/B/c.mp3', { TIT2: 'Three', TALB: 'B', TPE1: 'Artist' }],
          ['Second/C/d.mp3', {
            TIT2: 'Duplicate',
            TALB: 'C',
            TPE1: 'Artist',
            TSRC: 'USAAA0100001',
          }],
          ['Music/Near/n.mp3', { TIT2: 'Near song', TPE1: 'Near' }],
          ['Second/Far/f.mp3', { TIT2: 'Far song', TPE1: 'Far' }],
          ['Music/Guest/g.mp3', {
            TIT2: 'Guest song',
            TPE1: 'Guest',
            TPE2: 'Artist',
          }],
          ['Music/Various/x.mp3', { TALB: 'Mix', TPE1: 'One' }],
          ['Music/Various/y.mp3', { TALB: 'Mix', TPE1: 'Two' }],
          ['Music/Unknown/u.mp3', {}],
          ['Music/TaggedVA/v.mp3', { TPE1: 'Various Artists' }],
        ];
        for (const [path, tags] of tracks) {
          await Deno.mkdir(`${root}/${path.slice(0, path.lastIndexOf('/'))}`, {
            recursive: true,
          });
          await tagged(`${root}/${path}`, tags);
        }
        await scanLibrary(f.store);
        await lookupPlugin(
          `${f.dir}/plugins/lookups`,
          `export default { artist() { return {values: {
          'artist.biography': {text: '<p>Biography &amp; music</p>', language: 'en'},
          'artist.url': {url: 'https://provider.example/artist'},
          'artist.id.mbid': '${mbid}',
          'artist.similar': [{name:'Far'}, {name:'Outside',mbid:'${mbid}'}, {name:'Near'}, {name:'Guest'}]
        }}; } };`,
          'fixture',
          lookupManifest({
            capabilities: [{
              id: 'artist',
              accepts: 'artist',
              provides: [...artistReferenceNames],
              requires: [],
            }],
            network: { hosts: [], ratePerMinute: 600000 },
          }),
        );
        runner = await createLookupRunner({
          store: f.store,
          state: f.state,
          notify: f.notify!,
          dataDir: f.dir,
          builtin: `${root}/empty-plugins`,
        });
        return {
          library: createLibrary(f.store),
          libraries,
          reference: runner.reference,
        };
      },
    });
    for (const username of ['alice', 'bob']) {
      await f.auth.users.create(f.admin.id, {
        username,
        password: `password-${username}`,
        role: 'user',
      });
    }
    const songs = await f.store.catalog.listSongs({ offset: 0, size: 100 });
    const song = (file: string) =>
      songs.find((s) => s.path.endsWith(`/${file}.mp3`))!;
    const artistId = song('a').artistId!;
    const libraries = await f.store.catalog.listLibraries();
    return {
      ...f,
      root,
      songs,
      song,
      artistId,
      runner: runner!,
      music: libraries.find((l) => l.name === 'Music')!.id,
      second: libraries.find((l) => l.name === 'Second')!.id,
      empty: libraries.find((l) => l.name === 'Empty')!.id,
      async close() {
        await runner!.close();
        await f.close();
        await Deno.remove(root, { recursive: true });
      },
    };
  } catch (error) {
    await runner?.close();
    await Deno.remove(root, { recursive: true });
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof referenceFixture>>;
function path(f: Fixture, resource = 'info', id = f.artistId) {
  return `/api/v1/artists/${id}/${resource}`;
}
async function read(f: Fixture, credential: string, url: string) {
  const response = await f.get(url, credential, {
    Origin: 'http://foreign.home',
    'If-None-Match': '*',
  });
  assertEquals(response.status, 200, await response.clone().text());
  assertEquals(response.headers.get('cache-control'), 'private, no-store');
  assertEquals(response.headers.get('etag'), null);
  return await response.json();
}
async function acquired(f: Fixture) {
  await f.runner.reference.refresh('artist', f.artistId);
  await eventually(async () =>
    (await f.store.reference.get('artist', f.artistId)).length ===
      artistReferenceNames.length
  );
  await idle(f);
}
async function idle(f: Fixture) {
  await eventually(async () =>
    (await rawSql(f.store).all<{ state: string }>(
      'SELECT state FROM lookup_jobs',
    )).every((job) => job.state === 'done' || job.state === 'failed')
  );
}
const ids = (body: { songs: { id: string }[] }) => body.songs.map((s) => s.id);

Deno.test('API artist reference: discovered fixture worker persists biography, link and similar artists consumed with cookie and Bearer', async () => {
  const f = await referenceFixture();
  try {
    const cookie =
      (await f.login('cookie', 'alice', 'password-alice')).credential;
    // The first read queues acquisition without awaiting the worker.
    assertEquals((await read(f, cookie, path(f))).info.biography, null);
    await eventually(async () =>
      (await f.store.reference.get('artist', f.artistId)).length ===
        artistReferenceNames.length
    );
    await idle(f);
    const kept = await f.store.reference.get('artist', f.artistId);
    assert(kept.every((fact) => fact.plugin === 'fixture'));
    for (const use of ['cookie', 'bearer'] as const) {
      const credential =
        (await f.login(use, 'alice', 'password-alice')).credential;
      const body = await read(
        f,
        credential,
        path(f) + '?includeNotPresent=true',
      );
      assertEquals(Object.keys(body), ['info']);
      assertEquals(body.info.biography, {
        text: 'Biography & music',
        language: 'en',
      });
      assertEquals(body.info.url, 'https://provider.example/artist');
      assertEquals(body.info.musicBrainzId, mbid);
      const related = body.info.similarArtists;
      assertEquals(related.map((a: { name: string }) => a.name), [
        'Far',
        'Outside',
        'Near',
        'Guest',
      ]);
      assertEquals(related[1], {
        present: false,
        name: 'Outside',
        musicBrainzId: mbid,
      });
      for (
        const row of related.filter((a: { present: boolean }) => a.present)
      ) {
        const detail = await f.get(`/api/v1/artists/${row.id}`, credential);
        assertEquals(detail.status, 200);
        const { present, ...summary } = row;
        assert(present);
        assertEquals(summary, (await detail.json()).artist);
      }
      assertEquals(
        (await read(f, credential, path(f))).info.similarArtists.length,
        3,
      );
      assert(!JSON.stringify(body).includes(f.root));
      assert(!JSON.stringify(body).includes('userRating'));
    }
    assert(f.peers.every((p) => p !== '127.0.0.1' && p !== '::1'));
    await scanLibrary(f.store);
    assertEquals(await f.store.reference.get('artist', f.artistId), kept);
    assertEquals(
      (await read(f, cookie, path(f))).info.biography.text,
      'Biography & music',
    );
  } finally {
    await f.close();
  }
});

Deno.test('API artist reference: library presence is resolved before similar count and external artists have no catalog identity', async () => {
  const f = await referenceFixture();
  try {
    await acquired(f);
    for (const use of ['cookie', 'bearer'] as const) {
      const credential =
        (await f.login(use, 'alice', 'password-alice')).credential;
      const scoped = await read(
        f,
        credential,
        path(f) + `?library=${f.music}&limit=1`,
      );
      assertEquals(
        scoped.info.similarArtists.map((a: { name: string }) => a.name),
        ['Near'],
      );
      assertEquals(scoped.info.similarArtists[0].id, f.song('n').artistId);
      const expanded = await read(
        f,
        credential,
        path(f) + `?library=${f.music}&includeNotPresent=true`,
      );
      assertEquals(expanded.info.similarArtists[0], {
        present: false,
        name: 'Far',
        musicBrainzId: null,
      });
      assertEquals(expanded.info.similarArtists[1], {
        present: false,
        name: 'Outside',
        musicBrainzId: mbid,
      });
      assertEquals(
        (await read(f, credential, path(f) + `?library=${f.second}&limit=1`))
          .info.similarArtists[0].name,
        'Far',
      );
      // Track-only artists remain reference-addressable, unlike artist root membership.
      const guest = await read(
        f,
        credential,
        path(f, 'info', f.song('g').artistId!) + `?library=${f.music}`,
      );
      assertEquals(Object.keys(guest), ['info']);
    }
  } finally {
    await f.close();
  }
});

Deno.test('API artist top songs: requesting user played-album pool and library eligibility precede limit, without personal fields', async () => {
  const f = await referenceFixture();
  try {
    await acquired(f); // Provider has no top tracks, so use the agreed local fallback.
    const listens = createListens(f.store);
    for (let i = 0; i < 3; i++) {
      await listens.record('alice', f.song('a').id, { source: 'test' });
    }
    await listens.record('alice', f.song('c').id, { source: 'test' });
    await listens.record('alice', f.song('d').id, { source: 'test' });
    await listens.record('bob', f.song('d').id, { source: 'test' });
    const expected = [f.song('a').id, f.song('d').id, f.song('c').id];
    // Latest ties are explicit, not dependent on wall-clock millisecond collisions.
    await listens.record('alice', f.song('d').id, {
      source: 'test',
      playedAtMs: Date.now() + 1000,
    });
    for (const use of ['cookie', 'bearer'] as const) {
      const alice = (await f.login(use, 'alice', 'password-alice')).credential;
      const bob = (await f.login(use, 'bob', 'password-bob')).credential;
      const body = await read(f, alice, path(f, 'top-songs'));
      assertEquals(ids(body), [...expected, f.song('b').id]);
      assertEquals(body.limit, 50);
      assertEquals(ids(await read(f, bob, path(f, 'top-songs'))), [
        f.song('d').id,
      ]);
      assertNotEquals(ids(body), ids(await read(f, bob, path(f, 'top-songs'))));
      assertEquals(
        ids(
          await read(
            f,
            alice,
            path(f, 'top-songs') + `?library=${f.music}&limit=2`,
          ),
        ),
        [f.song('a').id, f.song('c').id],
      );
      assertEquals(
        ids(
          await read(
            f,
            bob,
            path(f, 'top-songs') + `?library=${f.music}&limit=1`,
          ),
        ),
        [],
      );
      for (const row of body.songs) {
        const response = await f.get(`/api/v1/songs/${row.id}`, alice);
        assertEquals(response.status, 200);
        assertEquals(row, (await response.json()).song);
        for (
          const key of [
            'starred',
            'userRating',
            'averageRating',
            'playCount',
            'played',
            'lastPlayed',
          ]
        ) assert(!(key in row));
      }
      assert(!JSON.stringify(body).includes(f.root));
    }
    const admin = (await f.login('bearer')).credential;
    assertEquals(ids(await read(f, admin, path(f, 'top-songs'))), []);
  } finally {
    await f.close();
  }
});

Deno.test('API artist top songs: provider matching filters before ranking and truncation for ISRC and fuzzy duplicate copies', async () => {
  const f = await referenceFixture();
  try {
    await acquired(f);
    const credential =
      (await f.login('bearer', 'alice', 'password-alice')).credential;
    const recording = '22222222-2222-4222-8222-222222222222';
    for (const library of ['Music', 'Second']) {
      await using input = await Demuxer.open('tests/fixtures/media/clip.flac');
      await using output = await Muxer.open(`${f.root}/${library}/exact.flac`, {
        input,
        format: 'flac',
        configure(ctx) {
          using dict = Dictionary.fromObject({
            title: 'Exact',
            artist: 'Artist',
            MUSICBRAINZ_TRACKID: recording,
          });
          ctx.metadata = dict;
        },
      });
      const stream = output.addStream(input.streams[0]);
      for await (const packet of input.packets()) {
        if (!packet) continue;
        try {
          await output.writePacket(packet, stream);
        } finally {
          packet.free();
        }
      }
      await output.close();
    }
    await scanLibrary(f.store);
    const exactCopies =
      (await f.store.catalog.listSongs({ offset: 0, size: 100 })).filter((s) =>
        s.metadata?.recordingMbid === recording
      );
    assertEquals(exactCopies.length, 2);
    const localExact = exactCopies.find((s) => s.libraryId === f.music)!;
    const remoteExact = exactCopies.find((s) => s.libraryId === f.second)!;
    await createAnnotation(f.store).star('alice', f.song('d').id);
    await createAnnotation(f.store).star('alice', remoteExact.id);
    for (
      const [duplicate, expected] of [
        [{ title: 'Ignored', isrc: 'USAAA0100001' }, f.song('a').id],
        [{ title: 'Duplicate', artist: 'Artist' }, f.song('a').id],
        [{ title: 'Ignored', mbid: recording }, localExact.id],
      ] as const
    ) {
      await f.store.reference.put('artist', f.artistId, 'fixture', [
        'artist.topTracks',
      ], {
        'artist.topTracks': [{ title: 'Far song', artist: 'Far' }, duplicate, {
          title: 'Two',
          artist: 'Artist',
        }],
      }, Date.now());
      assertEquals(
        ids(await read(f, credential, path(f, 'top-songs') + '?limit=1')),
        [f.song('f').id],
      );
      const scoped = await read(
        f,
        credential,
        path(f, 'top-songs') + `?library=${f.music}&limit=1`,
      );
      assertEquals(
        ids(scoped),
        [expected],
        'ineligible starred copy cannot win the match',
      );
      const two = await read(
        f,
        credential,
        path(f, 'top-songs') + `?library=${f.music}&limit=2`,
      );
      assertEquals(ids(two), [expected, f.song('b').id]);
      assert(
        two.songs.every((s: { libraryId: string }) => s.libraryId === f.music),
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test('API artist reference: unknown and scoped-out artists are 404; placeholders stay empty and never enter lookup intake', async () => {
  const f = await referenceFixture();
  try {
    const credential =
      (await f.login('cookie', 'alice', 'password-alice')).credential;
    for (const resource of ['info', 'top-songs']) {
      for (const id of ['missing', f.song('a').albumId!]) {
        await error(
          await f.get(path(f, resource, id), credential),
          404,
          'not_found',
        );
      }
      await error(
        await f.get(path(f, resource) + `?library=${f.empty}`, credential),
        404,
        'not_found',
      );
      await error(
        await f.get(
          path(f, resource, f.song('g').artistId!) + `?library=${f.second}`,
          credential,
        ),
        404,
        'not_found',
      );
      for (const id of ['unknown', 'various']) {
        assertEquals(
          await read(f, credential, path(f, resource, id)),
          resource === 'info' ? { info: emptyInfo } : { songs: [], limit: 50 },
        );
        await error(
          await f.get(
            path(f, resource, id) + `?library=${f.second}`,
            credential,
          ),
          404,
          'not_found',
        );
      }
    }
    assertEquals(
      await rawSql(f.store).all('SELECT entity_id FROM lookup_jobs'),
      [],
    );
    const realVA = f.song('v').artistId!;
    assertNotEquals(realVA, 'various');
    await read(f, credential, path(f, 'info', realVA));
    await eventually(async () =>
      (await f.store.reference.get('artist', realVA)).length ===
        artistReferenceNames.length
    );
    assertEquals(
      (await read(f, credential, path(f, 'info', realVA))).info.biography.text,
      'Biography & music',
    );
  } finally {
    await f.close();
  }
});

Deno.test('API artist reference: strict query, shared limits, authentication precedence, foreign-Origin reads and method errors', async () => {
  const f = await referenceFixture();
  try {
    const cookie =
      (await f.login('cookie', 'alice', 'password-alice')).credential;
    for (const resource of ['info', 'top-songs']) {
      const url = path(f, resource);
      await error(await f.get(url), 401, 'unauthenticated');
      await error(
        await f.get(url, cookie, {
          Authorization: 'Bearer invalid',
          'If-None-Match': '*',
        }),
        401,
        'unauthenticated',
      );
      for (const use of ['cookie', 'bearer'] as const) {
        const credential =
          (await f.login(use, 'alice', 'password-alice')).credential;
        for (
          const query of [
            '?unknown=1',
            '?library=',
            '?library=a&library=b',
            '?limit=0',
            '?limit=501',
            '?limit=1e2',
            '?limit=-1',
            '?limit=1&limit=2',
            '?offset=1',
            '?limit=9007199254740992',
          ]
        ) {
          await error(
            await f.get(url + query, credential),
            400,
            'invalid_field',
          );
        }
        await error(
          await f.get(url + '?library=missing', credential),
          404,
          'not_found',
        );
        const response = await f.json(url, 'POST', {}, credential);
        await error(response, 405, 'method_not_allowed');
        assertEquals(response.headers.get('allow'), 'GET');
      }
    }
    for (
      const query of [
        '?includeNotPresent=1',
        '?includeNotPresent=',
        '?includeNotPresent=true&includeNotPresent=false',
      ]
    ) await error(await f.get(path(f) + query, cookie), 400, 'invalid_field');
    await error(
      await f.get(path(f, 'top-songs') + '?includeNotPresent=true', cookie),
      400,
      'invalid_field',
    );
    await acquired(f);
    await f.state.set('melofon.browseMaxPageRecords', '1');
    await f.state.set('melofon.browsePageRecords', '2');
    assertEquals(
      (await read(f, cookie, path(f))).info.similarArtists.length,
      1,
    );
    assertEquals((await read(f, cookie, path(f, 'top-songs'))).limit, 1);
    for (const resource of ['info', 'top-songs']) {
      await error(
        await f.get(path(f, resource) + '?limit=2', cookie),
        400,
        'invalid_field',
      );
    }
  } finally {
    await f.close();
  }
});
