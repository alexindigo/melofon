import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore, type Store } from '../src/store/index.ts';
import type { CandidateInput, LocalVersion } from '../src/store/candidates.ts';

const input = (overrides: Partial<CandidateInput> = {}): CandidateInput => ({
  entityType: 'album',
  entityId: 'album',
  kind: 'cover',
  source: 'fixture',
  confidence: 'strong',
  imageHash: 'hash',
  imageExt: 'jpg',
  libraryId: 'lib',
  origin: 'https://fixture/image',
  details: { collectionId: 42, name: "It's music" },
  ...overrides,
});
async function setup(fn: (store: Store, dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-candidates-' });
  const store = await openStore(dir);
  try {
    await fn(store, dir);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('candidates round-trip plain fields and scope reads by entity type and id', async () => {
  await setup(async (store) => {
    const [candidate] = await store.candidates.addCandidates([
      input({ foundAtMs: 123456 }),
    ]);
    assert(candidate.id.length > 0);
    assertEquals(candidate, {
      ...input(),
      details: { collectionId: 42, name: "It's music" },
      id: candidate.id,
      state: 'open',
      foundAtMs: 123456,
      decidedAtMs: null,
    });
    assertEquals(await store.candidates.candidatesFor('album', 'album'), [
      candidate,
    ]);
    assertEquals(await store.candidates.candidatesFor('song', 'album'), []);
    assertEquals(await store.candidates.candidatesFor('album', 'other'), []);
  });
});

Deno.test('candidates remember rejected entity/source/hash and coalesce concurrent repeat proposals', async () => {
  await setup(async (store) => {
    const [candidate] = await store.candidates.addCandidates([input()]);
    await store.candidates.setState(candidate.id, 'rejected');
    const results = await Promise.all(
      Array.from(
        { length: 10 },
        () => store.candidates.addCandidates([input()]),
      ),
    );
    assertEquals(results.flat(), []);
    assertEquals(
      (await store.candidates.candidatesFor('album', 'album')).length,
      1,
    );
    assertEquals(
      (await store.candidates.addCandidates([
        input({ source: 'other' }),
        input({ entityId: 'other' }),
        input({ imageHash: 'other' }),
        input({ entityType: 'song' }),
      ])).length,
      4,
    );
  });
});

Deno.test('strongestOpen uses strong open matching kind only and newest wins ties deterministically', async () => {
  await setup(async (store) => {
    await store.candidates.addCandidates([
      input({ imageHash: 'old', foundAtMs: 1 }),
      input({ imageHash: 'new', foundAtMs: 2 }),
      input({ imageHash: 'newest', foundAtMs: 2 }),
      input({ imageHash: 'medium', confidence: 'medium', foundAtMs: 3 }),
      input({ imageHash: 'low', confidence: 'low', foundAtMs: 4 }),
      input({
        imageHash: 'local',
        source: 'local',
        confidence: null,
        foundAtMs: 5,
      }),
      input({ imageHash: 'fields', kind: 'fields', foundAtMs: 6 }),
    ]);
    const winner = await store.candidates.strongestOpen(
      'album',
      'album',
      'cover',
    );
    assertEquals(winner?.imageHash, 'newest');
    await store.candidates.setState(winner!.id, 'accepted');
    assertEquals(
      (await store.candidates.strongestOpen('album', 'album', 'cover'))
        ?.imageHash,
      'new',
    );
    assertEquals(
      await store.candidates.strongestOpen('album', 'missing', 'cover'),
      null,
    );
  });
});

Deno.test('setState records decisions and clearing to open removes decision time', async () => {
  await setup(async (store) => {
    const [candidate] = await store.candidates.addCandidates([input()]);
    for (const state of ['accepted', 'rejected', 'edited', 'open'] as const) {
      await store.candidates.setState(candidate.id, state);
      const [row] = await store.candidates.candidatesFor('album', 'album');
      assertEquals(row.state, state);
      if (state === 'open') assertEquals(row.decidedAtMs, null);
      else assert(row.decidedAtMs! > 0);
    }
  });
});

Deno.test('replaceLocal reconciles versions, refreshes origins and keeps decided and nonlocal proposals', async () => {
  await setup(async (store) => {
    const version = (imageHash: string): LocalVersion => ({
      imageHash,
      imageExt: 'jpg',
      libraryId: 'lib',
      origin: 'song-id',
    });
    await store.candidates.replaceLocal('album', [
      version('one'),
      version('two'),
      version('one'),
    ]);
    let rows = await store.candidates.candidatesFor('album', 'album');
    assertEquals(rows.length, 2);
    assertEquals(rows.map((r) => [r.source, r.confidence]), [['local', null], [
      'local',
      null,
    ]]);
    await store.candidates.setState(rows[0].id, 'rejected');
    await store.candidates.addCandidates([input()]);
    await store.candidates.replaceLocal('album', [version('one'), {
      ...version('two'),
      origin: 'Moved/cover.jpg',
    }, version('three')]);
    rows = await store.candidates.candidatesFor('album', 'album');
    assertEquals(rows.length, 4);
    assertEquals(
      rows.find((r) => r.imageHash === 'two')?.origin,
      'Moved/cover.jpg',
    );
    await store.candidates.replaceLocal('album', []);
    assertEquals(
      (await store.candidates.candidatesFor('album', 'album')).map((
        r,
      ) => [r.imageHash, r.state]),
      [['one', 'rejected'], ['hash', 'open']],
    );
  });
});

Deno.test('candidate batch and local replacement roll back completely on invalid input', async () => {
  await setup(async (store) => {
    await assertRejects(() =>
      store.candidates.addCandidates([
        input(),
        input({ entityType: 'invalid' as 'album' }),
      ])
    );
    assertEquals(await store.candidates.candidatesFor('album', 'album'), []);
    await store.candidates.replaceLocal('album', [input()]);
    await assertRejects(() =>
      store.candidates.replaceLocal('album', [{
        ...input(),
        imageHash: 'bad',
        imageExt: null as unknown as string,
      }])
    );
    assertEquals(
      (await store.candidates.candidatesFor('album', 'album')).map((r) =>
        r.imageHash
      ),
      ['hash'],
    );
  });
});

Deno.test('candidates survive catalog rebuild and database reopen with decisions intact', async () => {
  await setup(async (store, dir) => {
    const [candidate] = await store.candidates.addCandidates([input()]);
    await store.candidates.setState(candidate.id, 'edited');
    await store.catalog.replaceCatalog({
      artists: [],
      albums: [],
      albumIdentities: [],
      albumEvents: [],
      files: [],
      events: [],
      retainedIds: [],
    });
    const before = await store.candidates.candidatesFor('album', 'album');
    await store.close();
    const reopened = await openStore(dir);
    try {
      assertEquals(
        await reopened.candidates.candidatesFor('album', 'album'),
        before,
      );
    } finally {
      await reopened.close();
    }
  });
});
