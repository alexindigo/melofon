import { assert, assertEquals, assertRejects } from '@std/assert';
import { PlaybackError } from '../src/playback-errors.ts';
import { apiFixture } from './helpers/api.ts';
import { createOutputs, createPlayer, planRestore } from '../src/player.ts';
import { songEntries, songResolver } from './helpers/queue.ts';
import { createPersistence } from '../src/persistence.ts';
import { createPlayback } from '../src/playback.ts';
import { createSpeakers } from '../src/speakers.ts';
import { createAirplayDevices } from '../src/boots/airplay-device.ts';
import { createAirplayBoot } from '../src/boots/airplay.ts';
import { createLibrary } from '../src/library.ts';
import { createLibraries } from '../src/libraries.ts';
import { scanLibrary } from '../src/scan.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import type { Media } from '../src/media.ts';
import type { MdnsService } from '../src/mdns.ts';
import type { HelperEventFn } from '../src/boots/airplay.ts';
import { wireInt } from '../layers/owntone/payloads.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn: () => boolean) {
  const end = Date.now() + 5000;
  while (!fn()) {
    assert(Date.now() < end, 'target outcome timeout');
    await sleep(5);
  }
}
function service(id = '1'): MdnsService {
  return {
    name: `${id.padStart(12, '0')}@Target._raop._tcp.local`,
    host: `target-${id}.local`,
    address: `192.0.2.${id}`,
    port: 7000,
    ttlMs: 60000,
    txt: { tp: 'UDP', sr: '44100', ss: '16', ch: '2' },
  };
}
async function setup(storeDir?: string, retryPolicy?: string) {
  let outputs!: ReturnType<typeof createOutputs>;
  let devices!: ReturnType<typeof createAirplayDevices>;
  let playback!: ReturnType<typeof createPlayback>;
  let boot!: ReturnType<typeof createAirplayBoot>;
  let speakers!: ReturnType<typeof createSpeakers>;
  let library!: ReturnType<typeof createLibrary>;
  let persistence: ReturnType<typeof createPersistence> | undefined;
  let lookups = 0;
  let preparationGate: Promise<void> | undefined;
  let preparationFailure = false, preparationCalls = 0;
  const preparationSignals: AbortSignal[] = [];
  const pending: { resolve(row: MdnsService): void; signal: AbortSignal }[] =
    [];
  const sessions: { event: HelperEventFn; writes: number; closed: boolean }[] =
    [];
  const f = await apiFixture({
    storeDir,
    hats: {
      layersRoot: 'layers',
      extraPorts: 1,
      env: ([port]) => ({ MELOFON_LISTEN_owntone: `${port},${port}` }),
    },
    services: async (f) => {
      assert(f.notify);
      persistence = storeDir ? createPersistence(f.store) : undefined;
      outputs = createOutputs({ notify: f.notify, persistence });
      const savedOutputs = await persistence?.loadOutputs() ?? [];
      devices = createAirplayDevices({
        outputs,
        changed: () => f.notify!.emit(['outputs'], undefined, 'all'),
        resolver: {
          resolve(_address, _port, signal) {
            lookups++;
            return new Promise<MdnsService>((resolve) =>
              pending.push({ resolve, signal: signal! })
            );
          },
          close() {},
        },
        spawn(event) {
          const session = { event, writes: 0, closed: false };
          sessions.push(session);
          return {
            transport: {
              send: () => Promise.resolve(),
              close() {
                session.closed = true;
                return Promise.resolve();
              },
              pcm() {
                session.writes++;
                return Promise.resolve();
              },
              cancelPcm() {},
              ownsSharedFeed: () => false,
            },
            start: () => Promise.resolve(),
          };
        },
      });
      const libraries = createLibraries(f.store);
      if (!(await libraries.list()).length) {
        await libraries.add(
          'Music',
          await Deno.realPath('tests/fixtures/library'),
        );
      }
      await scanLibrary(f.store);
      library = createLibrary(f.store);
      speakers = createSpeakers({
        outputs,
        state: f.state,
        playback: { pause: (source) => playback.pause(source) },
        adapterView: devices.describe,
        prepare: devices.preparePlayback,
        retry: (id) => boot.retry(id),
      });
      playback = createPlayback({
        player: createPlayer(),
        outputs,
        library,
        nowPlaying: createNowPlaying(f.store),
        cfg: f.cfg,
        notify: f.notify,
        targets: {
          hasPlaybackTarget: speakers.hasPlaybackTarget,
          async preparePlayback(signal) {
            preparationCalls++;
            preparationSignals.push(signal);
            if (preparationFailure) {
              await sleep(2);
              throw new PlaybackError('target_unavailable', 'Unavailable');
            }
            if (preparationGate) await preparationGate;
            await speakers.preparePlayback(signal);
          },
        },
        persistence,
      });
      for (const row of savedOutputs) devices.register(row);
      if (persistence) {
        const snapshot = await planRestore({
          queue: await persistence.loadQueue(),
          saved: await persistence.loadPlayerState(),
          resolve: songResolver(library.getSong),
          nowMs: Date.now(),
          maxAgeMs: 300000,
          selectedOutputPresent: outputs.list().some((row) => row.selected),
        });
        if (snapshot) await playback.restore(snapshot);
      }
      boot = createAirplayBoot({
        outputs,
        playback,
        devices,
        notify: f.notify,
        ...(retryPolicy === undefined
          ? { retryBackoffMs: [] }
          : { state: f.state }),
        media: {
          decodePcm: () =>
            Promise.resolve({
              async *[Symbol.asyncIterator]() {
                for (let n = 0; n < 1000; n++) {
                  await sleep(2);
                  yield new Uint8Array(64).fill(5);
                }
              },
            }),
        } as unknown as Media,
      });
      if (retryPolicy !== undefined) {
        await f.state.set('airplay.retry', retryPolicy);
      }
      return { library, outputs, playback, speakers };
    },
  });
  const own = (path: string, method = 'PUT', body?: unknown) =>
    fetch(
      `http://melofon.home:${f.extraPorts[0]}/api${path}`,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      },
    );
  const ok = async (path: string, method = 'PUT', body?: unknown) => {
    const r = await own(path, method, body);
    assert(r.ok, await r.clone().text());
    await r.text();
  };
  const songs = await library.listSongs({ offset: 0, size: 2 });
  const uri = `library:track:${wireInt(songs[0].id)}`;
  return {
    f,
    outputs,
    devices,
    playback,
    speakers,
    sessions,
    pending,
    songs,
    uri,
    own,
    ok,
    lookups: () => lookups,
    preparationCalls: () => preparationCalls,
    preparationSignals,
    failPreparation: () => {
      preparationFailure = true;
    },
    holdPreparation() {
      let release!: () => void;
      preparationGate = new Promise<void>((resolve) => release = resolve);
      return () => {
        preparationGate = undefined;
        release();
      };
    },
    register(id = '1', observed = true) {
      const row = service(id);
      devices.register(
        {
          id,
          name: id,
          type: 'AirPlay',
          host: row.address,
          port: row.port,
          volume: 100,
          selected: true,
        },
        undefined,
        observed ? row : undefined,
      );
    },
    drain: () => persistence?.drain(),
    async close() {
      await boot.close();
      devices.close();
      await playback.close();
      await persistence?.drain();
      await f.close();
    },
  };
}

