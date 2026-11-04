import { assert, assertEquals } from '@std/assert';
import { apiFixture } from './helpers/api.ts';
import { createOutputs, createPlayer } from '../src/player.ts';
import { createSpeakers } from '../src/speakers.ts';
import { createOutputAdmission } from '../src/output-admission.ts';
import { createAirplayDevices } from '../src/boots/airplay-device.ts';
import { createAirplayBoot } from '../src/boots/airplay.ts';
import type { HelperEventFn } from '../src/boots/airplay-profile.ts';
import type { MdnsService } from '../src/mdns.ts';
import type { Media } from '../src/media.ts';
import { createPlayback } from '../src/playback.ts';
import { createLibrary } from '../src/library.ts';
import { createLibraries } from '../src/libraries.ts';
import { scanLibrary } from '../src/scan.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { wireInt } from '../layers/owntone/payloads.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn: () => boolean) {
  const end = Date.now() + 5000;
  while (!fn()) {
    assert(Date.now() < end, 'speaker outcome timeout');
    await sleep(5);
  }
}
const service: MdnsService = {
  name: '001122334455@Fixture._raop._tcp.local',
  host: 'fixture.local',
  address: '192.0.2.10',
  port: 7000,
  ttlMs: 60000,
  txt: { tp: 'UDP', sf: '200', sr: '44100', ss: '16', ch: '2' },
};

