// tests/owntone.test.ts — the owntone hat end to end (in-process): OwnTone
// JSON shapes on the 3689 hook (claimed as-is, or 4000 under REPLACE_), the
// player flow (add → play → status), and listen isolation (the default
// listen 404s /api; the owntone listen 404s /rest and /). Fixture library
// per test; no auth on this hat (LAN).
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openDb } from '../src/db.ts';
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
import { createTestAirplayDevices } from './helpers/airplay-devices.ts';

const HOOK = 3689;
const DEFAULT_PORT = 4534;

async function setup(env: Record<string, string> = {}) {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-ot-' });
  const db = await openDb(dir);
  const cfg = {
    listen: undefined,
    dataDir: dir,
    user: 'admin',
    password: 'test',
    secret: 's3cret',
    version: '0.0.0-test',
  };
  const libraries = createLibraries(db);
  await libraries.add('Music', 'tests/fixtures/library');
  await scanLibrary(db);
  const notify = createNotify();
  const outputs = createOutputs({ notify });
  const devices = createTestAirplayDevices(outputs);
  const player = createPlayer();
  const library = createLibrary(db);
  const bag = {
    cfg,
    libraries,
    library,
    player,
    outputs,
    notify,
    binds: createBinds(() => layers, env),
    playback: createPlayback({
      player,
      nowPlaying: createNowPlaying(db),
      library,
      cfg,
    }),
  };
  const core = await pathfinder({
    roots: ['core/'],
    app: {
      db,
      cfg,
      outputs,
      airplay: devices,
      outputAdmission: devices.admission,
    },
  });
  const layers = await loadLayers({ app: bag });
  const forBind = (listenPort: number | undefined, env = {}) =>
    facade(core, layers, {
      listenPort,
      defaultPort: DEFAULT_PORT,
      env,
    });
  const onDefault = facade(core, layers); // the process default listen
  const onHook = forBind(
    env.MELOFON_LISTEN_REPLACE_3689 === undefined
      ? HOOK
      : Number(env.MELOFON_LISTEN_REPLACE_3689),
    env,
  );
  return {
    onDefault,
    onHook,
    forBind,
    outputs,
    close: async () => {
      devices.close();
      db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

const get = (app: (r: Request) => Promise<Response>, path: string) =>
  app(new Request(`http://x${path}`));
const put = (
  app: (r: Request) => Promise<Response>,
  path: string,
  body?: string,
) =>
  app(
    new Request(`http://x${path}`, {
      method: 'PUT',
      ...(body === undefined
        ? {}
        : { body, headers: { 'content-type': 'application/json' } }),
    }),
  );
const post = (app: (r: Request) => Promise<Response>, path: string) =>
  app(new Request(`http://x${path}`, { method: 'POST' }));

Deno.test('GET /api/config on the 3689 hook: websocket_port is the claimed 3688', async () => {
  const { onHook, close } = await setup();
  try {
    const res = await get(onHook, '/api/config');
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.websocket_port, 3688); // the claim, no env remap
    assertEquals(body.library_name, 'Melofon'); // HA test_connection needs it
    assertEquals(body.version, '0.0.0-test');
    assert(body.buildoptions.includes('Websockets'));
    for (const absent of ['Spotify', 'ALSA']) {
      assert(!body.buildoptions.includes(absent), `no ${absent}`);
    }
  } finally {
    await close();
  }
});

Deno.test('GET /api/config answers on 4000 when REPLACE_3689=4000 (and 3689 stays quiet)', async () => {
  const env = { MELOFON_LISTEN_REPLACE_3689: '4000' };
  const { onHook, forBind, close } = await setup(env);
  try {
    const res = await get(onHook, '/api/config');
    assertEquals(res.status, 200);
    const configBody = await res.json();
    // The HTTP hook moved to 4000; the WS claim 3688 is untouched by it.
    assertEquals(configBody.websocket_port, 3688);
    // The claimed port has no candidates under the same env.
    const quiet = await get(forBind(HOOK, env), '/api/config');
    assertEquals(quiet.status, 404);
  } finally {
    await close();
  }
});

Deno.test('GET /api/outputs is an empty list until a boot registers', async () => {
  const { onHook, close } = await setup();
  try {
    const res = await get(onHook, '/api/outputs');
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { outputs: [] });
    // No dummy sink: id 0 is just an unknown id.
    assertEquals((await get(onHook, '/api/outputs/0')).status, 400);
  } finally {
    await close();
  }
});

Deno.test('the OwnTone wire never carries model/recycle fields (plan atv3-session-recycle)', async () => {
  const { onHook, outputs, close } = await setup();
  try {
    // A fully-identified AppleTV3,1: every identity/knob field set.
    outputs.register({
      id: '0',
      name: 'arbat',
      type: 'AirPlay',
      selected: true,
      volume: 100,
      host: '10.4.10.106',
      port: 7000,
      model: 'AppleTV3,1',
      requiresAuth: true,
    });
    const listed = await get(onHook, '/api/outputs');
    const payload =
      ((await listed.json()) as { outputs: Record<string, unknown>[] })
        .outputs[0];
    assertEquals(
      Object.keys(payload).sort(),
      [
        'format',
        'has_password',
        'id',
        'name',
        'needs_auth_key',
        'offset_ms',
        'requires_auth',
        'selected',
        'supported_formats',
        'type',
        'volume',
      ].sort(),
      'exactly the OwnTone output keys — no model, no recycle fields',
    );
    const one = await get(onHook, '/api/outputs/0');
    assertEquals(
      Object.keys((await one.json()) as Record<string, unknown>).sort(),
      Object.keys(payload).sort(),
      'the single-output payload matches the list shape',
    );

    const player = await get(onHook, '/api/player');
    assertEquals(
      Object.keys((await player.json()) as Record<string, unknown>).sort(),
      [
        'consume',
        'item_id',
        'item_length_ms',
        'item_progress_ms',
        'repeat',
        'shuffle',
        'state',
        'volume',
      ].sort(),
      'exactly the eight OwnTone player keys — no last_command, nothing new',
    );
  } finally {
    await close();
  }
});

Deno.test('outputs: get/put/toggle/set on a registered output; unknown-id 400s', async () => {
  const { onHook, outputs, close } = await setup();
  try {
    outputs.register({
      id: '0',
      name: 'test speaker',
      type: 'AirPlay',
      selected: true,
      volume: 100,
    });
    const one = await get(onHook, '/api/outputs/0');
    assertEquals(one.status, 200);
    assertEquals((await one.json()).id, '0');

    assertEquals(
      (await put(onHook, '/api/outputs/0', '{"selected":false,"volume":42}'))
        .status,
      204,
    );
    const after = await get(onHook, '/api/outputs/0');
    assertEquals((await after.json()).selected, false);
    assertEquals((await get(onHook, '/api/outputs/0')).status, 200);

    assertEquals((await put(onHook, '/api/outputs/0/toggle')).status, 204);
    const toggled = await get(onHook, '/api/outputs/0');
    assertEquals((await toggled.json()).selected, true);

    assertEquals(
      (await put(onHook, '/api/outputs/set', '{"outputs":[]}')).status,
      204,
    );
    const disabled = await get(onHook, '/api/outputs/0');
    assertEquals((await disabled.json()).selected, false);
    assertEquals(
      (await put(onHook, '/api/outputs/set', '{"outputs":["0"]}')).status,
      204,
    );

    // Unknown ids and non-digits → 400 (OwnTone's behavior).
    assertEquals((await get(onHook, '/api/outputs/9')).status, 400);
    assertEquals((await get(onHook, '/api/outputs/abc')).status, 400);
    assertEquals((await put(onHook, '/api/outputs/9/toggle')).status, 400);
    assertEquals(
      (await put(onHook, '/api/outputs/set', '{"outputs":["9"]}')).status,
      400,
    );
    assertEquals(
      (await put(onHook, '/api/outputs/0', 'not json')).status,
      400,
    );

    // pin passes through to the boot (never stored on the output row).
    const pins: [string, string][] = [];
    outputs.onCommand((id, cmd) => {
      if (cmd.pin !== undefined) pins.push([id, cmd.pin]);
    });
    assertEquals(
      (await put(onHook, '/api/outputs/0', '{"pin":"1234"}')).status,
      204,
    );
    assertEquals(pins, [['0', '1234']]);
    const pinless = await get(onHook, '/api/outputs/0');
    assert(!('pin' in await pinless.json()));
  } finally {
    await close();
  }
});

Deno.test('POST /_/outputs registers an AirPlay output that /api/outputs lists', async () => {
  const { onHook, close } = await setup();
  try {
    const res = await onHook(
      new Request('http://x/_/outputs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Kitchen ATV',
          type: 'AirPlay',
          host: '192.0.2.10',
        }),
      }),
    );
    assertEquals(res.status, 200);
    const { output } = await res.json();
    assert(/^\d+$/.test(output.id));

    const list = await get(onHook, '/api/outputs');
    assertEquals(list.status, 200);
    const body = await list.json();
    assertEquals(body.outputs.length, 1);
    assertEquals(body.outputs[0].type, 'AirPlay');
    assertEquals(body.outputs[0].name, 'Kitchen ATV');
    assertEquals(body.outputs[0].selected, false);

    // The all-digit id round-trips on the OwnTone routes.
    assertEquals((await get(onHook, `/api/outputs/${output.id}`)).status, 200);
    assertEquals(
      (await put(onHook, `/api/outputs/${output.id}`, '{"selected":true}'))
        .status,
      204,
    );
  } finally {
    await close();
  }
});

