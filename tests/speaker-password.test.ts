import { assert, assertEquals } from '@std/assert';
import { apiFixture, error } from './helpers/api.ts';
import { createOutputs, createPlayer, type Outputs } from '../src/player.ts';
import { createSpeakerCredentials } from '../src/speaker-credentials.ts';
import { createPersistence } from '../src/persistence.ts';
import { createSecrets, type Secrets } from '../src/secrets.ts';
import { createSpeakers } from '../src/speakers.ts';
import { createAirplayDevices } from '../src/boots/airplay-device.ts';
import { createAirplayBoot } from '../src/boots/airplay.ts';
import type { AirplaySpawn } from '../src/boots/airplay-profile.ts';
import { createPlayback } from '../src/playback.ts';
import { createLibrary } from '../src/library.ts';
import { createLibraries } from '../src/libraries.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { scanLibrary } from '../src/scan.ts';
import { createMedia } from '../src/media.ts';
import { wireInt } from '../layers/owntone/payloads.ts';
import { startFakeRaop } from './helpers/fake-raop.ts';
import { decodeReceiverAudio } from './helpers/raop-audio-consumer.ts';
import { appLogger, installLogger } from '../src/logging.ts';
import { captureLogs } from './helpers/logging.ts';

const canary = () => crypto.randomUUID() + crypto.randomUUID();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
  const end = performance.now() + 20000;
  while (!predicate()) {
    assert(performance.now() < end, 'Password consumer outcome timed out');
    await sleep(20);
  }
}

async function mediaFixture(dir: string) {
  await Deno.mkdir(`${dir}/media`);
  const pcm = new Uint8Array(30 * 176400);
  const samples = new DataView(pcm.buffer);
  for (let i = 0; i < pcm.length / 4; i++) {
    samples.setInt16(i * 4, 1200 + i % 1000, true);
    samples.setInt16(i * 4 + 2, -1600 - i % 500, true);
  }
  const wav = new Uint8Array(44 + pcm.length),
    header = new DataView(wav.buffer);
  const encoder = new TextEncoder();
  wav.set(encoder.encode('RIFF'), 0);
  header.setUint32(4, wav.length - 8, true);
  wav.set(encoder.encode('WAVEfmt '), 8);
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 2, true);
  header.setUint32(24, 44100, true);
  header.setUint32(28, 176400, true);
  header.setUint16(32, 4, true);
  header.setUint16(34, 16, true);
  wav.set(encoder.encode('data'), 36);
  header.setUint32(40, pcm.length, true);
  wav.set(pcm, 44);
  await Deno.writeFile(`${dir}/media/password.wav`, wav);
  return pcm;
}

