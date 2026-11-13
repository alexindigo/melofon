import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore, type Store } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { createState, type State } from '../src/state.ts';
import { createLibraries } from '../src/libraries.ts';
import { createNotify } from '../src/notify.ts';
import { createScan } from '../src/scan.ts';
import { createLibrary } from '../src/library.ts';
import { createArtwork } from '../src/artwork.ts';
import {
  albumFacts,
  createLookupRunner,
  factsHash,
} from '../src/lookups/runner.ts';
import { createLookupNetwork } from '../src/lookups/net.ts';
import { discoverLookups } from '../src/lookups/manifest.ts';
import { candidateImagePath, imageHash } from '../src/images.ts';
import { eventually, lookupPlugin } from './helpers/lookup.ts';
import { pictured } from './helpers/pictured.ts';

const code =
  `const counts = new Map(); export default { async cover(item, ctx) {
  const count = (counts.get(item.id) ?? 0) + 1; counts.set(item.id,count);
  if (ctx.settings.behavior === 'error') throw Error('fixture failure');
  if (ctx.settings.behavior === 'empty') return { candidates: [] };
  if (ctx.settings.behavior === 'retry' && count === 1) return {retryAfter:0.2,reason:'busy'};
  await ctx.fetch('https://fixture.test/search');
  return {candidates:[{target:{type:'album',id:item.id},confidence:'strong',values:{'album.image.front':{url:'https://fixture.test/image'}},evidence:{name:item.name,artist:item.albumArtist,tracks:item.tracks.length,count,behavior:ctx.settings.behavior}}]};
} };`;
type Runner = Awaited<ReturnType<typeof createLookupRunner>>;
async function setup(
  fn: (
    s: {
      store: Store;
      state: State;
      root: string;
      dir: string;
      image: Uint8Array;
      scan: ReturnType<typeof createScan>;
      notify: ReturnType<typeof createNotify>;
      start: () => Promise<Runner>;
      hits: string[];
      onImage: (fn: () => Promise<void>) => void;
    },
  ) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  const root = `${dir}/music`;
  await Deno.mkdir(root);
  const store = await openStore(`${dir}/data`);
  const state = createState(store);
  const notify = createNotify();
  const scan = createScan(store, undefined, { notify });
  const hits: string[] = [];
  const image = await Deno.readFile(
    'tests/fixtures/library/Fixture Artist/Fixture Album/cover.jpg',
  );
  let beforeImage: (() => Promise<void>) | undefined;
  const server = Deno.serve(
    { port: 0, hostname: '127.0.0.1', onListen() {} },
    async (request) => {
      const path = new URL(request.url).pathname;
      hits.push(path);
      if (path === '/image') await beforeImage?.();
      return path === '/image'
        ? new Response(image, { headers: { 'content-type': 'image/jpeg' } })
        : Response.json({ ok: true });
    },
  );
  let runner: Runner | undefined;
  const network = createLookupNetwork({
    fixtures: { 'fixture.test': `http://127.0.0.1:${server.addr.port}` },
  });
  try {
    await createLibraries(store).add('Music', root);
    await lookupPlugin(`${dir}/lookups`, code);
    await state.set('lookups.plugin.fixture.hosts', 'fixture.test');
    await fn({
      store,
      state,
      root,
      dir,
      image,
      scan,
      notify,
      hits,
      onImage(fn) {
        beforeImage = fn;
      },
      start: async () => {
        await runner?.close();
        runner = await createLookupRunner({
          store,
          state,
          dataDir: `${dir}/data`,
          builtin: `${dir}/lookups`,
          notify,
          network,
        });
        return runner;
      },
    });
  } finally {
    await runner?.close();
    await server.shutdown();
    await store.close();
    await Deno.chmod(root, 0o755);
    await Deno.remove(dir, { recursive: true });
  }
}
const albums = (store: Store) =>
  store.catalog.listAlbums({ sort: 'name', size: 100, offset: 0 });
const stats = (store: Store) => store.lookups.stats('fixture');

