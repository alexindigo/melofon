// tests/nowplaying.test.ts — M3 amendment: real getNowPlaying. scrobble
// submission=false replaces the (user, client) now_playing row and never
// appends listens; submission=true appends listens and never touches
// now-playing. Entries are server-wide, newest first, Navidrome-shaped
// (username, minutesAgo, playerId, playerName).
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { seedFirstUser } from '../src/users.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createUserService } from '../src/user.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createLibrary } from '../src/library.ts';
import { createListens } from '../src/listens.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createPlayer } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';
import { createNotify } from '../src/notify.ts';
import { loadLayers } from '../src/layers.ts';
import { facade } from '../src/facade.ts';

const AUTH = 'u=admin&p=test&v=1.16.1&c=melofon-test';

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-np-' });
  const store = await openStore(dir);
  const db = store.legacy;
  const cfg = {
    listen: undefined,
    dataDir: dir,
    user: 'admin',
    password: 'test',
    secret: 's3cret',
    version: '0.0.0-test',
  };
  await seedFirstUser(store, cfg);
  const libraries = createLibraries(db);
  await libraries.add('Music', 'tests/fixtures/library');
  await scanLibrary(db);
  const library = createLibrary(db);
  const notify = createNotify();
  const player = createPlayer();
  const nowPlaying = createNowPlaying(store);
  const bag = {
    cfg,
    libraries,
    user: createUserService(store, cfg),
    library,
    annotation: createAnnotation(store),
    listens: createListens(store),
    nowPlaying,
    player,
    playback: createPlayback({ player, nowPlaying, library, cfg }),
    notify,
  };
  const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
  const app = facade(core, await loadLayers({ app: bag }));
  const songIds = (await db.conn.runAndReadAll(
    'SELECT id, title FROM files ORDER BY album_id, track',
  )).getRowObjects() as { id: string; title: string }[];
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

type Envelope = Record<string, unknown> & { status: string };

async function get(
  app: (req: Request) => Promise<Response>,
  op: string,
  extra = '',
  auth = AUTH,
): Promise<Envelope> {
  const res = await app(
    new Request(`http://x/rest/${op}?${auth}&f=json${extra}`),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  return (body as Record<string, Envelope>)['subsonic-response'];
}

async function listensCount(db: {
  conn: { runAndReadAll(sql: string): Promise<unknown> };
}): Promise<number> {
  const rows = (await db.conn.runAndReadAll(
    'SELECT count(*) AS n FROM listens',
  )) as { getRowObjects(): { n: bigint }[] };
  return Number(rows.getRowObjects()[0].n);
}

Deno.test('scrobble submission=false lists the song in getNowPlaying', async () => {
  const { app, db, songIds, close } = await setup();
  try {
    await get(app, 'scrobble', `&id=${songIds[0].id}&submission=false`);
    const body = await get(app, 'getNowPlaying');
    const entries = (body.nowPlaying as { entry: Record<string, unknown>[] })
      .entry;
    assertEquals(entries.length, 1);
    assertEquals(entries[0].title, songIds[0].title);
    assertEquals(entries[0].username, 'admin');
    assertEquals(entries[0].playerName, 'melofon-test');
    assertEquals(entries[0].playerId, 0);
    assertEquals(entries[0].minutesAgo, 0);
    // The amendment: now-playing never appends listens.
    assertEquals(await listensCount(db), 0);
  } finally {
    await close();
  }
});

Deno.test('a new play replaces the same client row; other clients keep theirs', async () => {
  const { app, songIds, close } = await setup();
  try {
    await get(app, 'scrobble', `&id=${songIds[0].id}&submission=false`);
    await get(app, 'scrobble', `&id=${songIds[1].id}&submission=false`);
    let body = await get(app, 'getNowPlaying');
    let entries = (body.nowPlaying as { entry: Record<string, unknown>[] })
      .entry;
    assertEquals(entries.length, 1);
    assertEquals(entries[0].title, songIds[1].title);

    const otherClient = 'u=admin&p=test&v=1.16.1&c=other-client';
    await get(
      app,
      'scrobble',
      `&id=${songIds[0].id}&submission=false`,
      otherClient,
    );
    body = await get(app, 'getNowPlaying');
    entries = (body.nowPlaying as { entry: Record<string, unknown>[] }).entry;
    assertEquals(entries.length, 2);
    assertEquals(
      entries.map((e) => e.playerName).sort(),
      ['melofon-test', 'other-client'],
    );
  } finally {
    await close();
  }
});

Deno.test('submission=true appends listens and leaves now-playing alone', async () => {
  const { app, db, songIds, close } = await setup();
  try {
    await get(app, 'scrobble', `&id=${songIds[0].id}&submission=false`);
    await get(app, 'scrobble', `&id=${songIds[1].id}&submission=true`);
    assertEquals(await listensCount(db), 1);
    const body = await get(app, 'getNowPlaying');
    const entries = (body.nowPlaying as { entry: Record<string, unknown>[] })
      .entry;
    assertEquals(entries.length, 1);
    assertEquals(entries[0].title, songIds[0].title);
  } finally {
    await close();
  }
});

Deno.test('getNowPlaying renders entries as XML', async () => {
  const { app, songIds, close } = await setup();
  try {
    await get(app, 'scrobble', `&id=${songIds[0].id}&submission=false`);
    const res = await app(
      new Request(`http://x/rest/getNowPlaying?${AUTH}`),
    );
    const xml = await res.text();
    assert(xml.includes('<nowPlaying>'));
    assert(xml.includes('username="admin"'));
    assert(xml.includes('minutesAgo="0"'));
    assert(xml.includes('playerName="melofon-test"'));
  } finally {
    await close();
  }
});

Deno.test('playback.reportPlaying emits player; a failed report emits nothing', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-np-emit-' });
  const store = await openStore(dir);
  const db = store.legacy;
  try {
    const cfg = {
      listen: undefined,
      dataDir: dir,
      user: 'admin',
      password: 'test',
      secret: 's3cret',
      version: '0.0.0-test',
    };
    await seedFirstUser(store, cfg);
    const events: string[][] = [];
    const notify = createNotify();
    notify.subscribe((types) => events.push(types));
    const playback = createPlayback({
      player: createPlayer(),
      nowPlaying: createNowPlaying(store),
      library: createLibrary(db),
      cfg,
      notify,
    });

    await playback.reportPlaying({
      username: 'admin',
      client: 'narjo',
      trackId: 'some-track-id',
      streamId: 'stream-1',
    });
    assertEquals(events, [['player']]);

    // A failed report (unknown user) emits nothing.
    await playback.reportPlaying({
      username: 'ghost',
      client: 'narjo',
      trackId: 'some-track-id',
      streamId: 'stream-2',
    }).catch(() => {});
    assertEquals(events, [['player']]);
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});