async function setup(
  dir: string,
  port: number,
  root?: string,
  options: { secrets?: Secrets; spawn?: AirplaySpawn } = {},
) {
  let outputs!: Outputs;
  let credentials!: ReturnType<typeof createSpeakerCredentials>;
  let persistence!: ReturnType<typeof createPersistence>;
  let devices!: ReturnType<typeof createAirplayDevices>;
  let boot!: ReturnType<typeof createAirplayBoot>;
  let playback!: ReturnType<typeof createPlayback>;
  let songId = '';
  let decodedStart = 0;
  const f = await apiFixture({
    storeDir: `${dir}/db`,
    traceRequests: true,
    hats: {
      layersRoot: 'layers',
      extraPorts: 1,
      env: ([port]) => ({ MELOFON_LISTEN_owntone: `${port},${port}` }),
    },
    services: async (f) => {
      assert(f.notify);
      credentials = createSpeakerCredentials({
        store: f.store.speakers,
        secrets: options.secrets ?? createSecrets(root),
        current: (id) =>
          outputs?.get(id, { includeIgnored: true })
            ? {
              revision: outputs.revision(id),
              adopted: outputs.lifetime(id).adopted,
            }
            : null,
      });
      persistence = createPersistence(f.store, undefined, credentials);
      const saved = await persistence.loadOutputs();
      outputs = createOutputs({
        notify: f.notify,
        persistence,
        releaseCredentials: credentials.release,
      });
      await outputs.ready();
      devices = createAirplayDevices({
        outputs,
        credentials,
        spawn: options.spawn,
        changed: () => f.notify!.emit(['outputs'], undefined, 'all'),
        resolver: {
          resolve: () =>
            Promise.resolve({
              name: '001122334455@Private receiver._raop._tcp.local',
              host: 'fixture.local',
              address: '127.0.0.1',
              port,
              ttlMs: 120000,
              txt: {
                tp: 'UDP',
                pw: 'true',
                am: 'AppleTV3,1',
                sr: '44100',
                ss: '16',
                ch: '2',
              },
            }),
          close() {},
        },
      });
      for (const row of saved) outputs.restore(row);
      const libraries = createLibraries(f.store);
      if (!(await libraries.list()).length) {
        await libraries.add('Password proof', `${dir}/media`);
        await scanLibrary(f.store);
      }
      const library = createLibrary(f.store);
      const [song] = await library.listSongs({ offset: 0, size: 1 });
      songId = song.id;
      const speakers = createSpeakers({
        outputs,
        credentials,
        adapterView: devices.describe,
        prepare: devices.preparePlayback,
        changeCredentials: (id, save) => boot.changeCredentials(id, save),
        playback: { pause: () => playback.pause() },
      });
      playback = createPlayback({
        player: createPlayer(),
        library,
        outputs,
        notify: f.notify,
        cfg: f.cfg,
        nowPlaying: createNowPlaying(f.store),
        targets: speakers,
      });
      const media = createMedia();
      boot = createAirplayBoot({
        outputs,
        devices,
        playback,
        notify: f.notify,
        media: {
          ...media,
          decodePcm(path: string, options?: { startMs?: number }) {
            decodedStart = options?.startMs ?? 0;
            return media.decodePcm(path, options);
          },
        },
        retryBackoffMs: [],
      });
      return { outputs, speakers, playback, library };
    },
  });
  if (
    !(await f.auth.users.list(f.admin.id)).some((user) =>
      user.username === 'member'
    )
  ) {
    await f.auth.users.create(f.admin.id, {
      username: 'member',
      password: 'password-member',
      role: 'user',
    });
  }
  const login = await f.login('cookie', 'member', 'password-member');
  const credential = login.credential;
  const own = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(
      `http://melofon.home:${f.extraPorts[0]}/api${path}`,
      {
        method,
        signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    assert(response.ok, 'OwnTone request failed');
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  };
  const write = (value: string) =>
    f.json(
      '/api/v1/speakers/1/password',
      'PUT',
      { password: value },
      credential,
    );
  const read = async () => {
    const response = await f.get('/api/v1/speakers/1', credential);
    assertEquals(response.status, 200);
    return (await response.json()).speaker;
  };
  return {
    f,
    own,
    write,
    read,
    outputs,
    credentials,
    devices,
    playback,
    credential,
    decodedStart: () => decodedStart,
    register: () =>
      devices.register({
        id: '1',
        name: 'Private receiver',
        type: 'AirPlay',
        host: '127.0.0.1',
        port,
        selected: false,
        volume: 100,
      }),
    async play() {
      await own('/outputs/set', 'PUT', { outputs: ['1'] });
      if (!playback.queueView().items.length) {
        await own(
          `/queue/items/add?uris=library:track:${wireInt(songId)}`,
          'POST',
        );
      }
      await own('/player/play', 'PUT');
    },
    async close() {
      await boot.close();
      devices.close();
      await playback.close();
      await persistence.drain();
      await f.close();
    },
  };
}

async function status(response: Response, passwordSet: boolean) {
  assertEquals(response.status, 200);
  assertEquals(response.headers.get('cache-control'), 'no-store');
  assertEquals(await response.json(), { passwordSet });
}

Deno.test({
  name:
    'regular-user HTTP password replacement reaches native digest audio and adopted reopen while temporary credentials vanish',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: 'melofon-password-wire-' });
    const pcm = await mediaFixture(dir);
    const root = canary(), password = canary(), wrong = canary();
    const previous = appLogger(), capture = captureLogs();
    installLogger(capture.log);
    const fake = await startFakeRaop({
      captureAudio: true,
      digest: { password },
    });
    let t: Awaited<ReturnType<typeof setup>> | undefined;
    const visible: string[] = [];
    const audio = async (index: number) => {
      await until(() => (fake.sessions[index]?.audioPackets ?? 0) > 160);
      const session = fake.sessions[index];
      assert(session.authChallenges > 0);
      assert(session.acceptedRequests.includes('RECORD'));
      const received = decodeReceiverAudio(session.sdp, session.audioPayloads);
      assert(
        received.length > 44100 * 4 && received.some((byte) => byte !== 0),
      );
      const offset = Math.round(t!.decodedStart() * 44100 / 1000) * 4;
      assert(
        received.every((byte, i) => byte === pcm[offset + i]),
        'Digest-authenticated receiver decoded exact current-position PCM',
      );
    };
    try {
      t = await setup(dir, fake.port, root);
      t.register();
      await status(await t.write(wrong), true);
      await t.play();
      await until(() =>
        t!.devices.describe('1').session?.authentication ===
          'authentication_required'
      );
      assertEquals(fake.sessions[0].audioPackets, 0);
      assert(!fake.sessions[0].acceptedRequests.includes('RECORD'));
      assertEquals((await t.own('/player')).state, 'pause');
      visible.push(JSON.stringify(await t.read()));
      await status(await t.write(password), true);
      await audio(1); // No new Play: only the existing intent may recover.
      assertEquals((await t.read()).state.authentication, 'none');
      assertEquals((await t.own('/outputs')).outputs[0].has_password, true);
      assertEquals(await t.f.store.speakers.loadAdopted(), []);
      assertEquals(
        await t.f.store.speakers.loadCredential('1', 'password'),
        null,
      );
      await t.close();
      t = undefined;
      t = await setup(dir, fake.port, root);
      assertEquals(t.outputs.list(), []);
      t.register();
      assertEquals(await t.credentials.get('1', 'password'), null);
      const adopt = await t.f.json(
        '/api/v1/speakers/1/adopt',
        'POST',
        {},
        t.credential,
      );
      assertEquals(adopt.status, 200);
      visible.push(await adopt.text());
      const bearer = await t.f.login('bearer', 'member', 'password-member');
      await status(
        await t.f.json(
          '/api/v1/speakers/1/password',
          'PUT',
          { password },
          bearer.credential,
        ),
        true,
      );
      await t.close();
      t = undefined;
      const db = await Deno.readFile(`${dir}/db/melofon.duckdb`);
      assert(
        !new TextDecoder().decode(db).includes(password),
        'Plaintext credential in database',
      );
      t = await setup(dir, fake.port, root);
      assert(t.outputs.lifetime('1').adopted);
      await t.play();
      await audio(2);
      visible.push(
        JSON.stringify(await t.read()),
        JSON.stringify(await t.own('/outputs')),
      );
      const frames: string[] = [];
      const ws = new WebSocket(
        `${t.f.origin.replace('http:', 'ws:')}/api/v1/events`,
        {
          headers: { Cookie: t.credential, Origin: t.f.origin },
        },
      );
      ws.onmessage = (event) => frames.push(String(event.data));
      try {
        await until(() => frames.length > 0);
        await status(
          await t.f.json(
            '/api/v1/speakers/1/password',
            'DELETE',
            undefined,
            t.credential,
          ),
          false,
        );
        await until(() =>
          t!.devices.describe('1').session?.authentication ===
            'authentication_required'
        );
        assertEquals(fake.sessions[3].audioPackets, 0);
        assertEquals((await t.own('/outputs')).outputs[0].has_password, true);
        await until(() => frames.some((frame) => frame.includes('speakers')));
        visible.push(...frames);
      } finally {
        ws.close();
        await until(() => ws.readyState === WebSocket.CLOSED);
      }
      assertEquals(
        await t.f.store.speakers.loadCredential('1', 'password'),
        null,
      );
      await t.close();
      t = undefined;
      await capture.log.flush();
      visible.push(
        capture.lines.join('\n'),
        JSON.stringify(capture.log.records({ limit: 1000 })),
      );
      assert(
        [root, password, wrong].every((value) =>
          visible.every((text) => !text.includes(value))
        ),
        'Credential escaped public/log boundary',
      );
    } finally {
      await t?.close();
      fake.close();
      installLogger(previous);
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test('password HTTP validation permissions and durable failures return safe typed outcomes', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-password-errors-' });
  await mediaFixture(dir);
  const capture = captureLogs(), previous = appLogger();
  installLogger(capture.log);
  let t: Awaited<ReturnType<typeof setup>> | undefined;
  const value = canary();
  try {
    t = await setup(dir, 7000);
    t.register();
    const path = '/api/v1/speakers/1/password';
    for (const method of ['PUT', 'DELETE']) {
      await error(
        await t.f.json(path, method, { password: value }),
        401,
        'unauthenticated',
      );
      await error(
        await t.f.json(
          path,
          method,
          { password: value },
          t.credential,
          'http://other.home',
        ),
        403,
        'origin',
      );
    }
    for (
      const body of [
        {},
        { password: null },
        { password: 1 },
        { password: value + '\0' },
        { password: 'x'.repeat(4097) },
        { password: '\u00e9'.repeat(2049) },
      ]
    ) {
      await error(
        await t.f.json(path, 'PUT', body, t.credential),
        400,
        'invalid_field',
      );
    }
    await error(
      await t.f.json(
        path,
        'PUT',
        { password: value, selected: true },
        t.credential,
      ),
      400,
      'unknown_field',
    );
    await error(
      await t.f.json('/api/v1/speakers/missing/password', 'PUT', {
        password: value,
      }, t.credential),
      404,
      'not_found',
    );
    await status(
      await t.f.json('/_melofon/api/v1/speakers/1/password', 'PUT', {
        password: '',
      }, t.credential),
      true,
    );
    await status(
      await t.f.json(path, 'DELETE', undefined, t.credential),
      false,
    );
    await t.outputs.adopt('1');
    await error(await t.write(value), 500, 'secret_missing');
    assertEquals(
      await t.f.store.speakers.loadCredential('1', 'password'),
      null,
    );
    await t.close();
    t = undefined;
    t = await setup(dir, 7000, canary());
    await status(await t.write(value), true);
    const admin = await t.f.login('bearer');
    await status(
      await t.f.json(path, 'PUT', { password: value }, admin.credential),
      true,
    );
    const save = t.f.store.speakers.saveCredential;
    t.f.store.speakers.saveCredential = () => Promise.reject(new Error(value));
    await error(await t.write(canary()), 500, 'persistence_failed');
    await error(
      await t.f.json(path, 'DELETE', undefined, t.credential),
      500,
      'persistence_failed',
    );
    t.f.store.speakers.saveCredential = save;
    assert(
      await t.credentials.get('1', 'password') === value,
      'Failed writes replaced durable credential',
    );
    await status(
      await t.f.json(path, 'DELETE', undefined, t.credential),
      false,
    );
  } finally {
    await t?.close();
    installLogger(previous);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name:
    'held HTTP password writes cannot outlive pause stop selection endpoint forget or newer replacements',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    for (
      const action of [
        'pause',
        'stop',
        'deselect',
        'endpoint',
        'forget',
        'newer',
      ]
    ) {
      const dir = await Deno.makeTempDir({ prefix: 'melofon-password-fence-' });
      await mediaFixture(dir);
      const root = canary(), secrets = createSecrets(root);
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>((resolve) => entered = resolve);
      const held = new Promise<void>((resolve) => release = resolve);
      let hold = false, starts = 0;
      const t = await setup(dir, 7000, root, {
        secrets: {
          ...secrets,
          async encrypt(...args) {
            if (hold) {
              hold = false;
              entered();
              await held;
            }
            return secrets.encrypt(...args);
          },
        },
        spawn(event) {
          return {
            transport: {
              send: () => Promise.resolve(),
              close: () => Promise.resolve(),
              pcm: () => Promise.resolve(),
              cancelPcm() {},
              ownsSharedFeed: () => false,
            },
            start() {
              starts++;
              queueMicrotask(() => event('state', 'connected'));
              return Promise.resolve();
            },
          };
        },
      });
      try {
        t.register();
        await t.outputs.adopt('1');
        await t.play();
        await until(() => starts === 1);
        hold = true;
        const pending = t.write(canary());
        await ready;
        if (action === 'pause' || action === 'stop') {
          await t.own(`/player/${action}`, 'PUT');
        }
        if (action === 'deselect') {
          await t.own('/outputs/set', 'PUT', { outputs: [] });
        }
        if (action === 'endpoint') {
          t.outputs.register({ ...t.outputs.get('1')!, host: '192.0.2.8' });
        }
        const forgotten = action === 'forget'
          ? t.f.json('/api/v1/speakers/1', 'DELETE', undefined, t.credential)
          : undefined;
        const replacement = canary();
        const newer = action === 'newer' ? t.write(replacement) : undefined;
        // Give request dispatch a turn before releasing encryption.
        await sleep(40);
        assertEquals(starts, 1, 'Started before credential durability');
        release();
        if (action === 'forget') {
          await error(await pending, 404, 'not_found');
          const response = await forgotten!;
          assertEquals(response.status, 204);
          await response.body?.cancel();
          assertEquals(
            await t.f.store.speakers.loadCredential('1', 'password'),
            null,
          );
        } else await status(await pending, true);
        if (newer) {
          await status(await newer, true);
          await until(() => starts === 2);
          assert(
            await t.credentials.get('1', 'password') === replacement,
            'Newer replacement lost',
          );
        } else {
          await sleep(80);
          assertEquals(starts, 1, 'Revoked intent started a session');
          assert(t.playback.playerView().state !== 'play');
        }
      } finally {
        release();
        await t.close();
        await Deno.remove(dir, { recursive: true });
      }
    }
  },
});