Deno.test('library: albums list, album by id, album tracks (thin OwnTone shapes)', async () => {
  const { onHook, close } = await setup();
  try {
    const list = await get(onHook, '/api/library/albums');
    assertEquals(list.status, 200);
    const body = await list.json();
    assertEquals(body.total, 2);
    assertEquals(body.offset, 0);
    assertEquals(body.limit, -1);
    assertEquals(body.items.map((a: { name: string }) => a.name), [
      'Fixture Album',
      'Fixture OST',
    ]);
    const album = body.items[0];
    assertEquals(album.track_count, 3);
    assertEquals(album.artist, 'Fixture Artist');
    assert(/^\d+$/.test(album.id));
    assertEquals(album.uri, `library:album:${album.id}`);

    const got = await get(onHook, `/api/library/albums/${album.id}`);
    assertEquals(got.status, 200);
    assertEquals((await got.json()).name, 'Fixture Album');

    const tracks = await get(onHook, `/api/library/albums/${album.id}/tracks`);
    assertEquals(tracks.status, 200);
    const tbody = await tracks.json();
    assertEquals(tbody.total, 3);
    assertEquals(
      tbody.items.map((t: { title: string }) => t.title),
      ['First Song', 'Second Song', 'Clip'],
    );
    const clip = tbody.items[2];
    assertEquals(clip.media_kind, 'musicvideo');
    assert(/^\d+$/.test(String(clip.id)));
    assertEquals(clip.uri, `library:track:${clip.id}`);

    // Paging slices in the hat.
    const paged = await get(onHook, '/api/library/albums?offset=1&limit=1');
    const pbody = await paged.json();
    assertEquals(pbody.total, 2);
    assertEquals(pbody.items.length, 1);
    assertEquals(pbody.items[0].name, 'Fixture OST');

    // Unknown / malformed ids.
    assertEquals((await get(onHook, '/api/library/albums/1')).status, 404);
    assertEquals((await get(onHook, '/api/library/albums/abc')).status, 400);
  } finally {
    await close();
  }
});

