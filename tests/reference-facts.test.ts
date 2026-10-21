import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { Demuxer, Dictionary, Muxer } from 'node-av';
import { pathfinder } from '@pathfinder/pathfinder';
import { seedFirstUser } from '../src/users.ts';
import { createUserService } from '../src/user.ts';
import { createLibrary } from '../src/library.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { loadLayers } from '../src/layers.ts';
import { facade } from '../src/facade.ts';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { createState } from '../src/state.ts';
import { createLibraries } from '../src/libraries.ts';
import { createScan } from '../src/scan.ts';
import { createNotify } from '../src/notify.ts';
import { stableId } from '../src/albums.ts';
import { createLookupRunner } from '../src/lookups/runner.ts';
import { parseManifest } from '../src/lookups/manifest.ts';
import { parseResult } from '../src/lookups/host.ts';
import {
  artistReferenceNames,
  type ReferenceValues,
} from '../src/reference-types.ts';
import { eventually, lookupManifest, lookupPlugin } from './helpers/lookup.ts';
import { tagged } from './helpers/tagged.ts';

const mbid = '11111111-1111-4111-8111-111111111111';
const recording = '22222222-2222-4222-8222-222222222222';
const capabilities = [
  { id: 'artist', accepts: 'artist', provides: [...artistReferenceNames] },
  {
    id: 'track',
    accepts: 'track',
    provides: ['track.similar'],
    requires: ['track.id.mbid', 'track.id.isrc'],
  },
];
const manifest = () =>
  lookupManifest({
    capabilities,
    network: { hosts: ['127.0.0.1'], ratePerMinute: 600000 },
  });

Deno.test('reference boundary rejects invalid values and undeclared names; normalizes empty and HTML text', () => {
  const capability = parseManifest(manifest(), 'fixture').capabilities[0];
  const parse = (values: unknown) => parseResult({ values }, capability);
  for (
    const values of [
      { 'artist.biography': { text: 2 } },
      { 'artist.biography': { text: 'ok', language: 2 } },
      { 'artist.url': { url: 'file:///secret' } },
      { 'artist.id.mbid': 'bad' },
      { 'artist.similar': [{ name: 'Other', mbid: 'bad' }] },
      { 'artist.similar': [{ name: '' }] },
      { 'artist.topTracks': [{ title: 'Track', durationMs: -1 }] },
      { 'artist.topTracks': [{ title: 'Track', durationMs: Infinity }] },
      { 'artist.topTracks': [{ title: 'Track', artist: 2 }] },
      { 'artist.topTracks': [{ title: 'Track', isrc: [] }] },
      { 'artist.topTracks': [{ title: 'Track', unknown: true }] },
      { 'track.similar': [] },
      { 'artist.image.primary': { url: 'https://example.test/photo' } },
    ]
  ) assertThrows(() => parse(values));
  assertThrows(() => parseResult({ candidates: [] }, capability));
  assertThrows(() =>
    parseResult({ values: {}, retryAfter: 1, reason: 'busy' }, capability)
  );
  assertEquals(
    parse({
      'artist.biography': {
        text:
          '<script>bad()</script><!-- hidden --><p> A &amp; B </p><p>&#x1f3b5; &#169;</p>',
        language: 'en',
      },
    }),
    { values: { 'artist.biography': { text: 'A & B 🎵 ©', language: 'en' } } },
  );
  assertEquals(
    parse({
      'artist.biography': { text: '<style>hidden</style>' },
      'artist.similar': [],
      'artist.url': null,
      'artist.id.mbid': '',
    }),
    { values: {} },
  );
  assertEquals(parse({ 'artist.biography': { text: 'A < B &gt; C' } }), {
    values: { 'artist.biography': { text: 'A < B > C' } },
  });
});

