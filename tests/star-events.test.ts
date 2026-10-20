// tests/star-events.test.ts — H3 core star history: the one-time migration of
// legacy stars into star_events, starred-now from the latest event, likes,
// the unstar fallback for ids that left the catalog, batch facts, and listen
// facts through current catalog membership.
import { assert, assertEquals } from '@std/assert';
import { openStore, type Store } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { seedFirstUser } from '../src/users.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';

const CFG = {
  listen: undefined,
  dataDir: '',
  user: 'alice',
  password: 'pw',
  secret: 'star-events',
  version: 'test',
};

async function freshDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: 'melofon-star-events-' });
}

async function addUser(db: Store, id: string, name: string): Promise<void> {
  await rawSql(db).run(
    `INSERT INTO users (id, name, password_enc, created_at) VALUES ('${id}', '${name}', 'unused', now())`,
  );
}

// Catalog: artist ar1 → album al1 → songs s1, s2; artist ar2 → album al2 →
// song s3. Ids are plain literals (kind-distinct, like the scan's hashes).
async function seedCatalog(db: Store): Promise<void> {
  await rawSql(db).run(
    "INSERT INTO artists (id, name) VALUES ('ar1', 'One'), ('ar2', 'Two')",
  );
  await rawSql(db).run(
    "INSERT INTO albums (id, name, album_artist_id) VALUES ('al1', 'First', 'ar1'), ('al2', 'Second', 'ar2')",
  );
  await rawSql(db).run(
    `INSERT INTO files (id, path, title, album_id, artist_id) VALUES
       ('s1', '/m/1.mp3', 'S1', 'al1', 'ar1'),
       ('s2', '/m/2.mp3', 'S2', 'al1', 'ar1'),
       ('s3', '/m/3.mp3', 'S3', 'al2', 'ar2')`,
  );
}

interface EventRow {
  user_id: string;
  target_id: string;
  target_type: string;
  action: string;
  at_ms: number;
}

async function events(db: Store): Promise<EventRow[]> {
  const rows = (await rawSql(db).all(
    `SELECT user_id, target_id, target_type, action,
            epoch_ms(occurred_at)::BIGINT AS at_ms
     FROM star_events ORDER BY seq`,
  )) as unknown as (Omit<EventRow, 'at_ms'> & {
    at_ms: bigint;
  })[];
  return rows.map((row) => ({ ...row, at_ms: Number(row.at_ms) }));
}