Deno.test('player flow: add by track uri → play → status reports play + item', async () => {
  const { onHook, close } = await setup();
  try {
    // Play on an empty queue: 204, state stays stop.
    assertEquals((await put(onHook, '/api/player/play')).status, 204);
    let status = await (await get(onHook, '/api/player')).json();
    assertEquals(status.state, 'stop');
    assertEquals(status.item_id, 0);

    // Find a track id through the library.
    const albums = await (await get(onHook, '/api/library/albums')).json();
    const tracks = await (await get(
      onHook,
      `/api/library/albums/${albums.items[0].id}/tracks`,
    )).json();
    const trackId = tracks.items[0].id;

    const added = await post(
      onHook,
      `/api/queue/items/add?uris=library:track:${trackId}`,
    );
    assertEquals(added.status, 200);
    const abody = await added.json();
    assertEquals(abody.count, 1);
    assertEquals(abody.items[0].track_id, trackId);
    assertEquals(abody.items[0].position, 0);
    const itemId = abody.items[0].id;

    assertEquals((await put(onHook, '/api/player/play')).status, 204);
    status = await (await get(onHook, '/api/player')).json();
    assertEquals(status.state, 'play');
    assertEquals(status.item_id, itemId);
    assertEquals(status.item_length_ms, tracks.items[0].length_ms);

    // The queue listing carries the same item.
    const queue = await (await get(onHook, '/api/queue')).json();
    assertEquals(queue.count, 1);
    assertEquals(queue.items[0].id, itemId);
    assertEquals(queue.items[0].title, 'First Song');

    // Pause / toggle / stop.
    assertEquals((await put(onHook, '/api/player/pause')).status, 204);
    assertEquals(
      (await (await get(onHook, '/api/player')).json()).state,
      'pause',
    );
    assertEquals((await put(onHook, '/api/player/toggle')).status, 204);
    assertEquals(
      (await (await get(onHook, '/api/player')).json()).state,
      'play',
    );
    assertEquals((await put(onHook, '/api/player/stop')).status, 204);
    status = await (await get(onHook, '/api/player')).json();
    assertEquals(status.state, 'stop');
    assertEquals(status.item_progress_ms, 0);
    assertEquals(status.item_id, 0); // stopped: no current (no fallback)

    // Clear.
    assertEquals((await put(onHook, '/api/queue/clear')).status, 204);
    status = await (await get(onHook, '/api/player')).json();
    assertEquals(status.item_id, 0);
  } finally {
    await close();
  }
});

