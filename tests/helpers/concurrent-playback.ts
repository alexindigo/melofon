// Real household composition, fresh HTTP graph on restart, real decoder/FFI.
import { assert, assertEquals } from '@std/assert';
import { Buffer } from 'node:buffer';
import { apiFixture } from './api.ts';
import { startFakeRaop } from './fake-raop.ts';
import { traceTimelineAudio } from './raop-timeline-audio.ts';
import { receiver } from './speaker-consumer.ts';
import { createOutputs } from '../../src/player.ts';
import { createPlayers } from '../../src/players.ts';
import { createPersistence } from '../../src/persistence.ts';
import { createPlaybackReports } from '../../src/playback-reports.ts';
import { createLibrary } from '../../src/library.ts';
import { createLibraries } from '../../src/libraries.ts';
import { createNowPlaying } from '../../src/nowplaying.ts';
import { scanLibrary } from '../../src/scan.ts';
import { rawSql } from '../../src/store/testing.ts';
import { openStore, type Store } from '../../src/store/index.ts';
import { createQueueResolver } from '../../src/queue-source.ts';
import { createSpeakers } from '../../src/speakers.ts';
import { createAirplayDevices } from '../../src/boots/airplay-device.ts';
import { createAirplayBoot } from '../../src/boots/airplay.ts';
import { createFfiStream } from '../../src/boots/raop-ffi.ts';
import { createMedia } from '../../src/media.ts';
import type {
  AirplayCompletionKey,
  AirplayCompletionResult,
} from '../../src/boots/airplay-profile.ts';
import { createReleaseSet, releaseOrThrow } from '../../src/releases.ts';

export async function until(check: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 20000;
  while (!await check()) {
    assert(
      performance.now() < deadline,
      'concurrent playback outcome timed out',
    );
    await new Promise((done) => setTimeout(done, 5));
  }
}
export function exact(actual: Uint8Array, expected: Uint8Array) {
  assertEquals(actual.length, expected.length, 'complete PCM length');
  assertEquals(Buffer.compare(actual, expected), 0, 'every PCM byte matches');
}
export function wave(frames: number, seed: number) {
  const wav = new Uint8Array(44 + frames * 4), view = new DataView(wav.buffer);
  for (
    const [at, label] of [[0, 'RIFF'], [8, 'WAVEfmt '], [36, 'data']] as const
  ) {
    wav.set(new TextEncoder().encode(label), at);
  }
  view.setUint32(4, wav.length - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 44100, true);
  view.setUint32(28, 176400, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i++) {
    view.setInt16(44 + i * 4, seed + i % 12000, true);
    view.setInt16(46 + i * 4, -seed - i % 13000, true);
  }
  return wav;
}

