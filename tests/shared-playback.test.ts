// tests/shared-playback.test.ts — two planes, one playback core. Plane B
// (client reports) shows on OpenSubsonic getNowPlaying and emits `nowPlaying` —
// but OwnTone /api/player stays ENGINE (stop/empty when idle; no mirrored
// lie). reportStopped clears a session only when its streamId is still
// current. Plane A (the engine) shows on /rest too, and HA's album select
// yields a real queue item. Hats never merge — the projection is core's.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { songEntries } from './helpers/queue.ts';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { seedFirstUser } from '../src/users.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createUserService } from '../src/user.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createLibrary } from '../src/library.ts';
import { createListens } from '../src/listens.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createOutputs, createPlayer } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';
import { createStream } from '../src/stream.ts';
import { createFileSource } from '../src/file-source.ts';
import { createMedia } from '../src/media.ts';
import { createNotify } from '../src/notify.ts';
import { createBinds } from '../src/binds.ts';
import { facade } from '../src/facade.ts';
import { loadLayers } from '../src/layers.ts';
import { createState } from '../src/state.ts';
import { restored } from './helpers/prepared.ts';
import { reservePorts } from './helpers/ports.ts';

const HOOK = 3689;
const DEFAULT_PORT = 4534;
const NARJO = 'u=admin&p=test&v=1.16.1&c=narjo';

function config(dir: string) {
  return {
    listen: undefined,
    dataDir: dir,
    user: 'admin',
    password: 'test',
    secret: 's3cret',
    version: '0.0.0-test',
  };
}

async function setup(player = createPlayer()) {
  const dir = await restored('shared-playback', async (dir) => {
    const store = await openStore(dir);
    try {
      await seedFirstUser(store, config(dir));
      const libraries = createLibraries(store);
      await libraries.add(
        'Music',
        await Deno.realPath('tests/fixtures/library'),
      );
      await scanLibrary(store);
    } finally {
      await store.close();
    }
  }, 'melofon-sp-');
  const store = await openStore(dir);
  const db = store;
  const cfg = config(dir);
  const libraries = createLibraries(store);
  const events: string[][] = [];
  const notify = createNotify();
  notify.subscribe((types) => events.push(types));
  const nowPlaying = createNowPlaying(store);
  const library = createLibrary(store);
  const outputs = createOutputs({ notify });
  const playback = createPlayback({
    player,
    outputs,
    nowPlaying,
    library,
    cfg,
    notify,
  });
  const bag = {
    state: createState(store),
    cfg,
    libraries,
    user: createUserService(store, cfg),
    library,
    annotation: createAnnotation(store),
    listens: createListens(store),
    nowPlaying,
    player,
    outputs,
    playback,
    stream: createStream(
      createMedia(),
      undefined,
      undefined,
      createFileSource(library),
    ),
    notify,
    binds: createBinds(() => layers, {}),
  };
  const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
  const layers = await loadLayers({ app: bag });
  const onDefault = facade(core, layers);
  const onHook = facade(core, layers, {
    listenPort: HOOK,
    defaultPort: DEFAULT_PORT,
    env: {},
  });
  const songs = (await rawSql(db).all(
    'SELECT id, title, duration_ms FROM files ORDER BY album_id, track',
  )) as { id: string; title: string; duration_ms: number }[];
  return {
    db,
    onDefault,
    onHook,
    playback,
    outputs,
    events,
    songs,
    close: async () => {
      await db.close();
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
    assertEquals(events, [['nowPlaying']]);

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
    assertEquals(events, [['nowPlaying'], ['nowPlaying']]);
    const entries2 = await npEntry(onDefault);
    assertEquals(entries2.length, 1);
    assertEquals(entries2[0].title, songs[1].title);
  } finally {
    await close();
  }
});