Deno.test('player flow: add a whole album uri; next/previous walk it', async () => {
  const { onHook, close } = await setup();
  try {
    const albums = await (await get(onHook, '/api/library/albums')).json();
    const added = await post(
      onHook,
      `/api/queue/items/add?uris=library:album:${
        albums.items[0].id
      }&playback=start`,
    );
    assertEquals(added.status, 200);
    assertEquals((await added.json()).count, 3);
    let status = await (await get(onHook, '/api/player')).json();
    assertEquals(status.state, 'play');

    assertEquals((await put(onHook, '/api/player/next')).status, 204);
    assertEquals((await put(onHook, '/api/player/previous')).status, 204);
    status = await (await get(onHook, '/api/player')).json();
    assertEquals(status.state, 'play');
  } finally {
    await close();
  }
});

Deno.test('player knobs: volume (master + output), seek, shuffle/repeat/consume', async () => {
  const { onHook, outputs, close } = await setup();
  try {
    assertEquals(
      (await put(onHook, '/api/player/volume?volume=33')).status,
      204,
    );
    assertEquals((await (await get(onHook, '/api/player')).json()).volume, 33);
    assertEquals((await put(onHook, '/api/player/volume?step=-3')).status, 204);
    assertEquals((await (await get(onHook, '/api/player')).json()).volume, 30);
    outputs.register({
      id: '0',
      name: 'test speaker',
      type: 'AirPlay',
      selected: true,
      volume: 100,
    });
    assertEquals(
      (await put(onHook, '/api/player/volume?volume=42&output_id=0')).status,
      204,
    );
    assertEquals(
      (await (await get(onHook, '/api/outputs/0')).json()).volume,
      42,
    );
    assertEquals((await put(onHook, '/api/player/volume')).status, 400);

    // Seek on an empty queue → 500 (OwnTone's); with an item → 204 + play.
    assertEquals(
      (await put(onHook, '/api/player/seek?position_ms=1000')).status,
      500,
    );
    const albums = await (await get(onHook, '/api/library/albums')).json();
    const tracks = await (await get(
      onHook,
      `/api/library/albums/${albums.items[0].id}/tracks`,
    )).json();
    await post(
      onHook,
      `/api/queue/items/add?uris=library:track:${tracks.items[0].id}`,
    );
    assertEquals(
      (await put(onHook, '/api/player/seek?position_ms=1000')).status,
      204,
    );
    const status = await (await get(onHook, '/api/player')).json();
    assertEquals(status.state, 'play');
    assert(status.item_progress_ms >= 1000);
    assertEquals((await put(onHook, '/api/player/seek')).status, 400);

    assertEquals(
      (await put(onHook, '/api/player/shuffle?state=true')).status,
      204,
    );
    assertEquals(
      (await put(onHook, '/api/player/repeat?state=all')).status,
      204,
    );
    assertEquals(
      (await put(onHook, '/api/player/consume?state=true')).status,
      204,
    );
    const knobs = await (await get(onHook, '/api/player')).json();
    assertEquals(knobs.shuffle, true);
    assertEquals(knobs.repeat, 'all');
    assertEquals(knobs.consume, true);
    assertEquals(
      (await put(onHook, '/api/player/repeat?state=bogus')).status,
      400,
    );
    assertEquals((await put(onHook, '/api/player/shuffle')).status, 400);
  } finally {
    await close();
  }
});