Deno.test('reference service: real Worker/network consumers, background refresh, negative cache, ordering, rescan and purge', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'reference-' });
  const root = `${dir}/music`;
  await Deno.mkdir(root);
  let store = await openStore(`${dir}/data`);
  let state = createState(store);
  const notify = createNotify();
  let scan = createScan(store, undefined, { notify });
  let now = Date.now();
  let blocked = Promise.withResolvers<void>();
  const requests: {
    plugin: string;
    type: string;
    item: Record<string, unknown>;
  }[] = [];
  const responses = new Map<string, unknown[]>();
  const found = (name: string): { values: ReferenceValues } => ({
    values: {
      'artist.biography': {
        text: `<p>${name} &amp; music</p><script>hidden()</script>`,
        language: 'en',
      },
      ...(name === 'a'
        ? { 'artist.url': { url: 'https://example.test/artist' } }
        : {}),
      'artist.id.mbid': mbid,
      'artist.similar': [{ name: 'First', mbid }, { name: 'Second' }, {
        name: 'Third',
      }],
      'artist.topTracks': [
        {
          title: 'First',
          artist: 'Artist',
          album: 'Album',
          durationMs: 1000,
          mbid: recording,
          isrc: 'USAAA0100001',
        },
        { title: 'Second' },
        { title: 'Third' },
      ],
    },
  });
  const server = Deno.serve(
    { port: 0, hostname: '127.0.0.1', onListen() {} },
    async (request) => {
      const [, plugin, type] = new URL(request.url).pathname.split('/');
      const item = await request.json();
      requests.push({ plugin, type, item });
      await blocked.promise;
      const next = responses.get(`${plugin}/${type}`)?.shift();
      return Response.json(
        next ?? (type === 'artist' ? found(plugin) : {
          values: {
            'track.similar': [{
              title: 'Related',
              artist: 'Other',
              mbid: recording,
            }],
          },
        }),
      );
    },
  );
  let runner: Awaited<ReturnType<typeof createLookupRunner>> | undefined;
  const start = async () => {
    await runner?.close();
    runner = await createLookupRunner({
      store,
      state,
      notify,
      dataDir: `${dir}/data`,
      builtin: `${dir}/empty`,
      now: () => now,
    });
    return runner;
  };
  const jobs = () =>
    rawSql(store).all<
      { state: string; attempts: number; last_error: string | null }
    >('SELECT state, attempts, last_error FROM lookup_jobs');
  const idle = () =>
    eventually(async () =>
      (await jobs()).every((job) =>
        job.state === 'done' || job.state === 'failed'
      )
    );
  try {
    await createLibraries(store).add('Music', root);
    const cfg = {
      dataDir: `${dir}/data`,
      user: 'admin',
      password: 'test',
      secret: 'secret',
      listen: undefined,
    };
    await seedFirstUser(store, cfg);
    await tagged(`${root}/artist.mp3`, {
      TIT2: 'Tagged',
      TALB: 'Album',
      TPE1: 'Artist',
      TXXX: `MusicBrainz Artist Id\0${mbid}`,
    });
    await using input = await Demuxer.open('tests/fixtures/media/clip.flac');
    await using output = await Muxer.open(`${root}/track.flac`, {
      input,
      format: 'flac',
      configure(ctx) {
        using dict = Dictionary.fromObject({
          title: 'Track',
          album: 'Album',
          artist: 'Artist',
          MUSICBRAINZ_ARTISTID: mbid,
          MUSICBRAINZ_TRACKID: recording,
          ISRC: 'USAAA0100001',
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
    await tagged(`${root}/unknown.mp3`, { TIT2: 'Unknown', TALB: 'Unknown' });
    // A track-only performer still has artist reference facts.
    await tagged(`${root}/guest.mp3`, {
      TIT2: 'Guest',
      TALB: 'Guests',
      TPE1: 'Guest',
      TPE2: 'Artist',
    });
    await tagged(`${root}/various-one.mp3`, {
      TALB: 'Compilation',
      TPE1: 'One',
    });
    await tagged(`${root}/various-two.mp3`, {
      TALB: 'Compilation',
      TPE1: 'Two',
    });
    for (const plugin of ['a', 'b']) {
      await lookupPlugin(
        `${dir}/data/plugins/lookups`,
        `const run = async (item,ctx) => (await ctx.fetch('http://127.0.0.1:${server.addr.port}/${plugin}/'+item.type, {method:'POST',body:JSON.stringify(item)})).json(); export default {artist:run,track:run};`,
        plugin,
        manifest(),
      );
    }
    // Direct loopback fixtures explicitly opt in to the shared outbound policy.
    await state.set('net.allowPrivateDestinations', 'true');
    await state.set('lookups.maxAttempts', '1');
    const active = await start();
    const reference = active.reference;
    assertEquals(await state.getTyped('reference.order'), []);
    assertEquals(await state.getTyped('reference.refreshHours'), 24);
    assertEquals(await state.getTyped('reference.maxListItems'), 100);
    await assertRejects(() => state.set('reference.maxListItems', '0'));
    await assertRejects(() => state.set('reference.refreshHours', '0'));
    await assertRejects(() => state.set('reference.order', 'INVALID'));
    await state.set('reference.maxListItems', '2');
    await scan.run();
    await active.afterScan();
    assertEquals(await jobs(), [], 'scans never schedule reference jobs');
    const artistId = await stableId('artist', 'Artist');
    const http = facade(
      await pathfinder({ roots: ['core/'], app: { store, cfg, state } }),
      await loadLayers({
        app: {
          cfg,
          state,
          reference,
          library: createLibrary(store),
          libraries: createLibraries(store),
          annotation: createAnnotation(store),
          listens: createListens(store),
          user: createUserService(store, cfg),
        },
      }),
    );
    const response = await http(
      new Request(
        'http://x/rest/getArtists?u=admin&p=test&v=1.16.1&c=g6&f=json',
      ),
    );
    assertEquals(response.status, 200);
    const body = (await response.json())['subsonic-response'];
    assertEquals(body.status, 'ok');
    const protocolArtists = body.artists.index.flatMap((
      index: { artist: { id: string; name: string; musicBrainzId: string }[] },
    ) => index.artist) as { id: string; name: string; musicBrainzId: string }[];
    assertEquals(
      protocolArtists.find((artist) => artist.id === artistId)?.musicBrainzId,
      mbid,
    );
    const placeholders = protocolArtists.filter((artist) =>
      artist.name === '[Unknown Artist]' || artist.name === '[Various Artists]'
    );
    assertEquals(placeholders.length, 2);
    const track = (await store.catalog.listSongs({ offset: 0, size: 10 })).find(
      (song) => song.title === 'Track',
    )!;
    assertEquals(
      await reference.get('artist', artistId, artistReferenceNames),
      {},
    );
    await idle();
    assertEquals(requests, [], 'no network before operator approval');
    assertEquals(
      (await jobs()).filter((job) => job.state === 'failed').length,
      2,
    );
    for (const plugin of ['a', 'b']) {
      await state.set(`lookups.plugin.${plugin}.hosts`, '127.0.0.1');
    }
    // Hold both HTTP responses indefinitely. A read must still finish, and its
    // durable intake must dedupe reads/explicit refresh while work is active.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      assertEquals(
        await Promise.race([
          reference.get('artist', artistId, artistReferenceNames),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(Error('read waited for plugin')),
              1000,
            );
          }),
        ]),
        {},
      );
    } finally {
      clearTimeout(timer);
    }
    await eventually(() => requests.length === 2);
    await reference.get('artist', artistId, artistReferenceNames);
    await reference.refresh('artist', artistId);
    assertEquals(
      (await jobs()).filter((job) =>
        job.state === 'active' || job.state === 'waiting'
      ).length,
      2,
    );
    assertEquals((await store.reference.get('artist', artistId)).length, 0);
    blocked.resolve();
    await idle();
    const first = await reference.get('artist', artistId, artistReferenceNames);
    assertEquals(first['artist.biography'], {
      text: 'a & music',
      language: 'en',
    });
    assertEquals(first['artist.similar']?.map((a) => a.name), [
      'First',
      'Second',
    ]);
    assertEquals(first['artist.topTracks']?.length, 2);
    assertEquals(first['artist.id.mbid'], mbid);
    assertEquals(requests[0].item, {
      contract: 1,
      type: 'artist',
      id: artistId,
      name: 'Artist',
      ids: { mbid },
      albums: ['Album', 'Guests'],
    });
    await state.set('reference.order', 'b,a');
    const reordered = await reference.get(
      'artist',
      artistId,
      artistReferenceNames,
    );
    assertEquals(reordered['artist.biography']?.text, 'b & music');
    assertEquals(
      reordered['artist.url'],
      first['artist.url'],
      'selection is per fact, not per plugin',
    );
    await state.set('lookups.plugin.b.enabled', 'false');
    assertEquals(
      (await reference.get('artist', artistId, artistReferenceNames))[
        'artist.biography'
      ]?.text,
      'a & music',
    );
    await state.set('reference.maxListItems', '1');
    assertEquals(
      (await reference.get('artist', artistId, ['artist.similar']))[
        'artist.similar'
      ]?.length,
      1,
    );
    now += 25 * 3600000;
    blocked = Promise.withResolvers<void>();
    const beforeStale = requests.length;
    responses.set('a/artist', [found('updated')]);
    assertEquals(
      (await reference.get('artist', artistId, ['artist.biography']))[
        'artist.biography'
      ]?.text,
      'a & music',
      'stale data remains usable during refresh',
    );
    await eventually(() => requests.length === beforeStale + 1);
    await reference.refresh('artist', artistId);
    assertEquals(
      (await jobs()).filter((job) => job.state === 'active').length,
      1,
    );
    blocked.resolve();
    await idle();
    assertEquals(
      (await reference.get('artist', artistId, ['artist.biography']))[
        'artist.biography'
      ]?.text,
      'updated & music',
    );
    responses.set('a/artist', [{ values: {} }]);
    await reference.refresh('artist', artistId);
    await idle();
    assertEquals(
      await reference.get('artist', artistId, artistReferenceNames),
      {},
    );
    const negativeHits = requests.length;
    await reference.get('artist', artistId, artistReferenceNames);
    assertEquals(requests.length, negativeHits);
    const negative = (await store.reference.get('artist', artistId)).filter((
      fact,
    ) => fact.plugin === 'a');
    assertEquals(negative.length, artistReferenceNames.length);
    assert(
      negative.every((fact) => fact.value === null && fact.fetchedAtMs === now),
    );
    now += 25 * 3600000;
    responses.set('a/artist', [
      { retryAfter: 0.3, reason: 'busy' },
      found('retried'),
    ]);
    await reference.get('artist', artistId, artistReferenceNames);
    await eventually(async () =>
      (await jobs()).some((job) =>
        job.state === 'waiting' && job.last_error === 'busy'
      )
    );
    assertEquals(
      (await jobs()).find((job) => job.last_error === 'busy')?.attempts,
      0,
    );
    assertEquals(
      (await store.reference.get('artist', artistId)).filter((fact) =>
        fact.plugin === 'a'
      ),
      negative,
      'retry-later must not mark facts fresh',
    );
    await idle();
    assertEquals(
      (await reference.get('artist', artistId, ['artist.biography']))[
        'artist.biography'
      ]?.text,
      'retried & music',
    );
    assertEquals(
      (await jobs()).filter((job) => job.state === 'done').at(-1)?.attempts,
      1,
    );
    assertEquals(await reference.get('track', track.id, ['track.similar']), {});
    await idle();
    assertEquals(
      (await reference.get('track', track.id, ['track.similar']))[
        'track.similar'
      ],
      [{ title: 'Related', artist: 'Other', mbid: recording }],
    );
    assertEquals(requests.find((r) => r.type === 'track')?.item, {
      contract: 1,
      type: 'track',
      id: track.id,
      title: 'Track',
      artist: 'Artist',
      album: 'Album',
      durationMs: track.durationMs,
      ids: { mbid: recording, isrc: 'USAAA0100001' },
      artistIds: { mbid },
    });
    await reference.refresh('artist', await stableId('artist', 'Guest'));
    await idle();
    assertEquals(requests.at(-1)?.item.albums, []);
    const beforePlaceholders = (await jobs()).length;
    for (
      const id of [
        '',
        ...placeholders.map((artist) => artist.id),
        'missing',
      ]
    ) {
      assertEquals(await reference.get('artist', id, artistReferenceNames), {});
      await reference.refresh('artist', id);
    }
    assertEquals((await jobs()).length, beforePlaceholders);
    const unqualified = (await store.catalog.listSongs({ offset: 0, size: 10 }))
      .find((song) => song.title === 'Tagged')!;
    await reference.refresh('track', unqualified.id);
    assertEquals(
      (await jobs()).length,
      beforePlaceholders,
      'required track ids gate intake',
    );
    // Invalid Worker results become failed jobs and cannot replace good facts.
    const kept = await store.reference.get('artist', artistId);
    for (
      const values of [{ 'artist.url': { url: 'javascript:bad' } }, {
        'track.similar': [],
      }]
    ) {
      responses.set('a/artist', [{ values }]);
      await reference.refresh('artist', artistId);
      await idle();
      assertEquals(await store.reference.get('artist', artistId), kept);
    }
    assert((await jobs()).filter((job) => job.state === 'failed').length === 4);
    const bytes = await Deno.readFile(`${root}/artist.mp3`);
    const trackFacts = await store.reference.get('track', track.id);
    await Deno.rename(`${root}/track.flac`, `${root}/moved.flac`);
    await scan.run();
    await active.afterScan();
    assertEquals(await Deno.readFile(`${root}/artist.mp3`), bytes);
    assertEquals(
      await store.reference.get('artist', artistId),
      kept,
      'facts survive catalog rebuild',
    );
    assertEquals(
      (await store.catalog.getSong(track.id))?.path,
      `${root}/moved.flac`,
    );
    assertEquals(
      await store.reference.get('track', track.id),
      trackFacts,
      'track references retain identity after an external move',
    );
    assertEquals(await store.candidates.candidatesFor('artist', artistId), []);
    await runner!.close();
    await store.close();
    store = await openStore(`${dir}/data`);
    state = createState(store);
    scan = createScan(store, undefined, { notify });
    const restarted = await start();
    assertEquals(
      await store.reference.get('artist', artistId),
      kept,
      'startup housekeeping retains present identities',
    );
    assertEquals(
      (await restarted.reference.get('artist', artistId, ['artist.biography']))[
        'artist.biography'
      ]?.text,
      'retried & music',
    );
    await Deno.remove(`${root}/artist.mp3`);
    await Deno.remove(`${root}/moved.flac`);
    await Deno.remove(`${root}/guest.mp3`);
    await scan.run();
    await start(); // Same housekeeping path as the daily purge.
    assertEquals(await store.reference.get('artist', artistId), []);
    assertEquals(await store.reference.get('track', track.id), []);
  } finally {
    blocked.resolve();
    await runner?.close();
    await server.shutdown();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