Deno.test('OwnTone refuses every nonempty no-target start without changing queue, bookmark or options', async () => {
  const t = await setup();
  try {
    await t.ok('/player/play'); // Empty queue remains a no-op.
    await t.ok(`/queue/items/add?uris=${t.uri}`, 'POST');
    const queue = t.playback.queueView();
    for (
      const path of [
        '/player/play',
        '/player/toggle',
        '/player/next',
        '/player/previous',
        '/player/seek?position_ms=1000',
        '/player/seek?seek_ms=1000',
        `/queue/items/add?uris=${t.uri}&clear=true&shuffle=true&playback=start`,
      ]
    ) {
      const response = await t.own(
        path,
        path.startsWith('/queue') ? 'POST' : 'PUT',
      );
      assertEquals(response.status, 500, `${path}: ${await response.text()}`);
      assertEquals(t.playback.queueView(), queue);
      assertEquals(t.playback.playerView().state, 'stop');
      assertEquals(t.playback.playerView().itemProgressMs, 0);
      assertEquals(t.playback.playerView().shuffle, false);
    }
    await sleep(30);
    assertEquals(t.playback.playerView().itemProgressMs, 0);
    assertEquals(t.lookups(), 0);
    assertEquals(t.sessions.length, 0);
  } finally {
    await t.close();
  }
});

