import { assert, assertEquals } from '@std/assert';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';

Deno.test('H6 old candidates CHECK migration keeps every decision, queue row and ordering sequence across reopen', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'lyrics-migration-' });
  let store = await openStore(dir);
  try {
    const schema = await Deno.readTextFile('src/store/schema.sql');
    const definition = schema.split(';').find((sql) =>
      /CREATE TABLE IF NOT EXISTS candidates\s*\(/.test(sql)
    )!;
    // Disposable old-version schema, seeded only through the testing/store APIs.
    await rawSql(store).run('DROP TABLE candidates');
    await rawSql(store).run(
      definition.replace("'cover', 'fields', 'lyrics'", "'cover', 'fields'"),
    );
    for (const state of ['open', 'accepted', 'rejected', 'edited'] as const) {
      const [candidate] = await store.candidates.addCandidates([{
        entityType: 'album',
        entityId: state,
        kind: 'cover',
        source: 'local',
        confidence: null,
        imageHash: state,
        imageExt: 'png',
        libraryId: 'kept',
        origin: `origin-${state}`,
        details: { arbitrary: { kept: state }, preserved: true },
      }]);
      await store.candidates.setState(candidate.id, state);
    }
    await store.lookups.enqueue([{
      plugin: 'core.unify',
      entityType: 'album',
      entityId: 'accepted',
      factsHash: 'kept-choice',
      mode: 'all',
    }]);
    const before = await rawSql(store).all(
      'SELECT * FROM candidates ORDER BY seq',
    );
    const jobs = await rawSql(store).all(
      'SELECT * FROM lookup_jobs ORDER BY seq',
    );
    await store.close();
    store = await openStore(dir);
    assertEquals(
      await rawSql(store).all('SELECT * FROM candidates ORDER BY seq'),
      before,
    );
    assertEquals(
      await rawSql(store).all('SELECT * FROM lookup_jobs ORDER BY seq'),
      jobs,
    );
    const [lyrics] = await store.candidates.addCandidates([{
      entityType: 'song',
      entityId: 'new-song',
      kind: 'lyrics',
      source: 'local',
      confidence: null,
      imageHash: 'new-hash',
      imageExt: 'lyrics',
      libraryId: 'kept',
      origin: 'new-song',
      details: {
        lyrics: {
          entry: {
            language: 'xxx',
            synced: false,
            lines: [{ text: 'Kept words' }],
          },
        },
      },
    }]);
    assert(lyrics);
    assertEquals(
      (await rawSql(store).all<{ seq: bigint }>(
        `SELECT seq FROM candidates WHERE id = '${lyrics.id}'`,
      ))[0].seq,
      5n,
    );
    await store.close();
    store = await openStore(dir);
    assertEquals(
      (await store.candidates.byId(lyrics.id))!.details,
      lyrics.details,
    );
    assertEquals(
      (await rawSql(store).all('SELECT * FROM candidates ORDER BY seq')).length,
      5,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('H6 queued lyrics selection survives a scan that resolves the live conflict and refreshes timing', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'lyrics-pending-' });
  const store = await openStore(dir);
  try {
    const details = {
      lyrics: {
        entry: {
          language: 'xxx',
          synced: true,
          lines: [{ start: 1000, text: 'Chosen words' }],
        },
      },
    };
    const version = {
      libraryId: 'library',
      imageHash: 'chosen',
      imageExt: 'lyrics',
      origin: 'kept',
      details,
    };
    await store.candidates.replaceLocal('kept', [version], 'lyrics');
    const [candidate] = await store.candidates.candidatesFor('song', 'kept');
    await store.candidates.accept(candidate.id);
    await store.candidates.replaceLocal('kept', [{
      ...version,
      details: {
        lyrics: {
          entry: {
            ...details.lyrics.entry,
            lines: [{ start: 3000, text: 'Chosen words' }],
          },
        },
      },
    }], 'lyrics');
    assertEquals((await store.candidates.byId(candidate.id))!.details, details);
    await store.candidates.replaceLocal('kept', [], 'lyrics');
    assertEquals((await store.candidates.byId(candidate.id))!.state, 'open');
    assertEquals((await store.lookups.stats('core.unify')).waiting, 1);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
