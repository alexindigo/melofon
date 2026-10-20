import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { seedFirstUser } from '../src/users.ts';
import { createLibraries } from '../src/libraries.ts';
import { scanLibrary } from '../src/scan.ts';
import { createUserService } from '../src/user.ts';
import { createLibrary } from '../src/library.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { createClientQueue } from '../src/clientqueue.ts';
import { createState } from '../src/state.ts';
import { loadLayers } from '../src/layers.ts';
import { facade } from '../src/facade.ts';

const FIXTURES = [
  'tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3',
  'tests/fixtures/library/Fixture Artist/Fixture Album/02 - Second Song.mp3',
  'tests/fixtures/library/Various Artists/Fixture OST/01 - Probe Performer - Theme.mp3',
];
const AUTH = 'u=admin&p=test&v=1.16.1&c=g1-consumer&f=json';
type App = (request: Request) => Promise<Response>;

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-queue-index-' });
  const root = `${dir}/music`;
  await Deno.mkdir(root);
  for (const [i, file] of FIXTURES.entries()) {
    await Deno.copyFile(file, `${root}/${i}.mp3`);
  }
  let store = await openStore(`${dir}/db`);
  const cfg = {
    listen: undefined,
    dataDir: `${dir}/db`,
    user: 'admin',
    password: 'test',
    secret: 'g1-secret',
    version: 'test',
  };
  await seedFirstUser(store, cfg);
  await createLibraries(store).add('Music', root);
  await scanLibrary(store);
  async function router() {
    const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
    return facade(
      core,
      await loadLayers({
        app: {
          cfg,
          state: createState(store),
          user: createUserService(store, cfg),
          library: createLibrary(store),
          annotation: createAnnotation(store),
          listens: createListens(store),
          clientQueue: createClientQueue(store),
        },
      }),
    );
  }
  let app = await router();
  const songs = await rawSql(store).all<{ id: string; path: string }>(
    'SELECT id, path FROM files ORDER BY path',
  );
  assertEquals(songs.length, 3);
  return {
    root,
    songs,
    get store() {
      return store;
    },
    app: (request: Request) => app(request),
    scan: () => scanLibrary(store),
    async reopen() {
      await store.close();
      store = await openStore(`${dir}/db`);
      app = await router();
    },
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

async function call(app: App, op: string, extra = '', method = 'GET') {
  const params = new URLSearchParams(`${AUTH}${extra}`);
  const res = await app(
    new Request(
      `http://x/rest/${op}.view${method === 'GET' ? `?${params}` : ''}`,
      method === 'POST' ? { method, body: params } : { method },
    ),
  );
  assertEquals(res.status, 200);
  return (await res.json())['subsonic-response'];
}

const idsParam = (ids: string[]) => ids.map((id) => `&id=${id}`).join('');

async function expectQueue(
  app: App,
  ids: string[],
  index: number,
  position: number,
) {
  const indexed = (await call(app, 'getPlayQueueByIndex')).playQueueByIndex;
  const legacy = (await call(app, 'getPlayQueue')).playQueue;
  for (const queue of [indexed, legacy]) {
    assertEquals(queue.entry.map((entry: { id: string }) => entry.id), ids);
    assertEquals(queue.position, position);
    assertEquals(queue.username, 'admin');
    assertEquals(queue.changedBy, 'g1-consumer');
    assert(Number.isFinite(Date.parse(queue.changed)));
  }
  assertEquals(indexed.currentIndex, index);
  assertEquals(indexed.current, undefined);
  assertEquals(legacy.current, ids[index]);
  assertEquals(legacy.currentIndex, undefined);
  assertEquals(legacy.changed, indexed.changed);
}

Deno.test('G1 duplicate occurrence survives restart and both queue projections share one save', async () => {
  const t = await setup();
  try {
    const [a, b] = t.songs.map((s) => s.id);
    const ids = [a, b, a];
    assertEquals(
      (await call(
        t.app,
        'savePlayQueueByIndex',
        `${idsParam(ids)}&currentIndex=2&position=1234`,
        'POST',
      )).status,
      'ok',
    );
    await t.reopen();
    await expectQueue(t.app, ids, 2, 1234);
    const indexed = await call(t.app, 'getPlayQueueByIndex', '', 'POST');
    assertEquals(indexed.playQueueByIndex.currentIndex, 2);
    assertEquals(
      (await call(t.app, 'savePlayQueue', `${idsParam(ids)}&current=${a}`))
        .status,
      'ok',
    );
    await expectQueue(t.app, ids, 0, 0);
    assertEquals(
      (await call(
        t.app,
        'savePlayQueue',
        `${idsParam(ids)}&current=not-in-queue&position=`,
      )).status,
      'ok',
    );
    await expectQueue(t.app, ids, 0, 0);
    const xml = await t.app(
      new Request(
        `http://x/rest/getPlayQueueByIndex?${AUTH.replace('f=json', 'f=xml')}`,
      ),
    );
    const text = await xml.text();
    assert(text.includes('<playQueueByIndex'));
    assert(text.includes('currentIndex="0"'));
    assertEquals((text.match(/<entry /g) ?? []).length, 3);
  } finally {
    await t.close();
  }
});

Deno.test('G1 queue parameter error-10 cases preserve the previous saved queue over GET and POST', async () => {
  const t = await setup();
  try {
    const [a, b] = t.songs.map((s) => s.id);
    await call(
      t.app,
      'savePlayQueueByIndex',
      `${idsParam([a, b])}&currentIndex=1&position=99`,
    );
    for (const method of ['GET', 'POST']) {
      for (const op of ['savePlayQueue', 'savePlayQueueByIndex']) {
        const cases = op === 'savePlayQueue'
          ? [`&id=${a}`, `&id=${a}&current=`]
          : [
            `&id=${a}`,
            ...[
              '',
              ' ',
              '-1',
              '1',
              '0.5',
              'NaN',
              'Infinity',
              '1e100',
              '1e-1000',
              'abc',
            ].map(
              (value) => `&id=${a}&currentIndex=${encodeURIComponent(value)}`,
            ),
            '&currentIndex=0',
            '&currentIndex=',
          ];
        for (const extra of cases) {
          const response = await call(t.app, op, extra, method);
          assertEquals(response.status, 'failed', `${method} ${op}${extra}`);
          assertEquals(response.error.code, 10, `${method} ${op}${extra}`);
          await expectQueue(t.app, [a, b], 1, 99);
        }
      }
    }
  } finally {
    await t.close();
  }
});

Deno.test('G1 either empty save clears both projections and deletes the saved row', async () => {
  const t = await setup();
  try {
    const a = t.songs[0].id;
    for (const method of ['GET', 'POST']) {
      for (const op of ['savePlayQueue', 'savePlayQueueByIndex']) {
        await call(t.app, 'savePlayQueueByIndex', `&id=${a}&currentIndex=0`);
        assertEquals((await call(t.app, op, '', method)).status, 'ok');
        assertEquals((await call(t.app, 'getPlayQueue')).playQueue, undefined);
        assertEquals(
          (await call(t.app, 'getPlayQueueByIndex')).playQueueByIndex,
          undefined,
        );
        assertEquals(
          await rawSql(t.store).all('SELECT * FROM play_queues'),
          [],
        );
      }
    }
  } finally {
    await t.close();
  }
});

Deno.test('G1 deleting earlier songs retains the same duplicate occurrence and its position', async () => {
  const t = await setup();
  try {
    const [a, b, c] = t.songs.map((s) => s.id);
    await call(
      t.app,
      'savePlayQueueByIndex',
      `${idsParam([a, b, c, b])}&currentIndex=3&position=5432`,
    );
    await Deno.remove(t.songs[0].path);
    await t.scan();
    await expectQueue(t.app, [b, c, b], 2, 5432);
  } finally {
    await t.close();
  }
});

Deno.test('G1 vanished current advances to the next surviving entry, else last, else cleared', async () => {
  const t = await setup();
  try {
    const [a, b, c] = t.songs.map((s) => s.id);
    // Missing entries on either side of current must not affect its successor.
    await call(
      t.app,
      'savePlayQueueByIndex',
      `${idsParam([a, b, b, c])}&currentIndex=1&position=9876`,
    );
    await Deno.remove(t.songs[1].path);
    await t.scan();
    await expectQueue(t.app, [a, c], 1, 0);
    await Deno.remove(t.songs[2].path);
    await t.scan();
    await expectQueue(t.app, [a], 0, 0);
    await Deno.remove(t.songs[0].path);
    await t.scan();
    assertEquals((await call(t.app, 'getPlayQueue')).playQueue, undefined);
    assertEquals(
      (await call(t.app, 'getPlayQueueByIndex')).playQueueByIndex,
      undefined,
    );
  } finally {
    await t.close();
  }
});

Deno.test('G1 moving a song keeps its identity, queue occurrence and playback position', async () => {
  const t = await setup();
  try {
    const a = t.songs[0].id;
    await call(
      t.app,
      'savePlayQueueByIndex',
      `${idsParam([a, a])}&currentIndex=1&position=66`,
    );
    await Deno.rename(t.songs[0].path, `${t.root}/moved.mp3`);
    await t.scan();
    await expectQueue(t.app, [a, a], 1, 66);
    const song = (await call(t.app, 'getSong', `&id=${a}`)).song;
    assertEquals(song.id, a);
    assertEquals(song.path, 'moved.mp3');
  } finally {
    await t.close();
  }
});

Deno.test('G1 legacy current-id schema migrates first occurrence, absent and null ids once on upgrade', async () => {
  const t = await setup();
  try {
    const [a, b] = t.songs.map((s) => s.id);
    // Construct the production pre-upgrade table through the store test seam.
    await rawSql(t.store).run('DROP TABLE play_queues');
    await rawSql(t.store).run(`CREATE TABLE play_queues (
      user_id VARCHAR PRIMARY KEY, current_id VARCHAR, position_ms INTEGER,
      changed_at TIMESTAMPTZ NOT NULL, track_ids VARCHAR[] NOT NULL,
      changed_by VARCHAR)`);
    const userId = (await rawSql(t.store).all<{ id: string }>(
      "SELECT id FROM users WHERE name = 'admin'",
    ))[0].id;
    for (
      const [current, index, position] of [
        [`'${a}'`, 0, 0],
        [`'${b}'`, 1, 123],
        ["'absent'", 0, 0],
        ['NULL', 0, 0],
      ] as const
    ) {
      await rawSql(t.store).run(`INSERT INTO play_queues VALUES
        ('${userId}', ${current}, ${position || 'NULL'}, '2026-01-02T03:04:05Z',
        ['${a}', '${b}', '${a}'], 'g1-consumer')
        ON CONFLICT (user_id) DO UPDATE SET current_id = excluded.current_id`);
      await t.reopen();
      await expectQueue(t.app, [a, b, a], index, position);
      assertEquals(
        (await call(t.app, 'getPlayQueue')).playQueue.changed,
        '2026-01-02T03:04:05.000Z',
      );
      const columns = await rawSql(t.store).all<{ name: string }>(
        "PRAGMA table_info('play_queues')",
      );
      assert(!columns.some((column) => column.name === 'current_id'));
      assert(columns.some((column) => column.name === 'current_index'));
      // Recreate the old schema for each migration input.
      await rawSql(t.store).run('DROP TABLE play_queues');
      await rawSql(t.store).run(`CREATE TABLE play_queues (
        user_id VARCHAR PRIMARY KEY, current_id VARCHAR, position_ms INTEGER,
        changed_at TIMESTAMPTZ NOT NULL, track_ids VARCHAR[] NOT NULL,
        changed_by VARCHAR)`);
    }
    await t.reopen();
    await call(
      t.app,
      'savePlayQueueByIndex',
      `${idsParam([a, b, a])}&currentIndex=2&position=77`,
    );
    await t.reopen();
    await expectQueue(t.app, [a, b, a], 2, 77);
  } finally {
    await t.close();
  }
});

Deno.test('G1 public capability discovery advertises indexBasedQueue version 1', async () => {
  const t = await setup();
  try {
    const response = await t.app(
      new Request('http://x/rest/getOpenSubsonicExtensions?f=json'),
    );
    const body = (await response.json())['subsonic-response'];
    assertEquals(
      body.openSubsonicExtensions.filter((cap: { name: string }) =>
        cap.name === 'indexBasedQueue'
      ),
      [
        { name: 'indexBasedQueue', versions: [1] },
      ],
    );
  } finally {
    await t.close();
  }
});