Deno.test('known gone selected speaker refuses immediately while unknown restored targets get bounded preparation', async () => {
  const t = await setup();
  try {
    t.register();
    await t.ok(`/queue/items/add?uris=${t.uri}&playback=start`, 'POST');
    await until(() => t.sessions.length === 1);
    t.sessions[0].event('state', 'connected');
    await until(() => t.sessions[0].writes > 0);
    await t.ok('/player/pause');
    await until(() => t.sessions[0].closed);
    t.devices.withdraw('1');
    const bookmark = t.playback.playerView().itemProgressMs;
    const queue = t.playback.queueView();
    const response = await t.own('/player/play');
    assertEquals(response.status, 500);
    assert((await response.text()).includes('unavailable'));
    assertEquals(t.lookups(), 0);
    assertEquals(t.outputs.get('1')?.selected, true);
    assertEquals(t.playback.queueView(), queue);
    await sleep(25);
    assertEquals(t.playback.playerView().itemProgressMs, bookmark);
    // A successful explicit retry is fresh evidence, even with browsing off.
    const { credential } = await t.f.login('bearer');
    const retry = t.f.json('/api/v1/speakers/1/retry', 'POST', {}, credential);
    await until(() => t.pending.length === 1);
    t.pending[0].resolve(service());
    const retried = await retry;
    assertEquals(retried.status, 200);
    await retried.text();
    await t.ok('/player/play');
    await until(() => t.sessions.length === 2);
    t.sessions[1].event('state', 'connected');
    await t.ok('/player/pause');
    await until(() => t.sessions[1].closed);
    const refreshedBookmark = t.playback.playerView().itemProgressMs;
    await t.ok('/outputs/set', 'PUT', { outputs: [] });
    t.register('2', false);
    await t.f.state.set('speakers.preparationSeconds', '0.03');
    const unavailable = await t.own('/player/play');
    assertEquals(unavailable.status, 500);
    await unavailable.text();
    assertEquals(t.lookups(), 2);
    assert(t.pending[1].signal.aborted);
    t.pending[1].resolve(service('2'));
    await sleep(25);
    assertEquals(t.sessions.length, 2);
    assertEquals(t.playback.playerView().itemProgressMs, refreshedBookmark);
    assertEquals(t.playback.queueView(), queue);
  } finally {
    await t.close();
  }
});

Deno.test('play waits for preparation before committing, and one prepared peer suffices', async () => {
  const t = await setup();
  try {
    t.register('1', false);
    await t.ok(`/queue/items/add?uris=${t.uri}`, 'POST');
    let done = false;
    const play = t.own('/player/play').then(async (response) => {
      assertEquals(response.status, 204, await response.text());
      done = true;
    });
    await until(() => t.pending.length === 1);
    assertEquals(done, false);
    assertEquals(t.playback.playerView().state, 'stop');
    assertEquals(t.sessions.length, 0);
    t.pending[0].resolve(service());
    await play;
    await until(() => t.sessions.length === 1);
    t.sessions[0].event('state', 'connected');
    await until(() => t.sessions[0].writes > 0);
    t.register('2', false);
    await t.ok('/player/previous');
    assertEquals(t.playback.playerView().state, 'play');
    assertEquals(t.outputs.get('2')?.selected, true);
  } finally {
    await t.close();
  }
});

