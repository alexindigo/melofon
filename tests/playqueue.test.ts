// tests/playqueue.test.ts — M2 Subsonic play queue: savePlayQueue upserts one
// row per user (ids + current + position), getPlayQueue returns entries in
// order with `current` as a string; nothing saved → bare ok envelope.
import { assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openDb } from '../src/db.ts';
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
import { facade } from '../src/facade.ts';

const AUTH = 'u=admin&p=test&v=1.16.1&c=melofon-test';

interface PlayQueuePayload {
  entry: { id: string }[];
  current?: string;
  position?: number;
  changed?: string;
}

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-pq-' });
  const db = await openDb(dir);
  const cfg = {
    listen: undefined,
    dataDir: dir,
    user: 'admin',
    password: 'test',
    secret: 's3cret',
    version: '0.0.0-test',
  };
  await seedFirstUser(db, cfg);
  const libraries = createLibraries(db);
  await libraries.add('Music', 'tests/fixtures/library');
  await scanLibrary(db);
  const bag = {
    cfg,
    libraries,
    user: createUserService(db, cfg),
    library: createLibrary(db),
    annotation: createAnnotation(db),
    listens: createListens(db),
    playlists: createPlaylists(db),
    clientQueue: createClientQueue(db),
  };
  const core = await pathfinder({ roots: ['core/'], app: { db, cfg } });
  const app = facade(core, await loadLayers({ app: bag }));
  const songs = await db.conn.runAndReadAll(
    "SELECT id FROM files WHERE title != '' ORDER BY path",
  );
  const songIds = (songs.getRowObjects() as { id: string }[]).map((r) => r.id);
  return {
    db,
    app,
    songIds,
    close: async () => {
      db.close();
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
    assertEquals(typeof queue.changed, 'string');
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
    const rows = await db.conn.runAndReadAll(
      'SELECT count(*) AS n FROM play_queues',
    );
    assertEquals(Number((rows.getRowObjects()[0] as { n: bigint }).n), 1);

    const body = await call(app, 'getPlayQueue');
    const queue = body.playQueue as PlayQueuePayload;
    assertEquals(queue.entry.map((s) => s.id), [b, a]);
    assertEquals(queue.position, undefined);
  } finally {
    await close();
  }
});

Deno.test('savePlayQueue accepts an empty queue', async () => {
  const { app, close } = await setup();
  try {
    assertEquals((await call(app, 'savePlayQueue')).status, 'ok');
    const body = await call(app, 'getPlayQueue');
    assertEquals((body.playQueue as PlayQueuePayload).entry.length, 0);
  } finally {
    await close();
  }
});
