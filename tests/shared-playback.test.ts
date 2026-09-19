// tests/shared-playback.test.ts — the shared now-playing read across hats:
// an OpenSubsonic-shaped report (real /rest/scrobble) shows on OwnTone
// /api/player as a mirrored synthetic current (engine wins when it has one);
// the engine's play shows on /rest/getNowPlaying; the server queue stays
// server-only. Hats never merge — the projection is core's app.playback.
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
  const player = createPlayer({ notify });
  const nowPlaying = createNowPlaying(db, { notify });
  const library = createLibrary(db);
  const bag = {
    cfg,
    libraries,
    user: createUserService(db, cfg),
    library,
    listens: createListens(db),
    nowPlaying,
    player,
    outputs: createOutputs({ notify }),
    playback: createPlayback({ player, nowPlaying, library, cfg }),
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

Deno.test('a client report mirrors onto OwnTone /api/player; the queue stays server-only', async () => {
  const { onDefault, onHook, events, songs, close } = await setup();
  try {
    // Narjo reports a play (the real OpenSubsonic path).
    const scrobble = await get(
      onDefault,
      `/rest/scrobble?${NARJO}&f=json&id=${songs[0].id}&submission=false`,
    );
    assertEquals(scrobble.status, 200);

    // Core emitted on the hub.
    assertEquals(events, [['player']]);

    // OwnTone /api/player mirrors it: play, synthetic item id, real length.
    const player = await (await get(onHook, '/api/player')).json();
    assertEquals(player.state, 'play');
    assertEquals(player.item_id, -1);
    assertEquals(player.item_length_ms, songs[0].duration_ms);

    // The server queue is untouched.
    const queue = await (await get(onHook, '/api/queue')).json();
    assertEquals(queue.count, 0);
  } finally {
    await close();
  }
});

Deno.test('the engine wins when it has a current item; /rest sees the engine too', async () => {
  const { onDefault, onHook, songs, close } = await setup();
  try {
    // A client report is present…
    await get(
      onDefault,
      `/rest/scrobble?${NARJO}&f=json&id=${songs[0].id}&submission=false`,
    );
    // …but once the engine plays, it wins the player view.
    const albums = await (await get(onHook, '/api/library/albums')).json();
    const tracks = await (await get(
      onHook,
      `/api/library/albums/${albums.items[0].id}/tracks`,
    )).json();
    await post(
      onHook,
      `/api/queue/items/add?uris=library:track:${tracks.items[1].id}`,
    );
    await put(onHook, '/api/player/play');
    const player = await (await get(onHook, '/api/player')).json();
    assertEquals(player.state, 'play');
    assert(
      player.item_id > 0,
      `engine item id, not the sentinel: ${player.item_id}`,
    );

    // And the engine's play is visible on /rest/getNowPlaying alongside Narjo.
    const np = await (await get(
      onDefault,
      `/rest/getNowPlaying?${NARJO}&f=json`,
    )).json();
    const entries = np['subsonic-response'].nowPlaying.entry;
    const melofon = entries.find(
      (e: { playerName: string }) => e.playerName === 'melofon',
    );
    assert(melofon !== undefined, 'engine entry on /rest');
    assertEquals(melofon.title, tracks.items[1].title);
    assert(
      entries.some((e: { playerName: string }) => e.playerName === 'narjo'),
      'client row still listed',
    );

    // OwnTone stop+clear touches the server engine only: the mirror returns.
    await put(onHook, '/api/player/stop');
    await put(onHook, '/api/queue/clear');
    const after = await (await get(onHook, '/api/player')).json();
    assertEquals(after.state, 'play');
    assertEquals(after.item_id, -1);
    const np2 = await (await get(
      onDefault,
      `/rest/getNowPlaying?${NARJO}&f=json`,
    )).json();
    const entries2 = np2['subsonic-response'].nowPlaying.entry;
    assert(
      !entries2.some((e: { playerName: string }) => e.playerName === 'melofon'),
      'engine entry gone after clear',
    );
    assert(
      entries2.some((e: { playerName: string }) => e.playerName === 'narjo'),
      'client row survives server clear',
    );
  } finally {
    await close();
  }
});