Deno.test('pause, stop, clear, deselect, forget and endpoint change defeat late preflight without clearing an old queue', async () => {
  for (
    const action of ['pause', 'stop', 'clear', 'deselect', 'forget', 'endpoint']
  ) {
    const t = await setup();
    try {
      t.register('1', false);
      if (action === 'forget') await t.outputs.adopt('1');
      await t.ok(`/queue/items/add?uris=${t.uri}`, 'POST');
      const queue = t.playback.queueView();
      const start = t.own(
        `/queue/items/add?uris=${t.uri}&clear=true&playback=start`,
        'POST',
      );
      await until(() => t.pending.length === 1);
      if (action === 'pause' || action === 'stop') {
        await t.ok(`/player/${action}`);
      } else if (action === 'clear') await t.ok('/queue/clear');
      else if (action === 'deselect') {
        await t.ok('/outputs/set', 'PUT', { outputs: [] });
      } else if (action === 'forget') await t.speakers.forget('1');
      else t.devices.register({ ...t.outputs.get('1')!, host: '192.0.2.9' });
      const response = await start;
      assertEquals(response.status, 500, action);
      assert((await response.text()).includes('cancelled'), action);
      assert(t.pending[0].signal.aborted, action);
      t.pending[0].resolve(service());
      await sleep(20);
      assertEquals(t.sessions.length, 0, action);
      assertEquals(t.playback.playerView().state, 'stop', action);
      if (action !== 'clear') {
        assertEquals(t.playback.queueView(), queue, action);
      } else assertEquals(t.playback.queueView().items, []);
    } finally {
      await t.close();
    }
  }
});

Deno.test('last deselect pauses every selection path; discovery loss preserves a connected peer until its later failure', async () => {
  for (const path of ['/outputs/set', '/outputs/1/toggle', '/outputs/1']) {
    const t = await setup();
    try {
      t.register();
      await t.ok(`/queue/items/add?uris=${t.uri}&playback=start`, 'POST');
      await until(() => t.sessions.length === 1);
      t.sessions[0].event('state', 'connected');
      await until(() => t.sessions[0].writes > 0);
      t.devices.withdraw('1');
      assertEquals(t.playback.playerView().state, 'play');
      await t.ok(
        path,
        'PUT',
        path.endsWith('/set')
          ? { outputs: [] }
          : path.endsWith('/1')
          ? { selected: false }
          : undefined,
      );
      assertEquals(t.playback.playerView().state, 'pause');
      const bookmark = t.playback.playerView().itemProgressMs;
      await sleep(20);
      assertEquals(t.playback.playerView().itemProgressMs, bookmark);
      assertEquals(t.playback.queueView().items.length, 1);
      t.sessions[0].event('state', 'connected');
      assertEquals(t.playback.playerView().state, 'pause');
    } finally {
      await t.close();
    }
  }
});

Deno.test('later transport and auth failures pause only when no healthy peer remains and stay visible over native HTTP', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login('bearer');
    t.register('1');
    t.register('2');
    await t.ok(`/queue/items/add?uris=${t.uri}&playback=start`, 'POST');
    await until(() => t.sessions.length === 2);
    for (const session of t.sessions) session.event('state', 'connected');
    await until(() => t.sessions[0].writes > 0);
    assertEquals(t.sessions[1].writes, 0, 'one shared source writer');
    t.sessions[0].event('state', 'password');
    assertEquals(t.playback.playerView().state, 'play');
    const sourceWrites = t.sessions[0].writes;
    await until(() => t.sessions[0].writes > sourceWrites);
    t.sessions[1].event('state', 'failed');
    assertEquals(t.playback.playerView().state, 'pause');
    const bookmark = t.playback.playerView().itemProgressMs;
    await sleep(20);
    assertEquals(t.playback.playerView().itemProgressMs, bookmark);
    const response = await t.f.get('/api/v1/speakers', credential);
    const rows = (await response.json()).speakers;
    assert(
      rows.some((row: { state: { authentication: string } }) =>
        row.state.authentication === 'authentication_required'
      ),
    );
    assert(
      rows.some((row: { state: { connection: string } }) =>
        row.state.connection === 'failed'
      ),
    );
    await t.ok('/player/pause'); // Explicit pause defeats a late auth completion.
    t.sessions[0].event('state', 'connected');
    await sleep(20);
    assertEquals(t.playback.playerView().state, 'pause');
    assertEquals(t.playback.queueView().items.length, 1);
  } finally {
    await t.close();
  }
});