async function setup() {
  let outputs!: ReturnType<typeof createOutputs>;
  let devices!: ReturnType<typeof createAirplayDevices>;
  let playback!: ReturnType<typeof createPlayback>;
  let boot!: ReturnType<typeof createAirplayBoot>;
  let resolve!: (service: MdnsService) => void;
  let lookups = 0, writes = 0, starts = 0;
  const events: HelperEventFn[] = [];
  const f = await apiFixture({
    hats: {
      layersRoot: 'layers',
      extraPorts: 1,
      env: ([port]) => ({ MELOFON_LISTEN_owntone: `${port},${port}` }),
    },
    services: async (f) => {
      assert(f.notify);
      const changed = () => f.notify!.emit(['outputs'], undefined, 'all');
      outputs = createOutputs({ notify: f.notify });
      const admission = createOutputAdmission({
        changed,
        endpoint(id) {
          const row = outputs.get(id);
          return row?.host
            ? { id, protocol: row.type, address: row.host, port: row.port }
            : null;
        },
      });
      devices = createAirplayDevices({
        outputs,
        admission,
        changed,
        resolver: {
          resolve() {
            lookups++;
            return new Promise<MdnsService>((yes) => resolve = yes);
          },
          close() {},
        },
        spawn(event) {
          events.push(event);
          const transport = {
            send: () => Promise.resolve(),
            close: () => Promise.resolve(),
            pcm() {
              writes++;
              return Promise.resolve();
            },
            cancelPcm() {},
            ownsSharedFeed: () => false,
          };
          return {
            transport,
            start() {
              starts++;
              return Promise.resolve();
            },
          };
        },
      });
      const libraries = createLibraries(f.store);
      await libraries.add(
        'Music',
        await Deno.realPath('tests/fixtures/library'),
      );
      await scanLibrary(f.store);
      const library = createLibrary(f.store);
      playback = createPlayback({
        player: createPlayer(),
        library,
        outputs,
        nowPlaying: createNowPlaying(f.store),
        cfg: f.cfg,
        notify: f.notify,
      });
      boot = createAirplayBoot({
        outputs,
        playback,
        devices,
        notify: f.notify,
        retryBackoffMs: [],
        media: {
          decodePcm: () =>
            Promise.resolve({
              async *[Symbol.asyncIterator]() {
                yield new Uint8Array(64).fill(5);
              },
            }),
        } as unknown as Media,
      });
      return {
        library,
        outputs,
        playback,
        speakers: createSpeakers({
          outputs,
          playback,
          adapterView: devices.describe,
        }),
      };
    },
  });
  const own = async (path: string, method = 'GET', body?: unknown) => {
    const r = await fetch(`http://melofon.home:${f.extraPorts[0]}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert(r.ok, await r.clone().text());
    const text = await r.text();
    return text ? JSON.parse(text) : undefined;
  };
  const read = async (credential: string) => {
    const r = await f.get('/api/v1/speakers/1', credential);
    assertEquals(r.status, 200);
    return (await r.json()).speaker;
  };
  const register = () =>
    devices.register({
      id: '1',
      name: 'Fixture',
      type: 'AirPlay',
      host: service.address,
      port: service.port,
      selected: false,
      volume: 100,
    });
  const play = async () => {
    await own('/outputs/set', 'PUT', { outputs: ['1'] });
    const [song] = await createLibrary(f.store).listSongs({
      offset: 0,
      size: 1,
    });
    await own(
      `/queue/items/add?uris=library:track:${wireInt(song.id)}`,
      'POST',
    );
    await own('/player/play', 'PUT');
  };
  return {
    f,
    own,
    read,
    register,
    play,
    devices,
    outputs,
    playback,
    events,
    resolve: (row = service) => resolve(row),
    effects: () => ({ starts, writes, lookups }),
    async close() {
      await boot.close();
      devices.close();
      playback.close();
      await f.close();
    },
  };
}

function socket(url: string, headers: Record<string, string>, own = false) {
  const ws = own
    ? new WebSocket(url, 'notify')
    : new WebSocket(url, { headers });
  const frames: Record<string, unknown>[] = [];
  ws.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
  return {
    frames,
    async ready() {
      await until(() =>
        ws.readyState === WebSocket.OPEN && (own || frames.length > 0)
      );
      if (own) {
        ws.send(JSON.stringify({ notify: ['outputs'] }));
        await sleep(30);
      }
      frames.length = 0;
    },
    async close() {
      if (ws.readyState < WebSocket.CLOSING) ws.close();
      await until(() => ws.readyState === WebSocket.CLOSED);
    },
  };
}

Deno.test('speaker HTTP session/auth views refetch on native speaker and OwnTone output events without granting retries', async () => {
  const t = await setup();
  const sockets: ReturnType<typeof socket>[] = [];
  try {
    await t.f.auth.users.create(t.f.admin.id, {
      username: 'member',
      password: 'password-member',
      role: 'user',
    });
    const cookie = await t.f.login('cookie', 'member', 'password-member');
    const bearer = await t.f.login('bearer', 'member', 'password-member');
    for (const credential of [cookie.credential, bearer.credential]) {
      sockets.push(
        socket(`${t.f.origin.replace('http:', 'ws:')}/api/v1/events`, {
          Origin: t.f.origin,
          ...(credential.startsWith('melofon_session=')
            ? { Cookie: credential }
            : { Authorization: `Bearer ${credential}` }),
        }),
      );
    }
    sockets.push(socket(`ws://melofon.home:${t.f.extraPorts[0]}/`, {}, true));
    for (const ws of sockets) await ws.ready();
    t.register();
    assertEquals((await t.read(bearer.credential)).abilities, null);
    await t.play();
    let row = await t.read(cookie.credential);
    assertEquals(row.state.preparation.state, 'preparing');
    assertEquals(row.state.connection, 'disconnected');
    t.resolve();
    await until(() => t.effects().starts === 1);
    row = await t.read(bearer.credential);
    assertEquals(row.state.preparation.state, 'ready');
    assertEquals(row.state.connection, 'connecting');
    assertEquals(row.abilities, {
      volume: true,
      seek: true,
      pin: true,
      password: false,
      formats: ['pcm'],
    });
    assertEquals(t.effects().writes, 0, 'connecting is not audio delivery');
    for (const ws of sockets) ws.frames.length = 0;
    t.events[0]('state', 'password');
    for (const ws of sockets.slice(0, 2)) {
      await until(() =>
        ws.frames.some((f) =>
          (f.events as Record<string, unknown>)?.speakers !== undefined
        )
      );
      assert(
        !JSON.stringify(ws.frames).includes('authentication_required'),
        'events carry invalidations, not state',
      );
    }
    await until(() =>
      sockets[2].frames.some((f) => (f.notify as string[])?.includes('outputs'))
    );
    row = await t.read(bearer.credential);
    assertEquals(row.state.authentication, 'authentication_required');
    assertEquals(row.state.connection, 'connecting');
    assertEquals((await t.own('/outputs/1')).needs_auth_key, true);
    t.events[0]('state', 'connected');
    await until(() => t.effects().writes > 0);
    row = await t.read(cookie.credential);
    assertEquals(row.state.connection, 'connected');
    assertEquals(row.state.authentication, 'none');
    assertEquals((await t.own('/outputs/1')).needs_auth_key, false);
    t.events[0]('state', 'failed');
    row = await t.read(bearer.credential);
    assertEquals(
      row.state.preparation.state,
      'ready',
      'fresh facts are not a live session',
    );
    assertEquals(row.state.connection, 'failed');
    assertEquals(row.state.error, {
      code: 'transport_failed',
      message: 'Speaker connection failed',
    });
    await sleep(30);
    const effects = t.effects();
    for (let n = 0; n < 3; n++) {
      t.devices.observe('1', service);
      await t.read(bearer.credential);
    }
    t.events[0]('state', 'connected'); // Retired generation cannot clear failure.
    await sleep(30);
    assertEquals(t.effects(), effects);
    assertEquals((await t.read(bearer.credential)).state.connection, 'failed');
    assertEquals(t.playback.playerView().state, 'pause');
    await t.own('/player/play', 'PUT');
    await until(() => t.effects().starts === 2);
    t.events[1]('state', 'connected');
    row = await t.read(bearer.credential);
    assertEquals(row.state.connection, 'connected');
    assertEquals(row.state.error, undefined);
    await t.own('/player/pause', 'PUT');
    row = await t.read(bearer.credential);
    assertEquals(row.state.connection, 'disconnected');
    assertEquals(row.state.authentication, 'none');
    t.events[1]('state', 'password');
    t.events[1]('state', 'connected');
    assertEquals(
      (await t.read(bearer.credential)).state.connection,
      'disconnected',
    );
  } finally {
    for (const ws of sockets) await ws.close();
    await t.close();
  }
});

