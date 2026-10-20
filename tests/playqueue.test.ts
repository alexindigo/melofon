// tests/playqueue.test.ts — M2 Subsonic play queue: savePlayQueue upserts one
// row per user (ids + current + position), getPlayQueue returns entries in
// order with `current` as a string; nothing saved → bare ok envelope.
import { assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { seedFirstUser } from '../src/users.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createUserService } from '../src/user.ts';
import { createLibrary } from '../src/library.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { createPlaylists } from '../src/playlists.ts';
import { createClientQueue } from '../src/clientqueue.ts';
import { loadLayers } from '../src/layers.ts';
import { createState } from '../src/state.ts';
import { facade } from '../src/facade.ts';

const AUTH = 'u=admin&p=test&v=1.16.1&c=melofon-test';

interface PlayQueuePayload {
  entry: { id: string }[];
  current?: string;
  position?: number;
  username: string;
  changed?: string;
  changedBy: string;
}

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-pq-' });
  const store = await openStore(dir);
  const db = store;
  const cfg = {
    listen: undefined,
    dataDir: dir,
    user: 'admin',
    password: 'test',
    secret: 's3cret',
    version: '0.0.0-test',
  };
  await seedFirstUser(store, cfg);
  const libraries = createLibraries(store);
  await libraries.add('Music', 'tests/fixtures/library');
  await scanLibrary(store);
  const bag = {
    state: createState(store),
    cfg,
    libraries,
    user: createUserService(store, cfg),
    library: createLibrary(store),
    annotation: createAnnotation(store),
    listens: createListens(store),
    playlists: createPlaylists(store),
    clientQueue: createClientQueue(store),
  };
  const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
  const app = facade(core, await loadLayers({ app: bag }));
  const songs = await rawSql(db).all(
    "SELECT id FROM files WHERE title != '' ORDER BY path",
  );
  const songIds = (songs as { id: string }[]).map((r) => r.id);
  return {
    db,
    app,
    songIds,
    close: async () => {
      await db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

async function call(
  app: (req: Request) => Promise<Response>,
  op: string,
  extra = '',
): Promise<Record<string, unknown>> {
  const res = await app(
    new Request(`http://x/rest/${op}?${AUTH}&f=json${extra}`),
  );
  const body = await res.json();
  return (body as Record<string, Record<string, unknown>>)[
    'subsonic-response'
  ];
}

Deno.test('getPlayQueue with nothing saved is a bare ok envelope', async () => {
  const { app, close } = await setup();
  try {
    const body = await call(app, 'getPlayQueue');
    assertEquals(body.status, 'ok');
    assertEquals(body.playQueue, undefined);
  } finally {
    await close();
  }
});

Deno.test('savePlayQueue then getPlayQueue round-trips the queue', async () => {
  const { app, songIds, close } = await setup();
  try {
    const [a, b, c] = songIds;
    const saved = await call(
      app,
      'savePlayQueue',
      `&id=${a}&id=${b}&id=${c}&current=${b}&position=42000`,
    );
    assertEquals(saved.status, 'ok');

    const body = await call(app, 'getPlayQueue');
    const queue = body.playQueue as PlayQueuePayload;
    assertEquals(queue.entry.map((s) => s.id), [a, b, c]);
    assertEquals(queue.current, b); // Navidrome quirk: a string
    assertEquals(queue.position, 42000);
    // Required by the OpenSubsonic schema.
    assertEquals(queue.username, 'admin');
    assertEquals(typeof queue.changed, 'string');
    // The saving client's name (the `c` param), Navidrome-style.
    assertEquals(queue.changedBy, 'melofon-test');
  } finally {
    await close();
  }
});

Deno.test('savePlayQueue upserts: one row per user, latest wins', async () => {
  const { app, db, songIds, close } = await setup();
  try {
    const [a, b] = songIds;
    await call(app, 'savePlayQueue', `&id=${a}&current=${a}&position=1`);
    await call(app, 'savePlayQueue', `&id=${b}&id=${a}&current=${a}`);
    const rows = await rawSql(db).all(
      'SELECT count(*) AS n FROM play_queues',
    );
    assertEquals(Number((rows[0] as { n: bigint }).n), 1);

    const body = await call(app, 'getPlayQueue');
    const queue = body.playQueue as PlayQueuePayload;
    assertEquals(queue.entry.map((s) => s.id), [b, a]);
    assertEquals(queue.position, 0);
  } finally {
    await close();
  }
});

Deno.test('savePlayQueue clears an empty queue', async () => {
  const { app, close } = await setup();
  try {
    assertEquals((await call(app, 'savePlayQueue')).status, 'ok');
    const body = await call(app, 'getPlayQueue');
    assertEquals(body.playQueue, undefined);
  } finally {
    await close();
  }
});