Deno.test('core restore pauses safely without prepared targets and automatic advance preserves the queue on target loss', async () => {
  const t = await setup();
  try {
    const snapshot = {
      queue: songEntries(t.songs),
      state: 'play' as const,
      currentIndex: 0,
      positionMs: 500,
      repeat: 'single' as const,
      shuffle: false,
      consume: false,
    };
    await t.playback.restore(snapshot);
    assertEquals(t.playback.playerView().state, 'pause');
    assertEquals(t.playback.playerView().itemProgressMs, 500);
    await assertRejects(
      async () => {
        await t.playback.play();
      },
      PlaybackError,
      'Select a speaker',
    );
    t.register();
    await t.playback.play();
    await until(() => t.sessions.length === 1);
    t.sessions[0].event('state', 'connected');
    const queue = t.playback.queueView();
    await t.playback.seek({ positionMs: t.songs[0].durationMs! });
    // Discovery without a connected session is genuinely gone, not a new room.
    await t.ok('/player/pause');
    await until(() => t.sessions[0].closed);
    t.devices.withdraw('1');
    await t.playback.advanceEnded();
    assertEquals(t.playback.playerView().state, 'pause');
    assertEquals(t.playback.queueView(), queue);
    assertEquals(t.outputs.get('1')?.selected, true);
  } finally {
    await t.close();
  }
});

Deno.test('automatic repeat, consume and next transitions validate before mutating the engine', async () => {
  const t = await setup();
  try {
    for (const mode of ['off', 'all', 'single', 'consume'] as const) {
      let allowed = true, preparations = 0, clock = 0;
      const core = createPlayback({
        player: createPlayer({ monotonicNow: () => clock }),
        library: createLibrary(t.f.store),
        nowPlaying: createNowPlaying(t.f.store),
        cfg: t.f.cfg,
        targets: {
          hasPlaybackTarget: () => allowed,
          preparePlayback() {
            preparations++;
            return allowed ? Promise.resolve() : Promise.reject(
              new PlaybackError('target_unavailable', 'Unavailable'),
            );
          },
        },
      });
      try {
        await core.restore({
          queue: songEntries(t.songs),
          state: 'play',
          currentIndex: 0,
          positionMs: 0,
          repeat: mode === 'consume' ? 'off' : mode,
          consume: mode === 'consume',
          shuffle: false,
        });
        const queue = core.queueView();
        allowed = false;
        clock = t.songs[0].durationMs! + 10;
        await core.advanceEnded();
        assertEquals(preparations, 2, mode);
        assertEquals(core.playerView().state, 'pause', mode);
        assertEquals(core.playerView().current?.reference, {
          kind: 'song',
          id: t.songs[0].id,
        }, mode);
        assertEquals(core.queueView(), queue, mode);
      } finally {
        await core.close();
      }
    }
  } finally {
    await t.close();
  }
});

