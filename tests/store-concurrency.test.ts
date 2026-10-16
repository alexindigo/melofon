import { assertEquals } from '@std/assert';
import { openStore } from '../src/store/index.ts';
import type { CatalogSnapshot } from '../src/store/catalog.ts';
import { rawSql } from '../src/store/testing.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createPlaylists } from '../src/playlists.ts';
import { createPersistence } from '../src/persistence.ts';
import { createState } from '../src/state.ts';

function snapshot(): CatalogSnapshot {
  return {
    artists: [{ id: 'artist', name: 'Artist' }],
    albums: [{ id: 'album', name: 'Album', albumArtistId: 'artist' }],
    files: [{
      id: 'song',
      path: '/song',
      rel: 'song',
      libraryId: 'lib',
      stat: { size: null, mtime_ms: null, dev: null, ino: null },
      fingerprint: null,
      pcmMd5: null,
      title: 'Song',
      albumId: 'album',
      artistId: 'artist',
      track: 1,
      disc: 1,
      durationMs: 1000,
      genre: null,
      year: null,
      isVideo: false,
    }],
    events: [],
    retainedIds: [],
  };
}

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-store-concurrency-' });
  const store = await openStore(dir);
  await store.users.seedFirst('u', 'alice', 'unused');
  await store.catalog.addLibrary({ id: 'lib', name: 'Music', path: '/music' });
  await store.catalog.replaceCatalog(snapshot());
  return {
    store,
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

// S1's retained BASE reproduction failed on transaction overlap and lost stars.
Deno.test('overlapping writers keep every expected row for 200 rounds', async () => {
  const { store, close } = await setup();
  try {
    const failures: unknown[] = [];
    const persistence = createPersistence(store, {
      event: (id, facts) => {
        if (id === 'persistence_failed') failures.push(facts);
      },
    });
    const playlists = createPlaylists(store);
    const annotation = createAnnotation(store);
    const state = createState(store);
    const lists = [];
    for (let i = 0; i < 200; i++) {
      lists.push(await playlists.create('alice', `list-${i}`, []));
    }
    const results = await Promise.allSettled(lists.map(async (list, i) => {
      persistence.saveQueue(['song']);
      persistence.saveState({
        state: 'stop',
        currentIndex: null,
        positionMs: i,
        repeat: 'off',
        shuffle: false,
        consume: false,
      });
      await Promise.all([
        playlists.update('alice', list.id, { addTrackIds: ['song'] }),
        annotation.star('alice', 'song'),
        state.set(`round-${i}`, `${i}`),
      ]);
    }));
    await persistence.drain();
    assertEquals(results.filter((r) => r.status === 'rejected'), []);
    assertEquals(failures, []);
    const count = async (table: string) =>
      Number(
        (await rawSql(store).all(`SELECT count(*) AS n FROM ${table}`))[0].n,
      );
    assertEquals(await count('playlist_tracks'), 200);
    assertEquals(await count('star_events'), 200);
    assertEquals(await count('state'), 200);
    for (let i = 0; i < 200; i++) {
      assertEquals(await state.get(`round-${i}`), `${i}`);
      assertEquals((await playlists.get('alice', lists[i].id))?.trackIds, [
        'song',
      ]);
    }
    assertEquals(await persistence.loadQueue(), ['song']);
    assertEquals((await persistence.loadPlayerState())?.positionMs, 199);
  } finally {
    await close();
  }
});

Deno.test('concurrent writes survive a failed catalog replacement and the previous catalog stays intact', async () => {
  const { store, close } = await setup();
  try {
    const failures: unknown[] = [];
    const persistence = createPersistence(store, {
      event: (id, facts) => {
        if (id === 'persistence_failed') failures.push(facts);
      },
    });
    const playlists = createPlaylists(store);
    const annotation = createAnnotation(store);
    const state = createState(store);
    const list = await playlists.create('alice', 'surviving', []);
    const tables = [
      'libraries',
      'artists',
      'albums',
      'files',
      'file_identity',
      'file_events',
    ];
    const catalogRows = () =>
      Promise.all(
        tables.map((table) => rawSql(store).all(`SELECT * FROM ${table}`)),
      );
    const before = await catalogRows();
    const album = await store.catalog.getAlbum('album');
    const bad = snapshot();
    bad.retainedIds = ['song'];
    bad.artists[0].name = 'Changed';
    bad.files.push({ ...bad.files[0], path: '/duplicate', rel: 'duplicate' });
    bad.events.push({
      kind: 'ambiguous',
      file: bad.files[0],
      candidates: ['song'],
    });
    const replacing = store.catalog.replaceCatalog(bad);
    persistence.saveState({
      state: 'stop',
      currentIndex: null,
      positionMs: 42,
      repeat: 'off',
      shuffle: false,
      consume: false,
    });
    const results = await Promise.allSettled([
      replacing,
      annotation.star('alice', 'song'),
      state.set('surviving', 'value'),
      playlists.update('alice', list.id, { addTrackIds: ['song'] }),
    ]);
    await persistence.drain();
    assertEquals(results.map((r) => r.status), [
      'rejected',
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
    const failure = results[0] as PromiseRejectedResult;
    assertEquals(String(failure.reason).includes('Constraint'), true);
    assertEquals(failures, []);
    assertEquals(
      (await annotation.facts('alice', ['song'])).song.starred,
      true,
    );
    assertEquals(await state.get('surviving'), 'value');
    assertEquals((await playlists.get('alice', list.id))?.trackIds, ['song']);
    assertEquals((await persistence.loadPlayerState())?.positionMs, 42);
    assertEquals(await catalogRows(), before);
    assertEquals(await store.catalog.getAlbum('album'), album);
  } finally {
    await close();
  }
});