export async function concurrentFixture(frames = [44100 + 353, 88200 + 351]) {
  const dir = await Deno.makeTempDir({ prefix: 'concurrent-http-' });
  await Deno.mkdir(`${dir}/media`);
  const waves = frames.map((n, i) => wave(n, 1000 + i * 2000));
  for (const [i, bytes] of waves.entries()) {
    await Deno.writeFile(`${dir}/media/${i === 0 ? 'A' : 'B'}.wav`, bytes);
  }
  const receivers = await Promise.all(
    [0, 1, 2].map(() =>
      startFakeRaop({
        captureAudio: true,
        captureWire: true,
        recoverAudioGaps: true,
      })
    ),
  );
  const traces: {
    audio: ReturnType<typeof traceTimelineAudio>;
    ports: Set<number>;
    native: ReturnType<typeof createFfiStream>;
    seals: AirplayCompletionKey[];
    completions: AirplayCompletionResult[];
  }[] = [];
  const closeGates = new Map<
    number,
    { wait: Promise<void>; entered: boolean }
  >();
  let players!: Awaited<ReturnType<typeof createPlayers>>;
  let devices!: ReturnType<typeof createAirplayDevices>;
  let persistence!: ReturnType<typeof createPersistence>;
  let reports!: ReturnType<typeof createPlaybackReports>;
  let outputs!: ReturnType<typeof createOutputs>;
  let songs!: Awaited<
    ReturnType<ReturnType<typeof createLibrary>['listSongs']>
  >;
  const boots = new Map<number, ReturnType<typeof createAirplayBoot>>();
  const failSources = new Set<string>();
  const start = async () => {
    const f = await apiFixture({
      storeDir: `${dir}/db`,
      services: async (f) => {
        assert(f.notify);
        const libraries = createLibraries(f.store);
        if (!(await libraries.list()).length) {
          await libraries.add('Concurrent media', `${dir}/media`);
          await scanLibrary(f.store);
          await rawSql(f.store).run(
            "UPDATE files SET title = CASE WHEN path LIKE '%/A.wav' THEN 'Player A' ELSE 'Player B' END",
          );
        }
        const library = createLibrary(f.store),
          nowPlaying = createNowPlaying(f.store);
        songs = (await library.listSongs({ offset: 0, size: 10 })).sort((
          a,
          b,
        ) => a.path.localeCompare(b.path));
        persistence = createPersistence(f.store);
        outputs = createOutputs({ notify: f.notify, persistence });
        for (const row of await persistence.loadOutputs()) {
          outputs.restore({ ...row, ...persistence.savedOutput(row.id) });
        }
        devices = createAirplayDevices({
          outputs,
          resolver: {
            resolve(_host, port) {
              const i = receivers.findIndex((r) => r.port === port);
              assert(i >= 0);
              return Promise.resolve(receiver(i + 1, port!, { md: '0,1,2' }));
            },
            close() {},
          },
          stream() {
            const native = createFfiStream(), ports = new Set<number>();
            const seals: AirplayCompletionKey[] = [],
              completions: AirplayCompletionResult[] = [];
            const audio = traceTimelineAudio(() => ({
              ...native,
              get epoch() {
                return native.epoch;
              },
              async seal(epoch, source, target) {
                const marker = await native.seal(epoch, source, target);
                if (marker.status === 'accepted') {
                  seals.push({ epoch, source, target, revision: 1n });
                }
                return marker;
              },
              async waitCompletion(key) {
                const result = await native.waitCompletion(key);
                completions.push(result);
                return result;
              },
            }));
            traces.push({ audio, ports, native, seals, completions });
            return {
              ...audio.stream(),
              get epoch() {
                return native.epoch;
              },
              attach(...args) {
                const driver = native.attach(...args);
                let port: number | undefined,
                  closing: Promise<void> | undefined;
                return {
                  ...driver,
                  transport: {
                    send: (command) => driver.transport.send(command),
                    pcm: (chunk) => driver.transport.pcm(chunk),
                    ownsSharedFeed: () => driver.transport.ownsSharedFeed(),
                    cancelPcm: () => driver.transport.cancelPcm(),
                    close: () =>
                      closing ??= (async () => {
                        await driver.transport.close();
                        const gate = port === undefined
                          ? undefined
                          : closeGates.get(port);
                        if (gate) {
                          gate.entered = true;
                          await gate.wait;
                        }
                      })(),
                  },
                  start(profile, ...input) {
                    port = profile.port;
                    ports.add(profile.port);
                    return driver.start(profile, ...input);
                  },
                };
              },
            };
          },
        });
        const speakers = createSpeakers({
          outputs,
          adapterView: devices.describe,
          prepare: devices.preparePlayback,
        });
        reports = createPlaybackReports({
          library,
          nowPlaying,
          notify: f.notify,
          serverRows: () => players.serverRows(),
        });
        players = await createPlayers({
          store: f.store,
          persistence,
          outputs,
          reports,
          notify: f.notify,
          capacity: devices.capacity,
          maxResumeAgeMs: 300000,
          playback: {
            library,
            nowPlaying,
            cfg: f.cfg,
            resolveQueueReference: createQueueResolver({
              getSong: library.getSong,
              getStation: () => Promise.resolve(null),
            }),
          },
          targets: (id) => ({
            hasPlaybackTarget: () => speakers.hasPlaybackTarget(id),
            preparePlayback: (signal) => speakers.preparePlayback(signal, id),
          }),
          createBoot(playerId, playback, outputs, capacity) {
            const boot = createAirplayBoot({
              playerId,
              playback,
              outputs,
              capacity,
              devices,
              notify: f.notify!,
              media: {
                ...createMedia(),
                decodePcm(path, options) {
                  return failSources.has(path.split('/').at(-1)!)
                    ? Promise.resolve(null)
                    : createMedia().decodePcm(path, options);
                },
              },
              retryBackoffMs: [],
            });
            boots.set(playerId, boot);
            return boot;
          },
        });
        return {
          players,
          playback: players.playback,
          outputs,
          library,
          speakers,
        };
      },
    });
    const owned = createReleaseSet();
    owned.add('players', players.close);
    owned.add('reports', reports.close, 1);
    owned.add('devices', devices.close, 1);
    owned.add('persistence', persistence.close, 2);
    owned.add('http/store', f.close, 3);
    const { credential } = await f.login('bearer');
    const call = async (path: string, method = 'GET', body?: unknown) => {
      const r = method === 'GET'
        ? await f.get(`/api/v1${path}`, credential)
        : await f.json(`/api/v1${path}`, method, body, credential);
      const text = await r.text();
      assert(r.ok, `${method} ${path}: ${r.status} ${text}`);
      return text ? JSON.parse(text) : undefined;
    };
    return {
      f,
      call,
      close: () =>
        releaseOrThrow(owned, 'Concurrent household fixture release failed'),
    };
  };
  let server = await start();
  return {
    dir,
    waves,
    receivers,
    traces,
    boots,
    failSources,
    closeGates,
    get devices() {
      return devices;
    },
    get players() {
      return players;
    },
    get outputs() {
      return outputs;
    },
    get persistence() {
      return persistence;
    },
    get server() {
      return server;
    },
    async initialize() {
      await server.call('/players', 'POST', { name: 'Kitchen' });
      for (const [i, r] of receivers.entries()) {
        outputs.register({
          id: String(i + 1),
          name: `Receiver ${i + 1}`,
          type: 'AirPlay',
          host: '127.0.0.1',
          port: r.port,
          volume: 80,
          selected: false,
          connectionStrategy: 'owntone',
        });
        await outputs.adopt(String(i + 1));
        await server.call(
          `/players/${i === 2 ? 2 : 1}/speakers/${i + 1}`,
          'PUT',
          {},
        );
      }
      for (const [i, song] of songs.entries()) {
        await server.call(`/players/${i + 1}/queue/items`, 'POST', {
          references: [{ kind: 'song', id: song.id }],
        });
      }
    },
    async restart(seed?: (store: Store) => Promise<void>) {
      await server.close();
      if (seed) {
        const store = await openStore(`${dir}/db`);
        try {
          await seed(store);
        } finally {
          await store.close();
        }
      }
      server = await start();
    },
    async libraryProof() {
      const path = await Deno.realPath(Deno.env.get('MELOFON_RAOP_LIB')!);
      assertEquals(path, await Deno.realPath('helper/raop/libmelofon_raop.so'));
      assert(
        (await Deno.readTextFile('/proc/self/maps')).includes(` ${path}\n`),
      );
      const hash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', await Deno.readFile(path)),
      );
      console.log(
        `concurrent native library: ${path} sha256=${
          Array.from(hash, (v) => v.toString(16).padStart(2, '0')).join('')
        }`,
      );
    },
    async close() {
      try {
        await server.close();
      } finally {
        for (const r of receivers) r.close();
        await Deno.remove(dir, { recursive: true });
      }
    },
  };
}
