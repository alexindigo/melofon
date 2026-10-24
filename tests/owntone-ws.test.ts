// tests/owntone-ws.test.ts — the OwnTone notify websocket end to end over a
// REAL socket (an in-process facade call cannot upgrade): Deno.serve on an
// ephemeral port, a WebSocket client offering subprotocol `notify`, REST
// driving the mutations, frames asserting the OwnTone { notify: […] } shape.
// Never binds 3688/3689/4138/4533 — port 0 only.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createOutputs, createPlayer } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createNotify } from '../src/notify.ts';
import { createBinds } from '../src/binds.ts';
import { facade } from '../src/facade.ts';
import { loadLayers } from '../src/layers.ts';
import { createState } from '../src/state.ts';

const HOOK = 3689;
const DEFAULT_PORT = 4534;

async function setup(env: Record<string, string> = {}) {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-otws-' });
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
  const libraries = createLibraries(store);
  await libraries.add('Music', await Deno.realPath('tests/fixtures/library'));
  await scanLibrary(store);
  const notify = createNotify();
  const player = createPlayer();
  const nowPlaying = createNowPlaying(store);
  const library = createLibrary(store);
  const bag = {
    state: createState(store),
    cfg,
    libraries,
    library,
    player,
    outputs: createOutputs({ notify }),
    playback: createPlayback({ player, nowPlaying, library, cfg, notify }),
    notify,
    binds: createBinds(() => layers, env),
  };
  const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
  const layers = await loadLayers({ app: bag });
  const app = facade(core, layers, {
    listenPort: HOOK,
    defaultPort: DEFAULT_PORT,
    env,
  });
  const server = Deno.serve(
    { port: 0, hostname: '127.0.0.1' },
    (req, info) => app(req, info),
  );
  const port = server.addr.port;
  return {
    base: `http://127.0.0.1:${port}`,
    wsBase: `ws://127.0.0.1:${port}`,
    close: async () => {
      await server.shutdown();
      await db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

Deno.test('notify websocket: subscribe, REST mutations, OwnTone frames', async () => {
  const { base, wsBase, close } = await setup();
  const ws = new WebSocket(`${wsBase}/`, ['notify']);
  const frames: string[][] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('ws failed to open'));
      setTimeout(() => reject(new Error('ws open timeout')), 3000);
    });
    // The managed upgrade stamped the subprotocol (pathfinder 0.2.4).
    assertEquals(ws.protocol, 'notify');

    ws.onmessage = (ev) =>
      frames.push((JSON.parse(String(ev.data)) as { notify: string[] }).notify);
    ws.send(JSON.stringify({ notify: ['player', 'queue'] }));
    await new Promise((r) => setTimeout(r, 50)); // let the subscribe land

    // REST drives the mutations: find a track, queue it, play it.
    const albums = await (await fetch(`${base}/api/library/albums`)).json();
    const tracks = await (await fetch(
      `${base}/api/library/albums/${albums.items[0].id}/tracks`,
    )).json();
    await fetch(
      `${base}/api/queue/items/add?uris=library:track:${tracks.items[0].id}`,
      { method: 'POST' },
    );
    await waitFor(() => frames.length >= 1);
    assertEquals(frames[0], ['queue']);

    // volume is not in the filter — its emit must not produce a frame.
    await fetch(`${base}/api/player/volume?volume=61`, { method: 'PUT' });
    await fetch(`${base}/api/player/play`, { method: 'PUT' });
    await waitFor(() => frames.length >= 2);
    assertEquals(frames[1], ['player']);
    assertEquals(frames.length, 2);
  } finally {
    ws.close();
    await close();
  }
});

Deno.test('config websocket_port follows the 3688 claim and its REPLACE_ remap', async () => {
  const plain = await setup();
  try {
    const res = await fetch(`${plain.base}/api/config`);
    assertEquals(res.status, 200);
    assertEquals((await res.json()).websocket_port, 3688);
  } finally {
    await plain.close();
  }
  const remapped = await setup({ MELOFON_LISTEN_REPLACE_3688: '4001' });
  try {
    const res = await fetch(`${remapped.base}/api/config`);
    assertEquals((await res.json()).websocket_port, 4001);
  } finally {
    await remapped.close();
  }
});

Deno.test('GET / without upgrade is 404; a WS without the notify offer does not open', async () => {
  const { base, wsBase, close } = await setup();
  const bad = new WebSocket(`${wsBase}/`, ['bogus']);
  // Attach BEFORE any await — the 404 errors the handshake in milliseconds.
  const outcome = new Promise<string>((resolve) => {
    bad.onopen = () => resolve('open');
    bad.onerror = () => resolve('error');
    setTimeout(() => resolve('timeout'), 3000);
  });
  try {
    const res = await fetch(`${base}/`);
    assertEquals(res.status, 404);
    await res.body?.cancel();

    assertEquals(await outcome, 'error');
    assert(bad.readyState !== WebSocket.OPEN);
  } finally {
    bad.close();
    await close();
  }
});
