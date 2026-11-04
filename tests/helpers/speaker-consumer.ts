import { assert, assertEquals } from '@std/assert';
import { apiFixture } from './api.ts';
import { songResolver } from './queue.ts';
import {
  createOutputs,
  createPlayer,
  type Outputs,
  planRestore,
} from '../../src/player.ts';
import { createPersistence } from '../../src/persistence.ts';
import { createSpeakerCredentials } from '../../src/speaker-credentials.ts';
import { createSecrets, type Secrets } from '../../src/secrets.ts';
import { createSpeakers } from '../../src/speakers.ts';
import { createAirplayDevices } from '../../src/boots/airplay-device.ts';
import { createAirplayBoot } from '../../src/boots/airplay.ts';
import { createAirplayDiscovery } from '../../src/boots/airplay-mdns.ts';
import type { AirplaySpawn } from '../../src/boots/airplay-profile.ts';
import type { MdnsService } from '../../src/mdns.ts';
import { createPlayback } from '../../src/playback.ts';
import { createLibrary } from '../../src/library.ts';
import { createLibraries } from '../../src/libraries.ts';
import { createNowPlaying } from '../../src/nowplaying.ts';
import { createMedia } from '../../src/media.ts';
import { scanLibrary } from '../../src/scan.ts';
import { wireInt } from '../../layers/owntone/payloads.ts';

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
export async function until(predicate: () => boolean) {
  const end = performance.now() + 20000;
  while (!predicate()) {
    assert(performance.now() < end, 'Speaker consumer outcome timed out');
    await sleep(10);
  }
}
export const pairingKey = () =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(64)),
    (n) => n.toString(16).padStart(2, '0'),
  ).join('');
export function receiver(
  id: number,
  port: number,
  txt: Record<string, string> = {},
): MdnsService {
  return {
    name: `${
      id.toString(16).padStart(12, '0')
    }@Receiver ${id}._raop._tcp.local`,
    host: 'fixture.local',
    address: '127.0.0.1',
    port,
    ttlMs: 120000,
    txt: {
      tp: 'UDP',
      am: 'AppleTV3,1',
      sr: '44100',
      ss: '16',
      ch: '2',
      ...txt,
    },
  };
}
export async function speakerMedia(dir: string) {
  await Deno.mkdir(`${dir}/media`);
  const pcm = new Uint8Array(30 * 176400), samples = new DataView(pcm.buffer);
  for (let i = 0; i < pcm.length / 4; i++) {
    samples.setInt16(i * 4, 1200 + i % 1000, true);
    samples.setInt16(i * 4 + 2, -1600 - i % 500, true);
  }
  const wav = new Uint8Array(44 + pcm.length),
    h = new DataView(wav.buffer),
    e = new TextEncoder();
  wav.set(e.encode('RIFF'));
  h.setUint32(4, wav.length - 8, true);
  wav.set(e.encode('WAVEfmt '), 8);
  h.setUint32(16, 16, true);
  h.setUint16(20, 1, true);
  h.setUint16(22, 2, true);
  h.setUint32(24, 44100, true);
  h.setUint32(28, 176400, true);
  h.setUint16(32, 4, true);
  h.setUint16(34, 16, true);
  wav.set(e.encode('data'), 36);
  h.setUint32(40, pcm.length, true);
  wav.set(pcm, 44);
  await Deno.writeFile(`${dir}/media/signal.wav`, wav);
  return pcm;
}

