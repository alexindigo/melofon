import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { Buffer } from 'node:buffer';
import { Decoder, Demuxer } from 'node-av';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { createState } from '../src/state.ts';
import { createLibraries } from '../src/libraries.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibrary } from '../src/library.ts';
import { createArtwork } from '../src/artwork.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { createDecisions } from '../src/decisions.ts';
import { seedFirstUser } from '../src/users.ts';
import { createUserService } from '../src/user.ts';
import { facade } from '../src/facade.ts';
import { loadLayers } from '../src/layers.ts';
import { createLookupRunner } from '../src/lookups/runner.ts';
import { createLookupNetwork } from '../src/lookups/net.ts';
import { parseManifest } from '../src/lookups/manifest.ts';
import { parseResult } from '../src/lookups/host.ts';
import { candidateImagePath, writeCandidateImage } from '../src/images.ts';
import { resizeImage } from '../src/media.ts';
import { pictured } from './helpers/pictured.ts';
import { eventually, lookupManifest, lookupPlugin } from './helpers/lookup.ts';

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'artist-photos-' });
  const dataDir = `${dir}/data`, root = `${dir}/music`;
  await Deno.mkdir(root);
  const store = await openStore(dataDir);
  const state = createState(store), libraries = createLibraries(store);
  await libraries.add('Music', root);
  const library = createLibrary(store, undefined, { dataDir });
  const artwork = createArtwork(library, { state, dataDir });
  const cfg = {
    dataDir,
    user: 'admin',
    password: 'test',
    secret: 'g8',
    listen: undefined,
  };
  await seedFirstUser(store, cfg);
  const core = await pathfinder({
    roots: ['core/'],
    app: { store, cfg, state },
  });
  const layers = await loadLayers({
    app: {
      cfg,
      state,
      library,
      libraries,
      artwork,
      annotation: createAnnotation(store),
      listens: createListens(store),
      user: createUserService(store, cfg),
    },
  });
  const http = facade(core, layers);
  const ownTone = facade(core, layers, {
    listenPort: 3689,
    defaultPort: 4534,
    env: {},
  });
  const request = (op: string, params: Record<string, string> = {}) =>
    http(
      new Request(
        `http://x/rest/${op}?${new URLSearchParams({
          u: 'admin',
          p: 'test',
          v: '1.16.1',
          c: 'g8',
          f: 'json',
          ...params,
        })}`,
      ),
    );
  const fixture = await Deno.readFile(
    'tests/fixtures/library/Fixture Artist/Fixture Album/cover.jpg',
  );
  const photo = new Uint8Array(await resizeImage(fixture, 48, 32, 'jpeg', 90));
  const local = new Uint8Array(await resizeImage(fixture, 30, 20, 'jpeg', 90));
  const albumCover = new Uint8Array(
    await resizeImage(fixture, 18, 12, 'jpeg', 90),
  );
  return {
    dir,
    dataDir,
    root,
    store,
    state,
    libraries,
    library,
    request,
    ownTone,
    photo,
    local,
    albumCover,
    artist: async (name: string) =>
      (await Promise.all(
        (await library.artistIds()).map((id) => library.artistById(id)),
      )).find((a) => a?.name === name)!,
    cover: (id: string, size?: number) =>
      request('getCoverArt', { id, ...(size ? { size: String(size) } : {}) }),
    decisions: createDecisions(store, { dataDir }),
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}
async function dimensions(response: Response) {
  assertEquals(response.status, 200);
  const data = new Uint8Array(await response.arrayBuffer());
  await using input = await Demuxer.open(Buffer.from(data));
  const stream = input.video()!;
  await using decoder = await Decoder.create(stream);
  for await (const frame of decoder.frames(input.packets(stream.index))) {
    if (!frame) continue;
    try {
      return [frame.width, frame.height];
    } finally {
      frame.free();
    }
  }
  throw new Error('No decoded response photo');
}