Deno.test('a stream open does not report playback or listens; player stays engine', async () => {
  const { db, onDefault, onHook, songs, close } = await setup();
  try {
    const res = await get(
      onDefault,
      `/rest/stream?${NARJO}&f=json&id=${songs[0].id}`,
    );
    assertEquals(res.status, 200);
    await res.body?.cancel();

    // Media delivery is independent of explicit client playback reports.
    const entries = await npEntry(onDefault);
    assertEquals(entries, []);

    // …but stream is not a scrobble: no listens row.
    const listens = (await rawSql(db).all(
      'SELECT count(*) AS n FROM listens',
    )) as { n: bigint }[];
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
    assertEquals(events, [['nowPlaying']]);
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

Deno.test('OwnTone HTTP play/pause/stop projects a server label, never the env user', async () => {
  const s = await setup();
  using ports = reservePorts(2);
  const [restPort, ownPort] = ports.ports;
  ports.release();
  const rest = Deno.serve({
    hostname: '0.0.0.0',
    port: restPort,
    onListen() {},
  }, s.onDefault);
  const own = Deno.serve(
    { hostname: '0.0.0.0', port: ownPort, onListen() {} },
    s.onHook,
  );
  const request = (port: number, path: string, method = 'GET') =>
    fetch(
      `http://melofon.home:${port}${path}`,
      { method, signal: AbortSignal.timeout(5000) },
    );
  const entries = async () =>
    (await (await request(
      restPort,
      `/rest/getNowPlaying?${NARJO}&f=json`,
    )).json())['subsonic-response'].nowPlaying.entry;
  try {
    const addresses = await Deno.resolveDns('melofon.home', 'A');
    assert(
      addresses.length > 0 && addresses.every((ip) => !ip.startsWith('127.')),
    );
    assertEquals(await entries(), []);
    const albums = await (await request(ownPort, '/api/library/albums')).json();
    const add = await request(
      ownPort,
      `/api/queue/items/add?uris=library:album:${
        albums.items[0].id
      }&playback=start&clear=true`,
      'POST',
    );
    assertEquals(add.status, 200);
    await add.body?.cancel();
    const playing = await entries();
    assertEquals(playing.length, 1);
    assertEquals(playing[0].username, 'melofon');
    assertEquals(playing[0].playerId, 0);
    assertEquals(playing[0].playerName, 'melofon');
    assertEquals(playing[0].state, 'playing');
    const serverRow = (await s.playback.nowPlayingView())[0];
    assertEquals(serverRow.kind, 'server');
    assert(serverRow.kind === 'server');
    assertEquals(serverRow.commander, null);
    const pause = await request(ownPort, '/api/player/pause', 'PUT');
    assertEquals(pause.status, 204);
    await pause.body?.cancel();
    const paused = await entries();
    assertEquals(paused[0].state, 'paused');
    assertEquals(paused[0].username, 'melofon');
    assertEquals(await entries(), paused);
    const play = await request(ownPort, '/api/player/play', 'PUT');
    assertEquals(play.status, 204);
    await play.body?.cancel();
    const resumed = await entries();
    assertEquals(resumed[0].state, 'playing');
    assertEquals(resumed[0].username, 'melofon');
    const stop = await request(ownPort, '/api/player/stop', 'PUT');
    assertEquals(stop.status, 204);
    await stop.body?.cancel();
    assertEquals(await entries(), []);
  } finally {
    await Promise.all([rest.shutdown(), own.shutdown()]);
    await s.close();
  }
});

Deno.test('core server row retains truthful clocks, selected speakers and external commander independently', async () => {
  let time = 100_000;
  let monotonic = 0;
  const s = await setup(
    createPlayer({ now: () => time, monotonicNow: () => monotonic }),
  );
  const server = async () => {
    const row = (await s.playback.nowPlayingView()).find((r) =>
      r.kind === 'server'
    );
    assert(row?.kind === 'server');
    return row;
  };
  try {
    const song = await createLibrary(s.db).getSong(s.songs[0].id);
    assert(song);
    s.outputs.register({
      id: 'living',
      name: 'Living room',
      type: 'AirPlay',
      selected: true,
      volume: 40,
      host: '192.0.2.1',
    });
    s.outputs.register({
      id: 'study',
      name: 'Study',
      type: 'AirPlay',
      selected: false,
      volume: 60,
    });
    s.playback.queueAdd([song, song], { play: true }, {
      kind: 'http',
      user: 'alice',
      peer: '192.0.2.2',
      userAgent: 'private diagnostics',
    });
    const first = await server();
    assertEquals(first.label, 'melofon');
    assertEquals(first.commander, 'alice');
    assertEquals(first.speakers, [{ id: 'living', name: 'Living room' }]);
    assertEquals(first.startedAtMs, time);
    assertEquals(first.reportedAtMs, time);
    assertEquals('username' in first, false);
    assertEquals(first.playerId, 1);
    assertEquals(first.playerName, 'melofon');
    assertEquals('source' in first, false);

    time += 500;
    monotonic += 500;
    const later = await server();
    assertEquals(later.startedAtMs, first.startedAtMs);
    assertEquals(later.reportedAtMs, first.reportedAtMs);
    assertEquals(later.positionMs, 500);
    s.playback.pause({ kind: 'internal', via: 'airplay-boot' });
    const paused = await server();
    assertEquals(paused.reportedAtMs, time);
    time += 100;
    monotonic += 100;
    assertEquals(await server(), paused);
    assertEquals(s.playback.lastCommand()?.source.kind, 'internal');
    assertEquals(paused.commander, 'alice');
    s.playback.play();
    assertEquals((await server()).startedAtMs, first.startedAtMs);
    s.playback.seek({ positionMs: song.durationMs! });
    time += 100;
    monotonic += 100;
    s.playback.advanceEnded();
    const next = await server();
    assertEquals(next.commander, 'alice');
    assertEquals(next.startedAtMs, time);
    assertEquals(next.reportedAtMs, time);
    s.outputs.setEnabled(['study']);
    assertEquals((await server()).speakers, [{ id: 'study', name: 'Study' }]);
    s.outputs.unregister('study');
    assertEquals((await server()).speakers, []);

    // Returned facts are snapshots, not handles to the retained state.
    next.commander = 'forged';
    next.speakers.push({ id: 'fake', name: 'fake' });
    assertEquals((await server()).commander, 'alice');
    s.playback.pause({ kind: 'http' });
    assertEquals((await server()).commander, null);
    s.playback.play();
    assertEquals((await server()).commander, null);

    await s.playback.reportPlaying({
      username: 'admin',
      client: 'phone',
      trackId: song.id,
      streamId: 'app-run',
    });
    const app = (await s.playback.nowPlayingView()).find((row) =>
      row.kind === 'app'
    );
    assert(app?.kind === 'app');
    assertEquals(app.username, 'admin');
    assertEquals(app.client, 'phone');
    assert(app.appPlayerId > 0);
    assertEquals('commander' in app, false);
    s.playback.stop();
    assertEquals((await s.playback.nowPlayingView()).map((row) => row.kind), [
      'app',
    ]);
    s.playback.restore({
      queue: songEntries([song]),
      state: 'pause',
      currentIndex: 0,
      positionMs: 250,
      repeat: 'off',
      shuffle: false,
      consume: false,
    });
    const restored = await server();
    assertEquals(restored.startedAtMs, null);
    assertEquals(restored.reportedAtMs, time);
    assertEquals(restored.positionMs, 250);
    assertEquals(restored.commander, null);
  } finally {
    s.playback.close();
    await s.close();
  }
});