Deno.test('speaker abilities expire with preparation facts and expiry invalidates clients without starting playback', async () => {
  const t = await setup();
  let ws: ReturnType<typeof socket> | undefined;
  try {
    const { credential } = await t.f.login('bearer');
    t.register();
    ws = socket(`${t.f.origin.replace('http:', 'ws:')}/api/v1/events`, {
      Authorization: `Bearer ${credential}`,
      Origin: t.f.origin,
    });
    await ws.ready();
    t.devices.observe('1', { ...service, ttlMs: 500 });
    assertEquals((await t.read(credential)).abilities.pin, true);
    await until(() =>
      ws!.frames.some((f) =>
        (f.events as Record<string, unknown>)?.speakers !== undefined
      )
    );
    ws.frames.length = 0;
    await until(() =>
      ws!.frames.some((f) =>
        (f.events as Record<string, unknown>)?.speakers !== undefined
      )
    );
    const row = await t.read(credential);
    assertEquals(row.abilities, null);
    assertEquals(row.state.preparation.state, 'unresolved');
    assertEquals(row.state.connection, 'disconnected');
    assertEquals(t.effects(), { starts: 0, writes: 0, lookups: 0 });
    t.devices.observe('1', service);
    assertEquals((await t.read(credential)).abilities.pin, true);
    t.outputs.register({ ...t.outputs.get('1')!, host: '192.0.2.11' });
    const moved = await t.read(credential);
    assertEquals(moved.abilities, null);
    assertEquals(moved.state.preparation.state, 'unresolved');
    assertEquals(moved.state.connection, 'disconnected');
  } finally {
    await ws?.close();
    await t.close();
  }
});