Deno.test('successful scans fan out only missing covers, checking every track and read-only libraries', async () => {
  await setup(async ({ store, state, root, dir, image, scan, start }) => {
    await pictured(`${root}/Missing/song.mp3`, undefined, { TALB: 'Missing' });
    await pictured(`${root}/Covered/song.mp3`, undefined, { TALB: 'Covered' });
    await Deno.writeFile(`${root}/Covered/COVER.PNG`, image);
    await pictured(`${root}/Embedded/a.mp3`, undefined, {
      TALB: 'Embedded',
      TRCK: '1',
    });
    await pictured(`${root}/Embedded/b.mp3`, image, {
      TALB: 'Embedded',
      TRCK: '2',
    });
    const readonly = `${dir}/readonly`;
    await pictured(`${readonly}/Album/song.mp3`);
    await createLibraries(store).add('Read only', readonly);
    await Deno.chmod(readonly, 0o555);
    await lookupPlugin(`${dir}/lookups`, undefined, 'disabled');
    await state.set('lookups.plugin.disabled.enabled', 'false');
    await start();
    try {
      await scan.run();
      await eventually(async () => (await stats(store)).done === 1);
      assertEquals(
        (await rawSql(store).all<{ entity_id: string }>(
          'SELECT entity_id FROM lookup_jobs',
        )).map((j) => j.entity_id),
        [(await albums(store)).find((a) => a.name === 'Missing')!.id],
      );
      assertEquals(await store.lookups.stats('disabled'), {
        waiting: 0,
        active: 0,
        done: 0,
        failed: 0,
      });
      await assertRejects(
        () => Deno.stat(`${readonly}/.melofon`),
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.chmod(readonly, 0o755);
    }
  });
});
Deno.test('runner dedupes identical facts, queues changed facts and supports explicit album/song/library all requests', async () => {
  await setup(async ({ store, root, scan, start }) => {
    const path = `${root}/Album/song.mp3`;
    await pictured(path);
    const runner = await start();
    await scan.run();
    await eventually(async () => (await stats(store)).done === 1);
    await runner.afterScan();
    await runner.afterScan();
    assertEquals((await stats(store)).done, 1);
    await pictured(path, undefined, { TALB: 'Changed' });
    await scan.run();
    await eventually(async () => (await stats(store)).done === 2);
    const album = (await albums(store))[0];
    const song = (await store.catalog.getAlbum(album.id))!.songs[0];
    for (
      const target of [{ type: 'album' as const, id: album.id }, {
        type: 'song' as const,
        id: song.id,
      }, { type: 'library' as const, id: song.libraryId! }]
    ) {
      const before = (await stats(store)).done;
      await runner.request(target, 'all');
      await eventually(async () => (await stats(store)).done === before + 1);
    }
    assertEquals((await stats(store)).done, 5);
  });
});
Deno.test('runner downloads images through approved RPC networking; artwork consumer sees shared hash bytes', async () => {
  await setup(async ({ store, root, scan, start, image, hits, notify }) => {
    await pictured(`${root}/A/song.mp3`, undefined, { TALB: 'A' });
    await pictured(`${root}/B/song.mp3`, undefined, { TALB: 'B' });
    await scan.run();
    const artworkChanges: string[][] = [];
    notify.subscribe((types) => {
      if (types.includes('library')) artworkChanges.push(types);
    });
    const runner = await start();
    await runner.afterScan();
    await eventually(async () => (await stats(store)).done === 2);
    assertEquals(artworkChanges, [['library'], ['library']]);
    const artwork = createArtwork(createLibrary(store));
    for (const album of await albums(store)) {
      const [candidate] = await store.candidates.candidatesFor(
        'album',
        album.id,
      );
      assertEquals(candidate.imageHash, await imageHash(image));
      assertEquals(candidate.details.name, album.name);
      assertEquals(candidate.details.tracks, 1);
      assertEquals(
        new Uint8Array(await (await artwork.cover(album.id)).arrayBuffer()),
        image,
      );
      assertEquals(
        await Deno.readFile(
          candidateImagePath(
            { path: root },
            candidate.imageHash,
            candidate.imageExt,
          ),
        ),
        image,
      );
    }
    assertEquals(
      [...Deno.readDirSync(`${root}/.melofon/candidates`)].length,
      1,
    );
    assertEquals(hits.filter((p) => p === '/search').length, 2);
    assertEquals(hits.filter((p) => p === '/image').length, 2);
  });
});
Deno.test('runner drops an unwritable candidate image and completes without a broken reference', async () => {
  await setup(async ({ store, root, scan, start, onImage }) => {
    await pictured(`${root}/Album/song.mp3`);
    const destination = `${root}/.melofon/candidates`;
    onImage(() => Deno.chmod(destination, 0o555));
    await start();
    try {
      await scan.run();
      await eventually(async () => (await stats(store)).done === 1);
      assertEquals(
        await store.candidates.candidatesFor(
          'album',
          (await albums(store))[0].id,
        ),
        [],
      );
      assertEquals([...Deno.readDirSync(destination)], []);
    } finally {
      await Deno.chmod(destination, 0o755);
    }
  });
});
Deno.test('retry-later persists not-before without counting an attempt and then finishes normally', async () => {
  await setup(async ({ store, state, root, scan, start }) => {
    await state.set('lookups.plugin.fixture.settings.behavior', 'retry');
    await pictured(`${root}/Album/song.mp3`);
    await start();
    await scan.run();
    await eventually(async () =>
      (await rawSql(store).all<{ state: string; last_error: string }>(
        'SELECT state,last_error FROM lookup_jobs',
      )).some((j) => j.state === 'waiting' && j.last_error === 'busy')
    );
    const [waiting] = await rawSql(store).all<
      { attempts: number; not_before: number; last_error: string }
    >('SELECT attempts, epoch_ms(not_before) AS not_before, last_error FROM lookup_jobs');
    assertEquals(waiting.attempts, 0);
    assertEquals(waiting.last_error, 'busy');
    assert(Number(waiting.not_before) > Date.now());
    await eventually(async () => (await stats(store)).done === 1);
    const [job] = await rawSql(store).all<{ attempts: number }>(
      'SELECT attempts FROM lookup_jobs',
    );
    assertEquals(job.attempts, 1);
    const [candidate] = await store.candidates.candidatesFor(
      'album',
      (await albums(store))[0].id,
    );
    assertEquals(candidate.details.count, 2);
  });
});
Deno.test('runner errors count attempts, honor backoff and maxAttempts, and live settings change future work', async () => {
  await setup(async ({ store, state, root, scan, start }) => {
    await state.set('lookups.maxAttempts', '2');
    await state.set('lookups.retryDelaysSeconds', '1');
    await state.set('lookups.plugin.fixture.settings.behavior', 'error');
    await pictured(`${root}/Album/song.mp3`);
    const runner = await start();
    await scan.run();
    await eventually(async () =>
      (await rawSql(store).all<{ state: string; last_error: string }>(
        'SELECT state,last_error FROM lookup_jobs',
      )).some((j) =>
        j.state === 'waiting' && j.last_error?.includes('fixture failure')
      )
    );
    let [job] = await rawSql(store).all<
      { attempts: number; last_error: string }
    >('SELECT attempts,last_error FROM lookup_jobs');
    assertEquals(job.attempts, 1);
    await new Promise((r) => setTimeout(r, 200));
    assertEquals((await stats(store)).failed, 0);
    await eventually(async () => (await stats(store)).failed === 1);
    [job] = await rawSql(store).all(
      'SELECT attempts,last_error FROM lookup_jobs',
    );
    assertEquals(job.attempts, 2);
    assert(job.last_error.includes('fixture failure'));
    await state.set('lookups.plugin.fixture.settings.behavior', 'found');
    await runner.request(
      { type: 'album', id: (await albums(store))[0].id },
      'all',
    );
    await eventually(async () => (await stats(store)).done === 1);
    assertEquals(
      (await store.candidates.candidatesFor(
        'album',
        (await albums(store))[0].id,
      ))[0].details.behavior,
      'found',
    );
    await assertRejects(() => state.set('lookups.jobTimeoutSeconds', '4'));
    await assertRejects(() => state.set('lookups.maxAttempts', '0'));
    await assertRejects(() => state.set('lookups.imageMaxMegabytes', '201'));
    await assertRejects(() => state.set('lookups.doneRetentionDays', '0'));
    await assertRejects(() => state.set('lookups.retryDelaysSeconds', '-1'));
  });
});
Deno.test('runner resumes an active job after simulated restart and purges only expired done jobs', async () => {
  await setup(async ({ store, state, root, dir, scan, start }) => {
    await pictured(`${root}/Album/song.mp3`);
    await scan.run();
    const facts = (await albumFacts(store, (await albums(store))[0].id))!;
    const capability =
      (await discoverLookups(`${dir}/lookups`, `${dir}/data`))[0].manifest!
        .capabilities[0];
    await store.lookups.enqueue([{
      plugin: 'fixture',
      entityType: 'album',
      entityId: facts.id,
      factsHash: await factsHash(capability, facts),
      mode: 'missing',
    }]);
    const active = await store.lookups.claimNext('fixture');
    assert(active);
    await store.lookups.enqueue([{
      plugin: 'fixture',
      entityType: 'album',
      entityId: 'old',
      factsHash: 'old',
      mode: 'missing',
    }]);
    const old = (await store.lookups.claimNext('fixture'))!;
    await store.lookups.finish(old.id, { state: 'done' });
    await rawSql(store).run(
      `UPDATE lookup_jobs SET finished_at=now()-INTERVAL '40 days' WHERE entity_id='old'`,
    );
    await state.set('lookups.doneRetentionDays', '30');
    await start();
    await eventually(async () => (await stats(store)).done === 1);
    const jobs = await rawSql(store).all<{ id: string; attempts: number }>(
      'SELECT id,attempts FROM lookup_jobs',
    );
    assertEquals(jobs.length, 1);
    assertEquals([jobs[0].id, jobs[0].attempts], [active.id, 2]);
  });
});
Deno.test('empty grants fail closed; approval and enable changes take effect without recreating runner', async () => {
  await setup(async ({ store, state, root, scan, start, hits }) => {
    await state.set('lookups.plugin.fixture.hosts', '');
    await state.set('lookups.maxAttempts', '1');
    await pictured(`${root}/Album/song.mp3`);
    const runner = await start();
    await scan.run();
    await eventually(async () => (await stats(store)).failed === 1);
    assertEquals(hits, []);
    await state.set('lookups.plugin.fixture.enabled', 'false');
    await runner.request(
      { type: 'album', id: (await albums(store))[0].id },
      'all',
    );
    assertEquals((await stats(store)).waiting, 0);
    await state.set('lookups.plugin.fixture.hosts', 'fixture.test');
    await state.set('lookups.plugin.fixture.enabled', 'true');
    await runner.request(
      { type: 'album', id: (await albums(store))[0].id },
      'all',
    );
    await eventually(async () => (await stats(store)).done === 1);
    assert(hits.includes('/image'));
  });
});