Deno.test('queue add: uris only — missing, malformed, unknown, expression', async () => {
  const { onHook, close } = await setup();
  try {
    assertEquals((await post(onHook, '/api/queue/items/add')).status, 400);
    assertEquals(
      (await post(
        onHook,
        '/api/queue/items/add?expression=media_kind+is+music',
      ))
        .status,
      400,
    );
    assertEquals(
      (await post(onHook, '/api/queue/items/add?uris=spotify:track:xyz'))
        .status,
      400,
    );
    assertEquals(
      (await post(onHook, '/api/queue/items/add?uris=library:track:1')).status,
      404,
    );
    assertEquals(
      (await post(onHook, '/api/queue/items/add?uris=library:album:1')).status,
      404,
    );
  } finally {
    await close();
  }
});

Deno.test('listen isolation: default 404s /api; the hook 404s /rest and /; /_/ everywhere', async () => {
  const { onDefault, onHook, close } = await setup();
  try {
    // The owntone hat is not a candidate on the default listen.
    assertEquals((await get(onDefault, '/api/player')).status, 404);
    assertEquals((await get(onDefault, '/api/config')).status, 404);
    // …but the default listen still answers / and /rest stays opensubsonic's.
    assertEquals((await get(onDefault, '/')).status, 200);

    // The opensubsonic hat is not a candidate on the 3689 hook.
    assertEquals((await get(onHook, '/rest/ping')).status, 404);
    // No Vue on the hook: / is the hat's business there, and the hat has none.
    assertEquals((await get(onHook, '/')).status, 404);

    // Core's own tree answers on every listen.
    assertEquals((await get(onHook, '/_/health')).status, 200);
    assertEquals((await get(onDefault, '/_/health')).status, 200);
  } finally {
    await close();
  }
});