Deno.test('artist folders follow exclusive album ownership across scan, libraries and moves; local photos reach HTTP consumers', async () => {
  const s = await setup();
  try {
    const add = (path: string, artist: string, album: string) =>
      pictured(path, undefined, { TPE2: artist, TALB: album });
    await add(`${s.root}/Solo/A/song.mp3`, 'Solo', 'A');
    await add(`${s.root}/Solo/B/song.mp3`, 'Solo', 'B');
    await add(`${s.root}/Shared/A/song.mp3`, 'Shared A', 'Shared A');
    await add(`${s.root}/Shared/B/song.mp3`, 'Shared B', 'Shared B');
    await add(`${s.root}/Span/A/song.mp3`, 'Span', 'Span A');
    await add(`${s.dir}/other/Span/B/song.mp3`, 'Span', 'Span B');
    await s.libraries.add('Other', `${s.dir}/other`);
    await add(`${s.root}/root.mp3`, 'Root', 'Root');
    await add(`${s.root}/Single/Only/song.mp3`, 'Single', 'Only');
    await pictured(`${s.root}/Unknown/song.mp3`, undefined, {
      TPE2: '',
      TALB: 'Unknown',
    });
    await Deno.writeFile(`${s.root}/Solo/ARTIST.JPEG`, s.photo);
    await Deno.writeFile(`${s.root}/Solo/artist.jpg`, s.local);
    await Deno.writeFile(`${s.root}/Solo/A/cover.jpg`, s.albumCover);
    await scanLibrary(s.store);
    const solo = await s.artist('Solo');
    const libraryId = (await s.store.catalog.listLibraries()).find((l) =>
      l.path === s.root
    )!.id;
    assertEquals(await s.library.artistFolder(solo.id), {
      directory: `${s.root}/Solo`,
      libraryId,
    });
    assertEquals(
      (await s.library.artistFolder((await s.artist('Single')).id))?.directory,
      `${s.root}/Single`,
    );
    for (const name of ['Shared A', 'Shared B', 'Span', 'Root']) {
      assertEquals(
        await s.library.artistFolder((await s.artist(name)).id),
        null,
      );
    }
    const artistsBody =
      (await (await s.request('getArtists')).json())['subsonic-response'];
    const placeholder = artistsBody.artists.index.flatMap((
      i: { artist: { id: string; name: string }[] },
    ) => i.artist).find((a: { name: string }) => a.name === '[Unknown Artist]');
    assert(placeholder);
    assertEquals(await s.library.artistFolder(placeholder.id), null);
    assertEquals(await dimensions(await s.cover(solo.id)), [30, 20]);
    assertEquals(await dimensions(await s.cover(solo.id, 15)), [15, 10]);
    const cached = await s.cover(solo.id, 15);
    assertEquals(cached.headers.get('x-artwork-cache'), 'hit');
    await cached.body?.cancel();
    const conflicts = await s.store.candidates.candidatesFor('artist', solo.id);
    assertEquals(conflicts.length, 2);
    assert(
      conflicts.every((c) => c.source === 'local' && c.confidence === null),
    );
    // Ignoring the conflict preserves the extension-ordered local picture.
    assertEquals(await dimensions(await s.cover(solo.id)), [30, 20]);
    await Deno.remove(`${s.root}/Solo/ARTIST.JPEG`);
    await scanLibrary(s.store);
    assertEquals(await s.store.candidates.candidatesFor('artist', solo.id), []);
    // Artist photos never replace the album/OwnTone group artwork.
    const albums =
      await (await s.ownTone(new Request('http://x/api/library/albums')))
        .json();
    const album = albums.items.find((a: { name: string }) => a.name === 'A');
    assert(album?.artwork_url);
    assertEquals(
      await dimensions(
        await s.ownTone(new Request(new URL(album.artwork_url, 'http://x/'))),
      ),
      [18, 12],
    );
    await Deno.rename(`${s.root}/Solo`, `${s.root}/Moved`);
    await scanLibrary(s.store);
    assertEquals(
      (await s.library.artistFolder(solo.id))?.directory,
      `${s.root}/Moved`,
    );
    assertEquals(await dimensions(await s.cover(solo.id)), [30, 20]);
    // Introducing another album owner beneath the same folder revokes it.
    await add(`${s.root}/Moved/Intruder/song.mp3`, 'Intruder', 'Intruder');
    await scanLibrary(s.store);
    assertEquals(await s.library.artistFolder(solo.id), null);
    assertEquals(await dimensions(await s.cover(solo.id)), [18, 12]);
  } finally {
    await s.close();
  }
});