/** Fresh store/service reopen is the subject; no prepared database snapshot. */
export async function speakerConsumer(
  dir: string,
  services: MdnsService[],
  options: {
    root?: string;
    spawn?: AirplaySpawn;
    secrets?: Secrets;
    pairingSeconds?: number;
  } = {},
) {
  let outputs!: Outputs;
  let credentials!: ReturnType<typeof createSpeakerCredentials>;
  let persistence!: ReturnType<typeof createPersistence>;
  let devices!: ReturnType<typeof createAirplayDevices>;
  let playback!: ReturnType<typeof createPlayback>;
  let boot!: ReturnType<typeof createAirplayBoot>;
  let discovery!: ReturnType<typeof createAirplayDiscovery>;
  let announce!: (event: 'up' | 'down', service: MdnsService) => void;
  let songId = '', decodedStart = 0;
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
        secrets: options.secrets ?? createSecrets(options.root),
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
          resolve: (_host, port) => {
            const service = services.find((s) => s.port === port);
            return service
              ? Promise.resolve(service)
              : Promise.reject(new Error('Receiver unavailable'));
          },
          close() {},
        },
      });
      for (const row of saved) outputs.restore(row);
      const libraries = createLibraries(f.store);
      if (!(await libraries.list()).length) {
        await libraries.add('Speaker proof', `${dir}/media`);
        await scanLibrary(f.store);
      }
      const library = createLibrary(f.store);
      const [song] = await library.listSongs({ offset: 0, size: 1 });
      songId = song.id;
      const speakers = createSpeakers({
        outputs,
        credentials,
        state: f.state,
        adapterView: devices.describe,
        prepare: devices.preparePlayback,
        playback: { pause: (source) => playback.pause(source) },
        changeCredentials: (id, save) => boot.changeCredentials(id, save),
        pair: (id) => boot.pair(id),
        submitPin: (id, pin) => boot.submitPin(id, pin),
      });
      playback = createPlayback({
        player: createPlayer(),
        outputs,
        persistence,
        library,
        notify: f.notify,
        cfg: f.cfg,
        nowPlaying: createNowPlaying(f.store),
        targets: speakers,
      });
      const snapshot = await planRestore({
        queue: await persistence.loadQueue(),
        saved: await persistence.loadPlayerState(),
        resolve: songResolver((id) => library.getSong(id)),
        nowMs: Date.now(),
        maxAgeMs: 300000,
        selectedOutputPresent: outputs.list().some((row) => row.selected),
      });
      if (snapshot) await playback.restore(snapshot);
      const media = createMedia();
      boot = createAirplayBoot({
        outputs,
        devices,
        playback,
        notify: f.notify,
        state: f.state,
        retryBackoffMs: [],
        media: {
          ...media,
          decodePcm(path, opts) {
            decodedStart = opts?.startMs ?? 0;
            return media.decodePcm(path, opts);
          },
        },
      });
      if (options.pairingSeconds !== undefined) {
        await f.state.set(
          'airplay.pairingSeconds',
          String(options.pairingSeconds),
        );
      }
      discovery = createAirplayDiscovery({
        outputs,
        devices,
        state: f.state,
        createBrowser: (callback) => {
          announce = callback;
          return { close() {}, resolve() {} };
        },
      });
      return { outputs, speakers, playback, library };
    },
  });
  await until(() => !!announce);
  if (
    !(await f.auth.users.list(f.admin.id)).some((u) => u.username === 'member')
  ) {
    await f.auth.users.create(f.admin.id, {
      username: 'member',
      password: 'password-member',
      role: 'user',
    });
  }
  const { credential } = await f.login('cookie', 'member', 'password-member');
  const ownResponse = (path: string, method = 'GET', body?: unknown) =>
    fetch(`http://melofon.home:${f.extraPorts[0]}/api${path}`, {
      method,
      signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const own = async (path: string, method = 'GET', body?: unknown) => {
    const r = await ownResponse(path, method, body);
    assert(r.ok, 'OwnTone request failed');
    const text = await r.text();
    return text ? JSON.parse(text) : undefined;
  };
  return {
    f,
    outputs,
    devices,
    credentials,
    playback,
    credential,
    own,
    ownResponse,
    decodedStart: () => decodedStart,
    discover: (service: MdnsService) => announce('up', service),
    async read(id: string) {
      const r = await f.get(`/api/v1/speakers/${id}`, credential);
      assertEquals(r.status, 200);
      return (await r.json()).speaker;
    },
    write: (
      id: string,
      operation: string,
      method = 'POST',
      body: unknown = {},
    ) =>
      f.json(
        `/api/v1/speakers/${id}${operation ? '/' + operation : ''}`,
        method,
        body,
        credential,
      ),
    async play(id: string) {
      await own('/outputs/set', 'PUT', { outputs: [id] });
      if (!playback.queueView().items.length) {
        await own(
          `/queue/items/add?uris=library:track:${wireInt(songId)}`,
          'POST',
        );
      }
      await own('/player/play', 'PUT');
    },
    async close() {
      discovery.close();
      await boot.close();
      devices.close();
      await playback.close();
      await persistence.drain();
      await f.close();
    },
  };
}
