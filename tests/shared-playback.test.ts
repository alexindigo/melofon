// tests/shared-playback.test.ts — two planes, one playback core. Plane B
// (client reports) shows on OpenSubsonic getNowPlaying and emits `player` —
// but OwnTone /api/player stays ENGINE (stop/empty when idle; no mirrored
// lie). reportStopped clears a session only when its streamId is still
// current. Plane A (the engine) shows on /rest too, and HA's album select
// yields a real queue item. Hats never merge — the projection is core's.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openDb } from '../src/db.ts';
import { seedFirstUser } from '../src/users.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createUserService } from '../src/user.ts';
import { createLibrary } from '../src/library.ts';
import { createListens } from '../src/listens.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createOutputs, createPlayer } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';
import { createStream } from '../src/stream.ts';
import { createMedia } from '../src/media.ts';
import { createNotify } from '../src/notify.ts';
import { createBinds } from '../src/binds.ts';
import { facade } from '../src/facade.ts';
import { loadLayers } from '../src/layers.ts';

const HOOK = 3689;
const DEFAULT_PORT = 4534;
const NARJO = 'u=admin&p=test&v=1.16.1&c=narjo';

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-sp-' });
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
  const events: string[][] = [];
  const notify = createNotify();
  notify.subscribe((types) => events.push(types));
  const player = createPlayer();
  const nowPlaying = createNowPlaying(db);
  const library = createLibrary(db);
  const playback = createPlayback({ player, nowPlaying, library, cfg, notify });
  const bag = {
    cfg,
    libraries,
    user: createUserService(db, cfg),
    library,
    listens: createListens(db),
    nowPlaying,
    player,
    outputs: createOutputs({ notify }),
    playback,
    stream: createStream(createMedia(), playback),
    notify,
    binds: createBinds(() => layers, {}),
  };
  const core = await pathfinder({ roots: ['core/'], app: { db, cfg } });
  const layers = await loadLayers({ app: bag });
  const onDefault = facade(core, layers);
  const onHook = facade(core, layers, {
    listenPort: HOOK,
    defaultPort: DEFAULT_PORT,
    env: {},
  });
  const songs = (await db.conn.runAndReadAll(
    'SELECT id, title, duration_ms FROM files ORDER BY album_id, track',
  )).getRowObjects() as { id: string; title: string; duration_ms: number }[];
  return {
    db,
    onDefault,
    onHook,
    playback,
    events,
    songs,
    close: async () => {
      db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

const get = (app: (r: Request) => Promise<Response>, path: string) =>
  app(new Request(`http://x${path}`));
const put = (app: (r: Request) => Promise<Response>, path: string) =>
  app(new Request(`http://x${path}`, { method: 'PUT' }));
const post = (app: (r: Request) => Promise<Response>, path: string) =>
  app(new Request(`http://x${path}`, { method: 'POST' }));

async function npEntry(app: (r: Request) => Promise<Response>) {
  const res = await get(app, `/rest/getNowPlaying?${NARJO}&f=json`);
  const body = await res.json();
  return body['subsonic-response'].nowPlaying.entry;
}

Deno.test('client report: getNowPlaying has it; OwnTone player stays engine; notify fires', async () => {
  const { onDefault, onHook, events, songs, close } = await setup();
  try {
    const scrobble = await get(
      onDefault,
      `/rest/scrobble?${NARJO}&f=json&id=${songs[0].id}&submission=false`,
    );
    assertEquals(scrobble.status, 200);
    assertEquals(events, [['player']]);

    const entries = await npEntry(onDefault);
    assertEquals(entries.length, 1);
    assertEquals(entries[0].title, songs[0].title);
    assertEquals(entries[0].playerName, 'narjo');

    // The OwnTone player is the ENGINE — idle here: no mirrored lie.
    const player = await (await get(onHook, '/api/player')).json();
    assertEquals(player.state, 'stop');
    assertEquals(player.item_id, 0);
    assertEquals(player.item_length_ms, 0);

    // A second report supersedes the session and emits again.
    await get(
      onDefault,
      `/rest/scrobble?${NARJO}&f=json&id=${songs[1].id}&submission=false`,
    );
    assertEquals(events, [['player'], ['player']]);
    const entries2 = await npEntry(onDefault);
    assertEquals(entries2.length, 1);
    assertEquals(entries2[0].title, songs[1].title);
  } finally {
    await close();
  }
});

Deno.test('a stream open reports the play (no listens; player stays engine)', async () => {
  const { db, onDefault, onHook, songs, close } = await setup();
  try {
    const res = await get(
      onDefault,
      `/rest/stream?${NARJO}&f=json&id=${songs[0].id}`,
    );
    assertEquals(res.status, 200);
    await res.body?.cancel();

    // The session shows on getNowPlaying…
    const entries = await npEntry(onDefault);
    assertEquals(entries.length, 1);
    assertEquals(entries[0].title, songs[0].title);

    // …but stream is not a scrobble: no listens row.
    const listens = (await db.conn.runAndReadAll(
      'SELECT count(*) AS n FROM listens',
    )).getRowObjects() as { n: bigint }[];
    assertEquals(Number(listens[0].n), 0);

    // …and the OwnTone player is still the idle engine.
    const player = await (await get(onHook, '/api/player')).json();
    assertEquals(player.state, 'stop');
    assertEquals(player.item_id, 0);
  } finally {
    await close();
  }
});

Deno.test('reportStopped clears only the current streamId', async () => {
  const { onDefault, playback, events, songs, close } = await setup();
  try {
    await playback.reportPlaying({
      username: 'admin',
      client: 'narjo',
      trackId: songs[0].id,
      streamId: 'stream-1',
    });
    // A newer report supersedes: stream-1 is stale now.
    await playback.reportPlaying({
      username: 'admin',
      client: 'narjo',
      trackId: songs[1].id,
      streamId: 'stream-2',
    });
    events.length = 0;

    // Stale completion: session untouched, no emit.
    await playback.reportStopped({ streamId: 'stream-1' });
    assertEquals((await npEntry(onDefault)).length, 1);
    assertEquals(events, []);

    // Current completion: session gone, one emit.
    await playback.reportStopped({ streamId: 'stream-2' });
    assertEquals((await npEntry(onDefault)).length, 0);
    assertEquals(events, [['player']]);
  } finally {
    await close();
  }
});

Deno.test('engine: play shows on /rest; HA album select yields a real queue item', async () => {
  const { onDefault, onHook, close } = await setup();
  try {
    // HA select: clear, add the album, start playback.
    const albums = await (await get(onHook, '/api/library/albums')).json();
    const add = await post(
      onHook,
      `/api/queue/items/add?uris=library:album:${albums.items[0].id}` +
        '&playback=start&clear=true',
    );
    assertEquals(add.status, 200);

    const queue = await (await get(onHook, '/api/queue')).json();
    assert(queue.count > 0, 'queue populated');
    const queueIds = queue.items.map((i: { id: number }) => i.id);

    const player = await (await get(onHook, '/api/player')).json();
    assertEquals(player.state, 'play');
    assert(queueIds.includes(player.item_id), 'item_id is a real queue id');

    // The engine's current appears on /rest as the 'melofon' client.
    const entries = await npEntry(onDefault);
    assert(
      entries.some((e: { playerName: string }) => e.playerName === 'melofon'),
      'engine entry on /rest',
    );

    // Stop: engine current gone from both views.
    await put(onHook, '/api/player/stop');
    const stopped = await (await get(onHook, '/api/player')).json();
    assertEquals(stopped.state, 'stop');
    assertEquals(stopped.item_id, 0);
    assert(
      !(await npEntry(onDefault)).some(
        (e: { playerName: string }) => e.playerName === 'melofon',
      ),
      'engine entry gone after stop',
    );
  } finally {
    await close();
  }
});