Deno.test('artist photo Worker candidates, missing intake, decisions and backups reach HTTP; read-only/no-folder choices persist in data', async () => {
  const s = await setup();
  let runner: Awaited<ReturnType<typeof createLookupRunner>> | undefined;
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    (request) => {
      const bad = new URL(request.url).pathname === '/bad';
      return new Response(
        (bad
          ? new TextEncoder().encode('not an image')
          : s.photo) as Uint8Array<ArrayBuffer>,
        { headers: { 'content-type': 'image/jpeg' } },
      );
    },
  );
  const pluginRoot = `${s.dir}/lookups`;
  try {
    const names = [
      'Online',
      'Medium',
      'Local',
      'Readonly',
      'Shared A',
      'Shared B',
      'Bad',
    ];
    for (const name of names) {
      const folder = name.startsWith('Shared')
        ? `Shared/${name}`
        : `${name}/Album`;
      const root = name === 'Readonly' ? `${s.dir}/readonly` : s.root;
      await pictured(`${root}/${folder}/song.mp3`, undefined, {
        TALB: name,
        TPE2: name,
        ...(name === 'Online' ? { TPE1: 'Performer' } : {}),
      });
      await Deno.writeFile(`${root}/${folder}/cover.jpg`, s.albumCover);
    }
    const readonly = `${s.dir}/readonly`;
    await s.libraries.add('Read only', readonly);
    await pictured(`${s.root}/Unknown/song.mp3`, undefined, {
      TPE2: '',
      TALB: 'Unknown',
    });
    await Deno.writeFile(`${s.root}/Local/artist.jpg`, s.local);
    await Deno.writeFile(
      `${s.root}/Local/artist.png`,
      new Uint8Array(await resizeImage(s.albumCover, 18, 12, 'png', 90)),
    );
    await Deno.chmod(readonly, 0o555);
    const capability = {
      id: 'photo',
      accepts: 'artist',
      provides: ['artist.image.primary'],
      requires: [],
    };
    const manifest = lookupManifest({ capabilities: [capability] });
    const parsed = parseManifest(manifest, 'fixture').capabilities[0];
    const proposal = {
      target: { type: 'artist', id: 'a' },
      confidence: 'strong',
      values: { 'artist.image.primary': { url: 'https://fixture.test/image' } },
    } as const;
    assertEquals(parseResult({ candidates: [proposal] }, parsed), {
      candidates: [proposal],
    });
    assertThrows(() =>
      parseResult({
        candidates: [{ ...proposal, target: { type: 'album', id: 'a' } }],
      }, parsed)
    );
    assertThrows(() =>
      parseResult({ values: { 'artist.image.primary': {} } }, parsed)
    );
    assertThrows(() =>
      parseResult({
        candidates: [{
          ...proposal,
          values: {
            'album.image.front': { url: 'https://fixture.test/image' },
          },
        }],
      }, parsed)
    );
    await lookupPlugin(
      pluginRoot,
      `export default { photo(item) {
      return {candidates:[{target:{type:'artist',id:item.id},confidence:item.name === 'Medium' ? 'medium' : 'strong',values:{'artist.image.primary':{url:'https://fixture.test/' + (item.name === 'Bad' ? 'bad' : 'image')}},evidence:{name:item.name,albums:item.albums}}]};
    } };`,
      'fixture',
      manifest,
    );
    await s.state.set('lookups.plugin.fixture.hosts', 'fixture.test');
    await s.state.set('lookups.maxAttempts', '1');
    runner = await createLookupRunner({
      store: s.store,
      state: s.state,
      dataDir: s.dataDir,
      builtin: pluginRoot,
      network: createLookupNetwork({
        fixtures: { 'fixture.test': `http://127.0.0.1:${server.addr.port}` },
      }),
    });
    await scanLibrary(s.store);
    await runner.afterScan();
    await eventually(async () => {
      const stats = await s.store.lookups.stats('fixture');
      return stats.done === 6 && stats.failed === 1;
    });
    const queued = await rawSql(s.store).all<
      { entity_id: string; entity_type: string }
    >('SELECT entity_id, entity_type FROM lookup_jobs');
    assertEquals(queued.length, 7);
    assert(queued.every((job) => job.entity_type === 'artist'));
    assertEquals(
      queued.map((job) => job.entity_id).sort(),
      (await Promise.all(
        [...names.filter((name) => name !== 'Local'), 'Performer'].map(async (
          name,
        ) => (await s.artist(name)).id),
      )).sort(),
    );
    const online = await s.artist('Online'),
      medium = await s.artist('Medium'),
      local = await s.artist('Local');
    assert(!queued.some((job) => job.entity_id === local.id));
    assertEquals(await dimensions(await s.cover(online.id)), [48, 32]);
    assertEquals(await dimensions(await s.cover(medium.id)), [18, 12]);
    assertEquals(await dimensions(await s.cover(local.id)), [30, 20]);
    const performer = await s.artist('Performer');
    assertEquals(await s.library.artistFolder(performer.id), null);
    assertEquals(await dimensions(await s.cover(performer.id)), [48, 32]);
    assertEquals(
      await s.store.candidates.candidatesFor(
        'artist',
        (await s.artist('Bad')).id,
      ),
      [],
    );
    const [chosen] = await s.store.candidates.candidatesFor(
      'artist',
      online.id,
    );
    assertEquals(chosen.libraryId, null);
    assertEquals(chosen.details.name, 'Online');
    assertEquals(
      await Deno.readFile(
        candidateImagePath(
          { path: s.dataDir },
          chosen.imageHash,
          chosen.imageExt,
        ),
      ),
      s.photo,
    );
    // Reject is remembered when explicit intake sees the same source/hash again.
    await s.decisions.reject(chosen.id);
    assertEquals(await dimensions(await s.cover(online.id)), [18, 12]);
    await runner.request({ type: 'artist', id: online.id }, 'all');
    await eventually(async () =>
      (await s.store.lookups.stats('fixture')).done === 7
    );
    assertEquals(
      (await s.store.candidates.candidatesFor('artist', online.id)).length,
      1,
    );
    assertEquals(await dimensions(await s.cover(online.id)), [18, 12]);
    // Existing accept semantics permit choosing a previously rejected proposal.
    await s.decisions.accept(chosen.id);
    await eventually(async () =>
      (await s.store.lookups.stats('core.unify')).done === 1
    );
    assertEquals(await Deno.readFile(`${s.root}/Online/artist.jpg`), s.photo);
    assertEquals(await dimensions(await s.cover(online.id)), [48, 32]);
    // Explicit requests bypass missing mode; replacement archives old local bytes.
    await runner.request({ type: 'artist', id: local.id }, 'all');
    await eventually(async () =>
      (await s.store.lookups.stats('fixture')).done === 8
    );
    const replacement =
      (await s.store.candidates.candidatesFor('artist', local.id)).find((c) =>
        c.source === 'fixture'
      )!;
    assertEquals(await dimensions(await s.cover(local.id)), [30, 20]);
    await s.decisions.accept(replacement.id);
    await eventually(async () =>
      (await s.store.lookups.stats('core.unify')).done === 2
    );
    const backup = (await s.store.candidates.candidatesFor('artist', local.id))
      .find((c) => c.source === 'local')!;
    assert(backup.details.preserved);
    assertEquals(
      await Deno.readFile(
        candidateImagePath(
          { path: s.dataDir },
          backup.imageHash,
          backup.imageExt,
        ),
      ),
      s.local,
    );
    assertEquals(await dimensions(await s.cover(local.id)), [48, 32]);
    await assertRejects(
      () => Deno.stat(`${s.root}/Local/artist.png`),
      Deno.errors.NotFound,
    );
    await s.decisions.accept(backup.id);
    await eventually(async () =>
      (await s.store.lookups.stats('core.unify')).done === 3
    );
    assertEquals(await dimensions(await s.cover(local.id)), [30, 20]);
    for (const name of ['Readonly', 'Shared A']) {
      const artist = await s.artist(name);
      const [candidate] = await s.store.candidates.candidatesFor(
        'artist',
        artist.id,
      );
      await s.decisions.accept(candidate.id);
    }
    await eventually(async () =>
      (await s.store.lookups.stats('core.unify')).done === 5
    );
    assertEquals(
      await dimensions(await s.cover((await s.artist('Readonly')).id)),
      [48, 32],
    );
    assertEquals(
      await dimensions(await s.cover((await s.artist('Shared A')).id)),
      [48, 32],
    );
    const alternative =
      (await writeCandidateImage({ path: s.dataDir }, s.local, 'jpg'))!;
    await s.store.candidates.addCandidates([{
      entityType: 'artist',
      entityId: (await s.artist('Readonly')).id,
      kind: 'cover',
      source: 'another-photo-plugin',
      confidence: 'strong',
      imageHash: alternative.hash,
      imageExt: alternative.ext,
      libraryId: null,
      origin: 'fixture',
      foundAtMs: Date.now() + 1000,
    }]);
    assertEquals(
      await dimensions(await s.cover((await s.artist('Readonly')).id)),
      [48, 32],
    );
    await assertRejects(
      () => Deno.stat(`${readonly}/Readonly/artist.jpg`),
      Deno.errors.NotFound,
    );
    await assertRejects(
      () => Deno.stat(`${readonly}/.melofon`),
      Deno.errors.NotFound,
    );
    await assertRejects(
      () => Deno.stat(`${s.root}/Shared/artist.jpg`),
      Deno.errors.NotFound,
    );
    // Changed facts defeat job dedup: accepted data-dir photos must still skip,
    // while a medium open candidate remains missing and queues new work.
    await pictured(`${s.root}/Shared/Shared A/song.mp3`, undefined, {
      TPE2: 'Shared A',
      TALB: 'Changed shared',
    });
    await pictured(`${s.root}/Medium/Album/song.mp3`, undefined, {
      TPE2: 'Medium',
      TALB: 'Changed medium',
    });
    await scanLibrary(s.store);
    const before = (await s.store.lookups.stats('fixture')).done;
    await runner.afterScan();
    await eventually(async () =>
      (await s.store.lookups.stats('fixture')).done === before + 1
    );
    const sharedJobs = await rawSql(s.store).all<{ n: number }>(
      `SELECT count(*) AS n FROM lookup_jobs WHERE plugin = 'fixture' AND entity_id = '${
        (await s.artist('Shared A')).id
      }'`,
    );
    assertEquals(Number(sharedJobs[0].n), 1);
    await eventually(async () => {
      const stats = await s.store.lookups.stats('fixture');
      return stats.active === 0 && stats.waiting === 0;
    });
    await runner.close();
    runner = undefined;
    await scanLibrary(s.store);
    assertEquals(
      await s.library.artistPhotoMissing((await s.artist('Readonly')).id),
      false,
    );
    const readonlyId = (await s.artist('Readonly')).id;
    await s.store.close();
    const reopened = await openStore(s.dataDir);
    try {
      const artwork = createArtwork(
        createLibrary(reopened, undefined, { dataDir: s.dataDir }),
      );
      assertEquals(await dimensions(await artwork.cover(readonlyId)), [48, 32]);
    } finally {
      await reopened.close();
    }
  } finally {
    await runner?.close();
    await server.shutdown();
    await Deno.chmod(`${s.dir}/readonly`, 0o755).catch(() => {});
    await s.close();
  }
});

