import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { openStore } from '../src/store/index.ts';
import { createState } from '../src/state.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createNotify } from '../src/notify.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLookupRunner } from '../src/lookups/runner.ts';
import { createLookupNetwork } from '../src/lookups/net.ts';
import { imageHash } from '../src/images.ts';
import { rawSql } from '../src/store/testing.ts';
import { eventually } from './helpers/lookup.ts';
import { lyricMp3 } from './helpers/lyrics.ts';
import { lookupLyrics, lyricsLookupPlugin } from './helpers/lyrics-lookup.ts';

async function setup(requires: string[] = []) {
  const dir = await Deno.makeTempDir({ prefix: 'lyrics-runner-' });
  const root = `${dir}/music`,
    dataDir = `${dir}/data`,
    builtin = `${dir}/lookups`;
  await Deno.mkdir(root);
  const store = await openStore(dataDir);
  const state = createState(store);
  const notify = createNotify();
  const libraries = createLibraries(store);
  const libraryId = (await libraries.add('Music', root)).id;
  await lyricsLookupPlugin(builtin, 'lyrics-fixture', requires);
  await state.set('lookups.maxAttempts', '1');
  let runner: Awaited<ReturnType<typeof createLookupRunner>> | undefined;
  return {
    dir,
    root,
    dataDir,
    store,
    state,
    libraries,
    libraryId,
    notify,
    library: createLibrary(store),
    async start(network?: ReturnType<typeof createLookupNetwork>) {
      runner = await createLookupRunner({
        store,
        state,
        dataDir,
        builtin,
        network,
        notify,
      });
      return runner;
    },
    stats: () => store.lookups.stats('lyrics-fixture'),
    candidates: (id: string) => store.candidates.candidatesFor('song', id),
    async song(tags: Record<string, string> = {}) {
      await lyricMp3(`${root}/song.mp3`, [], tags);
      await scanLibrary(store);
      return (await store.catalog.listSongs({ offset: 0, size: 100 }))[0];
    },
    async close() {
      await runner?.close();
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('lyrics runner: discovered song jobs persist whole variants, provenance and decisions across rescans and reopen without media writes', async () => {
  const f = await setup();
  try {
    const song = await f.song();
    const before = await Deno.readFile(song.path);
    const runner = await f.start();
    const artworkChanges: string[][] = [];
    f.notify.subscribe((types) => {
      if (types.includes('library')) artworkChanges.push(types);
    });
    const [plugin] = await runner.list();
    assertEquals(plugin.id, 'lyrics-fixture');
    assertEquals(plugin.capabilities[0].provides, ['track.lyrics']);
    await runner.request({ type: 'song', id: song.id }, 'all');
    await eventually(async () => (await f.stats()).done === 1);
    const [candidate] = await f.candidates(song.id);
    assertEquals(candidate.entityType, 'song');
    assertEquals(candidate.entityId, song.id);
    assertEquals(candidate.kind, 'lyrics');
    assertEquals(candidate.source, 'lyrics-fixture');
    assertEquals(candidate.confidence, 'strong');
    assertEquals(candidate.state, 'open');
    assertEquals(candidate.libraryId, f.libraryId);
    assertEquals(candidate.origin, 'https://provenance.invalid/song');
    assertEquals(candidate.imageExt, 'lyrics');
    assertEquals(candidate.details.lyrics, {
      origin: candidate.origin,
      entries: lookupLyrics,
    });
    assertEquals(candidate.details.ids, { fixture: 'external-song' });
    assertEquals(
      artworkChanges,
      [],
      'lyrics acquisition does not refresh artwork',
    );
    assertEquals(await f.library.lyricsBySongId(song.id), lookupLyrics);
    assertEquals(
      candidate.imageHash,
      await imageHash(new TextEncoder().encode(JSON.stringify(lookupLyrics))),
    );
    const facts = candidate.details.facts as Record<string, unknown>;
    assertEquals(facts.type, 'track');
    assertEquals(facts.title, song.title);
    assertEquals(facts.artist, song.artistName);
    assertEquals(facts.album, song.albumName);
    assertEquals(facts.durationMs, song.durationMs);
    assert(!JSON.stringify(facts).includes(f.root));
    await f.store.candidates.setState(candidate.id, 'rejected');
    await runner.request({ type: 'song', id: song.id }, 'all');
    await eventually(async () => (await f.stats()).done === 2);
    assertEquals((await f.candidates(song.id)).map((c) => [c.id, c.state]), [[
      candidate.id,
      'rejected',
    ]]);
    // Same words with different timing are a distinct complete proposal.
    await f.state.set('lookups.plugin.lyrics-fixture.settings.shift', '1');
    await runner.request({ type: 'song', id: song.id }, 'all');
    await eventually(async () => (await f.stats()).done === 3);
    const candidates = await f.candidates(song.id);
    assertEquals(candidates.length, 2);
    assertNotEquals(candidates[1].imageHash, candidate.imageHash);
    await scanLibrary(f.store);
    assertEquals(await f.candidates(song.id), candidates);
    assertEquals(await Deno.readFile(song.path), before);
    assertEquals([...Deno.readDirSync(f.root)].map((e) => e.name), [
      'song.mp3',
    ]);
    await runner.close();
    await f.store.close();
    const reopened = await openStore(f.dataDir);
    try {
      assertEquals(
        await reopened.candidates.candidatesFor('song', song.id),
        candidates,
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

Deno.test('lyrics runner: explicit song, album and library scopes acquire only their tracks; absent and artist targets do not fan out', async () => {
  const f = await setup();
  try {
    await f.song();
    await lyricMp3(`${f.root}/B/song.mp3`, [], { TALB: 'B', TIT2: 'B' });
    await lyricMp3(`${f.dir}/other/C/song.mp3`, [], { TALB: 'C', TIT2: 'C' });
    await f.libraries.add('Other', `${f.dir}/other`);
    await scanLibrary(f.store);
    const songs = await f.library.listSongs({ offset: 0, size: 100 });
    const a = songs.find((s) => s.title === 'Song')!;
    const b = songs.find((s) => s.title === 'B')!;
    const c = songs.find((s) => s.title === 'C')!;
    const runner = await f.start();
    await runner.request({ type: 'song', id: 'absent' }, 'all');
    await runner.request({ type: 'artist', id: a.artistId! }, 'all');
    assertEquals(await f.stats(), {
      done: 0,
      active: 0,
      waiting: 0,
      failed: 0,
    });
    await runner.request({ type: 'album', id: a.albumId! }, 'all');
    await eventually(async () => (await f.stats()).done === 1);
    assertEquals((await f.candidates(a.id)).length, 1);
    assertEquals(await f.candidates(b.id), []);
    assertEquals(await f.candidates(c.id), []);
    await runner.request({ type: 'library', id: f.libraryId }, 'all');
    await eventually(async () => (await f.stats()).done === 3);
    assertEquals((await f.candidates(b.id)).length, 1);
    assertEquals(await f.candidates(c.id), []);
    await runner.request({ type: 'song', id: c.id }, 'all');
    await eventually(async () => (await f.stats()).done === 4);
    assertEquals((await f.candidates(c.id)).length, 1);
    const jobs = await rawSql(f.store).all<{ entity_type: string }>(
      'SELECT entity_type FROM lookup_jobs',
    );
    assert(jobs.every((j) => j.entity_type === 'song'));
  } finally {
    await f.close();
  }
});

Deno.test('lyrics runner: failed, foreign, malformed and oversized outcomes publish nothing; live lyric budget, empty and retry outcomes are respected', async () => {
  const f = await setup();
  try {
    const song = await f.song();
    const runner = await f.start();
    await f.state.set('lyrics.maxBytes', '4096');
    let failed = 0;
    for (const behavior of ['error', 'foreign', 'malformed', 'oversize']) {
      await f.state.set(
        'lookups.plugin.lyrics-fixture.settings.behavior',
        behavior,
      );
      await runner.request({ type: 'song', id: song.id }, 'all');
      failed++;
      await eventually(async () => (await f.stats()).failed === failed, 10000);
      assertEquals(await f.candidates(song.id), []);
    }
    await f.state.set(
      'lookups.plugin.lyrics-fixture.settings.behavior',
      'empty',
    );
    await runner.request({ type: 'song', id: song.id }, 'all');
    await eventually(async () => (await f.stats()).done === 1);
    assertEquals(await f.candidates(song.id), []);
    await f.state.set(
      'lookups.plugin.lyrics-fixture.settings.behavior',
      'found',
    );
    await f.state.set('lyrics.maxBytes', '65536');
    await runner.request({ type: 'song', id: song.id }, 'all');
    await eventually(async () => (await f.stats()).done === 2);
    assertEquals((await f.candidates(song.id)).length, 1);
    await f.state.set(
      'lookups.plugin.lyrics-fixture.settings.behavior',
      'retry',
    );
    await runner.request({ type: 'song', id: song.id }, 'all');
    await eventually(async () =>
      (await rawSql(f.store).all<{ attempts: number; last_error: string }>(
        "SELECT attempts,last_error FROM lookup_jobs WHERE state='waiting'",
      )).some((j) => j.attempts === 0 && j.last_error === 'fixture busy')
    );
    assertEquals((await f.candidates(song.id)).length, 1);
  } finally {
    await f.close();
  }
});

for (const change of ['disable', 'revoke'] as const) {
  Deno.test(`lyrics runner: ${change} retires an in-flight Worker and cannot publish its candidate`, async () => {
    const f = await setup();
    const arrived = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const server = Deno.serve(
      { hostname: '127.0.0.1', port: 0, onListen() {} },
      async () => {
        arrived.resolve();
        await release.promise;
        return new Response('acquired');
      },
    );
    try {
      const song = await f.song();
      await f.state.set('lookups.plugin.lyrics-fixture.enabled', 'false');
      await f.state.set('lookups.plugin.lyrics-fixture.hosts', 'fixture.test');
      await f.state.set(
        'lookups.plugin.lyrics-fixture.settings.behavior',
        'network',
      );
      const runner = await f.start(
        createLookupNetwork({
          fixtures: { 'fixture.test': `http://127.0.0.1:${server.addr.port}` },
        }),
      );
      await runner.request({ type: 'song', id: song.id }, 'all');
      assertEquals(await f.stats(), {
        done: 0,
        active: 0,
        waiting: 0,
        failed: 0,
      });
      await f.state.set('lookups.plugin.lyrics-fixture.enabled', 'true');
      await runner.request({ type: 'song', id: song.id }, 'all');
      await arrived.promise;
      if (change === 'disable') {
        await f.state.set('lookups.plugin.lyrics-fixture.enabled', 'false');
      } else await f.state.set('lookups.plugin.lyrics-fixture.hosts', '');
      release.resolve();
      await eventually(async () => (await f.stats()).active === 0);
      assertEquals(await f.candidates(song.id), []);
      assertEquals((await f.stats()).done, 0);
      // The same runner can acquire new, authorized work after the revocation.
      await f.state.set('lookups.plugin.lyrics-fixture.enabled', 'false');
      await f.state.set(
        'lookups.plugin.lyrics-fixture.settings.behavior',
        'found',
      );
      await f.state.set('lookups.plugin.lyrics-fixture.enabled', 'true');
      await runner.request({ type: 'song', id: song.id }, 'all');
      await eventually(async () => (await f.stats()).done === 1);
      assertEquals((await f.candidates(song.id)).length, 1);
    } finally {
      release.resolve();
      await f.close();
      await server.shutdown();
    }
  });
}

Deno.test('lyrics runner: declared track identifiers gate acquisition without invented values', async () => {
  const f = await setup(['track.id.isrc']);
  try {
    const song = await f.song();
    const runner = await f.start();
    await runner.request({ type: 'song', id: song.id }, 'all');
    assertEquals(await f.stats(), {
      done: 0,
      active: 0,
      waiting: 0,
      failed: 0,
    });
    await lyricMp3(`${f.root}/song.mp3`, [], {
      TSRC: 'USAAA0100001',
    });
    await scanLibrary(f.store);
    await runner.request({ type: 'song', id: song.id }, 'all');
    await eventually(async () => (await f.stats()).done === 1);
    const [candidate] = await f.candidates(song.id);
    assertEquals((candidate.details.facts as { ids: unknown }).ids, {
      isrc: 'USAAA0100001',
    });
  } finally {
    await f.close();
  }
});

Deno.test('lyrics runner: automatic missing intake shares live local/strong selection, weak and rejected remain missing, read-only roots need no writes', async () => {
  const f = await setup();
  try {
    for (
      const name of [
        'embedded',
        'sidecar',
        'strong',
        'medium',
        'low',
        'rejected',
        'malformed',
      ]
    ) {
      await lyricMp3(
        `${f.root}/${name}.mp3`,
        name === 'embedded'
          ? [{ text: 'Local embedded' }]
          : name === 'malformed'
          ? [{ text: 'x'.repeat(1048600) }]
          : [],
        { TIT2: name },
      );
    }
    await Deno.writeTextFile(`${f.root}/sidecar.txt`, 'Local sidecar');
    await Deno.writeTextFile(
      `${f.root}/malformed.elrc`,
      '[00:01.00]<00:broken>bad',
    );
    await scanLibrary(f.store);
    const songs = await f.library.listSongs({ offset: 0, size: 100 });
    for (const name of ['strong', 'medium', 'low', 'rejected'] as const) {
      const song = songs.find((s) => s.title === name)!;
      const [candidate] = await f.store.candidates.addCandidates([{
        entityType: 'song',
        entityId: song.id,
        kind: 'lyrics',
        source: 'prior-source',
        confidence: name === 'rejected' ? 'strong' : name,
        imageHash: 'prior-lyrics',
        imageExt: 'lyrics',
        libraryId: f.libraryId,
        origin: 'https://provenance.invalid/prior',
        details: {
          lyrics: {
            origin: 'https://provenance.invalid/prior',
            entries: lookupLyrics,
          },
        },
      }]);
      if (name === 'rejected') {
        await f.store.candidates.setState(candidate.id, 'rejected');
      }
    }
    const before = await Promise.all(
      songs.map((song) => Deno.readFile(song.path)),
    );
    await Deno.chmod(f.root, 0o555);
    await f.state.set('lookups.plugin.lyrics-fixture.enabled', 'false');
    const runner = await f.start();
    await runner.afterScan();
    assertEquals(await f.stats(), {
      done: 0,
      active: 0,
      waiting: 0,
      failed: 0,
    });
    await f.state.set('lookups.plugin.lyrics-fixture.enabled', 'true');
    await runner.afterScan();
    await eventually(async () => (await f.stats()).done === 4);
    const jobs = await rawSql(f.store).all<{ entity_id: string; mode: string }>(
      "SELECT entity_id, mode FROM lookup_jobs WHERE plugin = 'lyrics-fixture'",
    );
    assertEquals(
      jobs.map((j) => j.entity_id).sort(),
      songs.filter((s) =>
        ['medium', 'low', 'rejected', 'malformed'].includes(s.title!)
      ).map((s) => s.id).sort(),
    );
    assert(jobs.every((j) => j.mode === 'missing'));
    for (const [i, song] of songs.entries()) {
      const selected = await f.library.lyricsBySongId(song.id);
      assertEquals(
        selected,
        song.title === 'embedded'
          ? [{
            language: 'eng',
            synced: false,
            lines: [{ text: 'Local embedded' }],
          }]
          : song.title === 'sidecar'
          ? [{
            language: 'xxx',
            synced: false,
            lines: [{ text: 'Local sidecar' }],
          }]
          : lookupLyrics,
      );
      assertEquals(await Deno.readFile(song.path), before[i]);
    }
    await runner.afterScan();
    await runner.afterScan();
    assertEquals(await f.stats(), {
      done: 4,
      active: 0,
      waiting: 0,
      failed: 0,
    });
    assert(
      ![...Deno.readDirSync(f.root)].some((entry) => entry.name === '.melofon'),
    );
    await Deno.chmod(f.root, 0o755);
    await Deno.remove(`${f.root}/sidecar.txt`);
    await runner.afterScan();
    await eventually(async () => (await f.stats()).done === 5);
    const sidecar = songs.find((song) => song.title === 'sidecar')!;
    assertEquals(await f.library.lyricsBySongId(sidecar.id), lookupLyrics);
  } finally {
    await Deno.chmod(f.root, 0o755);
    await f.close();
  }
});