async function withDb(
  fn: (db: Store, store: Store) => Promise<void>,
): Promise<void> {
  const dir = await freshDir();
  const store = await openStore(dir);
  const db = store;
  try {
    await seedFirstUser(store, { ...CFG, dataDir: dir });
    await seedCatalog(db);
    await fn(db, store);
  } finally {
    await db.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('star history: legacy stars migrate once, in time order, never again', async () => {
  const dir = await freshDir();
  try {
    let store = await openStore(dir);
    let db = store;
    await seedFirstUser(store, { ...CFG, dataDir: dir });
    await seedCatalog(db);
    // Later star inserted first: the migration orders by time, not by row.
    await rawSql(db).run(
      `INSERT INTO stars (user_id, target_id, target_type, starred_at) VALUES
         ('u-legacy', 's2', 'song', '2024-01-02 00:00:00+00'),
         ('u-legacy', 'al1', 'album', '2024-01-01 00:00:00+00')`,
    );
    await db.close();

    store = await openStore(dir);
    db = store;
    const migrated = [
      {
        user_id: 'u-legacy',
        target_id: 'al1',
        target_type: 'album',
        action: 'star',
        at_ms: Date.UTC(2024, 0, 1),
      },
      {
        user_id: 'u-legacy',
        target_id: 's2',
        target_type: 'song',
        action: 'star',
        at_ms: Date.UTC(2024, 0, 2),
      },
    ];
    assertEquals(await events(db), migrated);
    await db.close();

    store = await openStore(dir);
    db = store;
    assertEquals(await events(db), migrated, 'a third open does not repeat');
    assert(await createAnnotation(store).star(CFG.user, 's1'));
    await db.close();

    store = await openStore(dir);
    db = store;
    const after = await events(db);
    assertEquals(after.length, 3, 'no re-migration after a new event');
    assertEquals(after.slice(0, 2), migrated);
    assertEquals(after[2].target_id, 's1');
    await db.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('star history: starred now follows the latest event; every star is a like', async () => {
  await withDb(async (db, store) => {
    const annotation = createAnnotation(store);
    for (const step of ['star', 'star', 'unstar', 'star'] as const) {
      assert(await annotation[step](CFG.user, 's1'), step);
    }
    const facts = (await annotation.facts(CFG.user, ['s1']))['s1'];
    assertEquals(facts.starred, true);
    assertEquals(
      facts.events.map((e) => e.action),
      ['star', 'star', 'unstar', 'star'],
    );
    const times = facts.events.map((e) => e.atMs);
    assertEquals(times, [...times].sort((a, b) => a - b), 'ascending');
    assertEquals(
      (await annotation.starred(CFG.user)).map((
        i,
      ) => [i.targetId, i.targetType]),
      [['s1', 'song']],
    );
    assertEquals(await annotation.likes('s1'), { likes: 3, users: 1 });
    await addUser(db, 'bob-id', 'bob');
    assert(await annotation.star('bob', 's1'));
    assertEquals(await annotation.likes('s1'), { likes: 4, users: 2 });
    assert(await annotation.unstar(CFG.user, 's1'));
    assertEquals(
      (await annotation.facts(CFG.user, ['s1']))['s1'].starred,
      false,
    );
    assertEquals(await annotation.starred(CFG.user), []);
    assertEquals(await annotation.likes('s1'), { likes: 4, users: 2 });
  });
});

Deno.test('star history: classification by lookup and the unstar fallback', async () => {
  await withDb(async (db, store) => {
    const annotation = createAnnotation(store);
    for (const id of ['ar1', 'al1', 's1']) {
      assert(await annotation.star(CFG.user, id), id);
    }
    assertEquals(
      (await annotation.starred(CFG.user)).map((
        i,
      ) => [i.targetId, i.targetType]),
      [['al1', 'album'], ['ar1', 'artist'], ['s1', 'song']],
    );
    // A starred song leaves the catalog: no longer listed, still unstarrable.
    await rawSql(db).run("DELETE FROM files WHERE id = 's1'");
    assertEquals(
      (await annotation.starred(CFG.user)).map((i) => i.targetId),
      ['al1', 'ar1'],
    );
    assert(await annotation.unstar(CFG.user, 's1'));
    const last = (await events(db)).at(-1)!;
    assertEquals(
      [last.target_id, last.target_type, last.action],
      ['s1', 'song', 'unstar'],
    );
    // Never starred and unknown: nothing to record.
    const before = (await events(db)).length;
    assertEquals(await annotation.unstar(CFG.user, 'nope'), false);
    assertEquals(await annotation.star(CFG.user, 'nope'), false);
    assertEquals(await annotation.setRating(CFG.user, 'nope', 3), false);
    assertEquals((await events(db)).length, before);
    assertEquals(
      await rawSql(db).all('SELECT * FROM ratings'),
      [],
    );
  });
});

Deno.test('star history: starred honours the music folder', async () => {
  await withDb(async (db, store) => {
    await rawSql(db).run(
      "INSERT INTO libraries VALUES ('lib-a', 'A', '/a'), ('lib-b', 'B', '/b')",
    );
    await rawSql(db).run(
      "UPDATE files SET library_id = CASE WHEN id = 's3' THEN 'lib-b' ELSE 'lib-a' END",
    );
    const annotation = createAnnotation(store);
    for (const id of ['ar1', 'ar2', 'al1', 'al2', 's1', 's3']) {
      assert(await annotation.star(CFG.user, id));
    }
    const ids = async (folderId?: string) =>
      (await annotation.starred(CFG.user, { folderId })).map((i) => i.targetId);
    assertEquals(await ids(), ['al1', 'al2', 'ar1', 'ar2', 's1', 's3']);
    assertEquals(await ids('lib-a'), ['al1', 'ar1', 's1']);
    assertEquals(await ids('lib-b'), ['al2', 'ar2', 's3']);
    assertEquals(await ids('no-such-library'), []);
  });
});

Deno.test('star history: batch facts cover every id; the average is unrounded', async () => {
  await withDb(async (db, store) => {
    const annotation = createAnnotation(store);
    await addUser(db, 'bob-id', 'bob');
    await addUser(db, 'carol-id', 'carol');
    assert(await annotation.setRating(CFG.user, 's1', 1));
    assert(await annotation.setRating('bob', 's1', 1));
    assert(await annotation.setRating('carol', 's1', 2));
    assert(await annotation.star(CFG.user, 'al1'));
    const facts = await annotation.facts(CFG.user, ['s1', 'al1', 'gone']);
    assertEquals(Object.keys(facts).sort(), ['al1', 'gone', 's1']);
    assertEquals(facts['s1'].userRating, 1);
    assertEquals(facts['s1'].averageRating, 4 / 3);
    assertEquals(facts['s1'].starred, false);
    assertEquals(facts['al1'].starred, true);
    assertEquals(facts['al1'].events.length, 1);
    assertEquals(facts['al1'].userRating, null);
    assertEquals(facts['gone'], {
      starred: false,
      events: [],
      userRating: null,
      averageRating: null,
    });
    assertEquals(await annotation.facts(CFG.user, []), {});
  });
});

Deno.test('listen facts: song/album/artist plays through current membership', async () => {
  await withDb(async (db, store) => {
    const listens = createListens(store);
    await addUser(db, 'bob-id', 'bob');
    const at = (ms: number) => ({ source: 'test', playedAtMs: ms });
    assert(await listens.record(CFG.user, 's1', at(3000)));
    assert(await listens.record(CFG.user, 's1', at(1000)));
    assert(await listens.record(CFG.user, 's2', at(2000)));
    assert(await listens.record(CFG.user, 's3', at(5000)));
    assert(await listens.record('bob', 's1', at(9000)));
    assertEquals(await listens.record(CFG.user, 'nope', at(4000)), false);
    assertEquals(
      await rawSql(db).all(
        "SELECT count(*) AS n FROM listens WHERE track_id = 'nope'",
      ),
      [{ n: 0n }],
    );
    const facts = await listens.facts(CFG.user, {
      songs: ['s1', 's2', 'nope'],
      albums: ['al1', 'al2'],
      artists: ['ar1', 'ar2', 'ar-none'],
    });
    assertEquals(facts.songs, {
      s1: { playCount: 2, lastPlayedMs: 3000 },
      s2: { playCount: 1, lastPlayedMs: 2000 },
      nope: { playCount: 0, lastPlayedMs: null },
    });
    assertEquals(facts.albums, {
      al1: { playCount: 3, lastPlayedMs: 3000 },
      al2: { playCount: 1, lastPlayedMs: 5000 },
    });
    assertEquals(facts.artists, {
      ar1: { playCount: 3, lastPlayedMs: 3000 },
      ar2: { playCount: 1, lastPlayedMs: 5000 },
      'ar-none': { playCount: 0, lastPlayedMs: null },
    });
    // Membership is read at query time: a song moved to the other album
    // counts there from now on.
    await rawSql(db).run("UPDATE files SET album_id = 'al2' WHERE id = 's2'");
    const moved = await listens.facts(CFG.user, { albums: ['al1', 'al2'] });
    assertEquals(moved.albums.al1.playCount, 2);
    assertEquals(moved.albums.al2, { playCount: 2, lastPlayedMs: 5000 });
    assertEquals(moved.songs, {});
    assertEquals(moved.artists, {});
  });
});