Deno.test('artist photo upgrade preserves pre-g8 candidate decisions and sequences through reopen', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'artist-photo-upgrade-' });
  let store = await openStore(dir);
  let verified = false;
  try {
    const schema = await Deno.readTextFile('src/store/schema.sql');
    const definition = schema.split(';').find((sql) =>
      /CREATE TABLE IF NOT EXISTS candidates\s*\(/.test(sql)
    )!;
    await rawSql(store).run('DROP TABLE candidates');
    await rawSql(store).run(
      definition.replace('library_id VARCHAR,', 'library_id VARCHAR NOT NULL,'),
    );
    const [old] = await store.candidates.addCandidates([{
      entityType: 'album',
      entityId: 'old',
      kind: 'cover',
      source: 'fixture',
      confidence: 'strong',
      imageHash: 'old',
      imageExt: 'jpg',
      libraryId: 'lib',
      origin: 'old',
      details: { retained: true },
    }]);
    await store.candidates.setState(old.id, 'rejected');
    await store.close();
    store = await openStore(dir);
    assertEquals((await store.candidates.byId(old.id))?.state, 'rejected');
    const [photo] = await store.candidates.addCandidates([{
      ...old,
      entityType: 'artist',
      entityId: 'artist',
      libraryId: null,
      imageHash: 'photo',
    }]);
    assertEquals(photo.libraryId, null);
    const beforeReopen = await rawSql(store).all(
      'SELECT * FROM candidates ORDER BY seq',
    );
    await store.close();
    store = await openStore(dir);
    assertEquals(
      await rawSql(store).all('SELECT * FROM candidates ORDER BY seq'),
      beforeReopen,
      `Retained database evidence: ${dir}`,
    );
    assertEquals((await store.candidates.byId(old.id))?.details, {
      retained: true,
    });
    assertEquals((await store.candidates.byId(photo.id))?.libraryId, null);
    const sequences = await rawSql(store).all<{ seq: number }>(
      'SELECT seq FROM candidates ORDER BY seq',
    );
    assertEquals(sequences.length, 2);
    assert(Number(sequences[1].seq) > Number(sequences[0].seq));
    verified = true;
  } finally {
    await store.close();
    if (verified) await Deno.remove(dir, { recursive: true });
  }
});