Deno.test('store/server-service reopen keeps adopted selection and queue but restores an unreachable target paused', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-target-restart-' });
  let t: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    t = await setup(dir);
    await t.f.state.set('speakers.preparationSeconds', '0.03');
    t.register();
    await t.outputs.adopt('1');
    await t.ok(`/queue/items/add?uris=${t.uri}&playback=start`, 'POST');
    await until(() => t!.sessions.length === 1);
    t.sessions[0].event('state', 'connected');
    await t.playback.seek({ positionMs: 500 });
    await t.drain();
    const saved = await t.f.store.playback.loadPlayerState();
    assertEquals(saved?.state, 'play');
    await t.close();
    t = undefined;
    t = await setup(dir);
    const { credential } = await t.f.login('cookie');
    const response = await t.f.get('/api/v1/speakers/1', credential);
    const row = (await response.json()).speaker;
    assertEquals([row.adopted, row.discovered, row.selected], [
      true,
      false,
      true,
    ]);
    assertEquals(t.playback.playerView().state, 'pause');
    assertEquals(t.playback.playerView().itemProgressMs, saved!.positionMs);
    assertEquals(
      t.playback.queueView().items.map((entry) =>
        entry.reference.kind === 'song' ? entry.reference.id : null
      ),
      [
        t.songs[0].id,
      ],
    );
    await sleep(25);
    assertEquals(t.playback.playerView().itemProgressMs, saved!.positionMs);
    assertEquals(t.sessions.length, 0);
    assertEquals(t.lookups(), 1);
    assert(t.pending[0].signal.aborted);
    t.pending[0].resolve(service());
    await sleep(25);
    assertEquals(t.sessions.length, 0);
  } finally {
    await t?.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('auth recovery awaits guarded resume before PCM, and newer Pause or Stop defeats its authority', async () => {
  for (const action of ['resume', 'pause', 'stop']) {
    const t = await setup();
    let release = () => {};
    try {
      t.register();
      await t.ok(`/queue/items/add?uris=${t.uri}&playback=start`, 'POST');
      await until(() => t.sessions.length === 1);
      const session = t.sessions[0];
      session.event('state', 'password');
      assertEquals(t.playback.playerView().state, 'pause');
      release = t.holdPreparation();
      session.event('state', 'connected');
      await sleep(20);
      assertEquals(t.playback.playerView().state, 'pause');
      assertEquals(session.writes, 0);
      assertEquals(session.closed, false);
      if (action !== 'resume') await t.ok(`/player/${action}`);
      release();
      if (action === 'resume') {
        await until(() => session.writes > 0);
        assertEquals(t.playback.playerView().state, 'play');
        assertEquals(session.closed, false);
      } else {
        await sleep(30);
        assertEquals(t.playback.playerView().state, action);
        assertEquals(session.writes, 0);
        assertEquals(session.closed, true);
      }
      assertEquals(t.sessions.length, 1);
      assertEquals(t.playback.queueView().items.length, 1);
    } finally {
      release();
      await t.close();
    }
  }
});

Deno.test('failed guarded retry resume consumes its grant without unbounded preparation', async () => {
  const t = await setup();
  try {
    t.register();
    await t.ok(`/queue/items/add?uris=${t.uri}&playback=start`, 'POST');
    await until(() => t.sessions.length === 1);
    t.sessions[0].event('state', 'failed');
    assertEquals(t.playback.playerView().state, 'pause');
    t.failPreparation();
    const { credential } = await t.f.login('bearer');
    const response = await t.f.json(
      '/api/v1/speakers/1/retry',
      'POST',
      {},
      credential,
    );
    assertEquals(response.status, 200);
    await response.text();
    await sleep(40);
    assertEquals(
      t.preparationCalls(),
      2,
      'initial start plus one explicit retry, with automatic retry disabled',
    );
    assertEquals(t.playback.playerView().state, 'pause');
    assertEquals(t.sessions.length, 1);
  } finally {
    await t.close();
  }

  // Exercise budget consumption and revocation at the same resume boundary.
  for (
    const action of [
      'retry-off',
      'pause',
      'stop',
      'deselect',
      'endpoint',
      'forget',
    ]
  ) {
    const held = await setup(undefined, '0');
    let release = () => {};
    try {
      held.register();
      if (action === 'forget') await held.outputs.adopt('1');
      await held.ok(`/queue/items/add?uris=${held.uri}&playback=start`, 'POST');
      await until(() => held.sessions.length === 1);
      release = held.holdPreparation();
      held.sessions[0].event('state', 'failed');
      await until(() => held.preparationCalls() === 2);
      assertEquals(held.playback.playerView().state, 'pause');
      if (action === 'retry-off') {
        await held.f.state.set('airplay.retry', 'off');
      } else if (action === 'pause' || action === 'stop') {
        await held.ok(`/player/${action}`);
      } else if (action === 'deselect') {
        await held.ok('/outputs/set', 'PUT', { outputs: [] });
      } else if (action === 'endpoint') {
        held.devices.register({ ...held.outputs.get('1')!, host: '192.0.2.9' });
      } else await held.speakers.forget('1');
      const command = held.playback.lastCommand();
      assert(held.preparationSignals[1].aborted, action);
      release();
      await sleep(40);
      assertEquals(held.preparationCalls(), 2, action);
      assertEquals(held.playback.lastCommand(), command, action);
      assertEquals(
        held.playback.playerView().state,
        action === 'stop' ? 'stop' : 'pause',
        action,
      );
      assertEquals(held.sessions.length, 1, action);
      assertEquals(held.sessions[0].writes, 0, action);
    } finally {
      release();
      await held.close();
    }
  }
});
