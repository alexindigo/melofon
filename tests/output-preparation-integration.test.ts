// Full registration/preparation -> real media/FFI -> receiver-consumed signal.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import dgram from 'node:dgram';
import {
  createOutputs,
  createPlayer,
  type PersistedOutput,
  planRestore,
} from '../src/player.ts';
import { createNotify } from '../src/notify.ts';
import { createPlayback } from '../src/playback.ts';
import { createMedia } from '../src/media.ts';
import { createAirplayDevices } from '../src/boots/airplay-device.ts';
import { createSpeakers } from '../src/speakers.ts';
import { createAirplayDiscovery } from '../src/boots/airplay-mdns.ts';
import { createAirplayBoot } from '../src/boots/airplay.ts';
import { createMdnsResolver } from '../src/mdns-resolver.ts';
import { dnsQuestions, type MdnsService } from '../src/mdns.ts';
import { createLibrary, type Library, type SongRow } from '../src/library.ts';
import { createLibraries } from '../src/libraries.ts';
import { scanLibrary } from '../src/scan.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createPersistence } from '../src/persistence.ts';
import { apiFixture } from './helpers/api.ts';
import { wireInt } from '../layers/owntone/payloads.ts';
import type { NowPlaying } from '../src/nowplaying.ts';
import type { State } from '../src/state.ts';
import { airplayAnswer } from './mdns-builder.ts';
import { startFakeRaop } from './helpers/fake-raop.ts';
import { decodeReceiverAudio } from './helpers/raop-audio-consumer.ts';

async function until(predicate: () => boolean, timeout = 40000) {
  const end = performance.now() + timeout;
  while (!predicate()) {
    assert(performance.now() < end, 'receiver outcome arrived within bound');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function fixture(dir: string) {
  const frames = 60 * 44100;
  const pcm = new Uint8Array(frames * 4);
  const samples = new DataView(pcm.buffer);
  for (let i = 44100; i < frames; i++) {
    samples.setInt16(i * 4, 1200 + (i % 1000), true);
    samples.setInt16(i * 4 + 2, -1600 - (i % 500), true);
  }
  const wav = new Uint8Array(44 + pcm.length);
  const header = new DataView(wav.buffer);
  const text = new TextEncoder();
  wav.set(text.encode('RIFF'), 0);
  header.setUint32(4, wav.length - 8, true);
  wav.set(text.encode('WAVEfmt '), 8);
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 2, true);
  header.setUint32(24, 44100, true);
  header.setUint32(28, 176400, true);
  header.setUint16(32, 4, true);
  header.setUint16(34, 16, true);
  wav.set(text.encode('data'), 36);
  header.setUint32(40, pcm.length, true);
  wav.set(pcm, 44);
  const path = `${dir}/admission.wav`;
  await Deno.writeFile(path, wav);
  const song: SongRow = {
    id: 'receiver-proof',
    path,
    fileName: 'admission',
    title: 'Admission Fixture',
    artistName: 'Receiver Proof',
    durationMs: 60000,
    libraryId: null,
    libraryPath: null,
    albumId: null,
    albumName: null,
    albumFolderName: null,
    artistId: null,
    track: 1,
    disc: 1,
    size: wav.length,
    genre: null,
    year: null,
    firstSeenMs: null,
    isVideo: false,
    suffix: 'wav',
    contentType: 'audio/wav',
  };
  return { pcm, song };
}

function receiverService(port: number): MdnsService {
  return {
    name: '001122334455@Fixture._raop._tcp.local',
    host: 'fixture.local',
    address: '127.0.0.1',
    port,
    ttlMs: 120000,
    txt: {
      tp: 'UDP',
      am: 'AppleTV3,1',
      md: '0,1,2',
      sr: '44100',
      ss: '16',
      ch: '2',
    },
  };
}

async function dnsReceiver(port: number) {
  const socket = dgram.createSocket('udp4');
  await new Promise<void>((r) => socket.bind(0, '127.0.0.1', r));
  const queries: { address: string; port: number; name: string }[] = [];
  socket.on('message', (msg, peer) => {
    const questions = dnsQuestions(msg);
    if (!questions || (msg[2] & 0x80) !== 0) return;
    queries.push({
      address: peer.address,
      port: peer.port,
      name: questions[0].name,
    });
    const id = new DataView(msg.buffer, msg.byteOffset).getUint16(0);
    socket.send(
      airplayAnswer({
        instance: receiverService(port).name,
        host: 'fixture.local',
        address: [127, 0, 0, 1],
        port,
        ttl: 120,
        txt: [
          'tp=UDP',
          'am=AppleTV3,1',
          'md=0,1,2',
          'sr=44100',
          'ss=16',
          'ch=2',
        ],
        id,
        questions,
      }),
      peer.port,
      peer.address,
    );
  });
  return { port: socket.address().port, queries, close: () => socket.close() };
}

const quietState: State = {
  declare() {},
  getTyped(key) {
    return this.get(key).then((value) => value ?? undefined);
  },
  getWithRevision(key) {
    return this.get(key).then((value) => ({ value, revision: 0 }));
  },
  get: (key) => Promise.resolve(key === 'airplay.mdns' ? 'off' : null),
  set: () => Promise.resolve(),
  seedIfUnset: () => Promise.resolve(false),
  list: () => Promise.resolve({}),
  onChange: () => () => {},
};

Deno.test({
  name:
    'composition: all ingress paths admit receiver-derived profiles and real receiver PCM/metadata',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: 'melofon-admission-wire-' });
    const input = await fixture(dir);
    try {
      for (
        const mode of ['post', 'env-service', 'restore', 'browse'] as const
      ) {
        const fake = await startFakeRaop({ captureAudio: true });
        const dns = await dnsReceiver(fake.port);
        const notify = createNotify();
        const outputs = createOutputs({ notify });
        const playback = createPlayback({
          player: createPlayer(),
          library: {} as Library,
          nowPlaying: {} as NowPlaying,
          cfg: {},
          notify,
        });
        const resolver = createMdnsResolver({ port: dns.port });
        const devices = createAirplayDevices({ outputs, resolver });
        const realMedia = createMedia();
        let decodedStart = 0;
        const media = {
          ...realMedia,
          decodePcm(path: string, options?: { startMs?: number }) {
            decodedStart = options?.startMs ?? 0;
            return realMedia.decodePcm(path, options);
          },
        };
        const boot = createAirplayBoot({
          outputs,
          playback,
          notify,
          media,
          devices,
          retryBackoffMs: [],
        });
        let browserStarts = 0;
        const discovery = createAirplayDiscovery({
          outputs,
          state: quietState,
          devices,
          createBrowser: () => {
            browserStarts++;
            throw new Error('unexpected automatic browse');
          },
        });
        let activeBrowse: ReturnType<typeof createAirplayDiscovery> | undefined;
        try {
          let id: string;
          if (mode === 'post') {
            const core = await pathfinder({
              roots: ['core/'],
              app: {
                cfg: {},
                outputs,
                airplay: devices,
                speakers: createSpeakers({
                  outputs,
                  registerAddress: devices.registerAddress,
                  adapterView: (id) => ({
                    preparation: devices.admission.describe(id),
                  }),
                }),
                outputAdmission: devices.admission,
              },
            });
            const response = await core(
              new Request('http://x/outputs', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  name: 'Fixture',
                  type: 'AirPlay',
                  host: '127.0.0.1',
                  port: fake.port,
                }),
              }),
            );
            assertEquals(response.status, 200);
            const row = (await response.json()).output;
            assertEquals(row.preparation.state, 'ready');
            id = row.id;
          } else if (mode === 'env-service') {
            const row = await devices.registerAddress({
              name: 'Fixture',
              host: '127.0.0.1',
              port: fake.port,
            });
            assert(row);
            id = row.id;
          } else if (mode === 'restore') {
            const saved: PersistedOutput = {
              id: '55',
              name: 'Fixture',
              type: 'AirPlay',
              host: '127.0.0.1',
              port: fake.port,
              selected: true,
              volume: 100,
              connectionStrategy: 'melofon',
            };
            devices.register(saved, { kind: 'internal', via: 'restore' });
            assertEquals(
              devices.admission.describe(saved.id).state,
              'unresolved',
            );
            id = saved.id;
          } else {
            let announce:
              | ((event: 'up' | 'down', service: MdnsService) => void)
              | undefined;
            activeBrowse = createAirplayDiscovery({
              outputs,
              state: { ...quietState, get: () => Promise.resolve('on') },
              devices,
              createBrowser: (callback) => {
                announce = callback;
                return { close() {}, resolve() {} };
              },
            });
            await until(() => announce !== undefined);
            announce!('up', receiverService(fake.port));
            id = outputs.list()[0].id;
          }
          assertEquals(
            fake.sessions.length,
            0,
            'registration/preparation cannot start a session',
          );
          assertEquals(
            browserStarts,
            0,
            'off disables only automatic browsing',
          );
          outputs.setEnabled([id]);
          playback.setVolume({ volume: 65 });
          playback.queueAdd([input.song], { play: true });
          await until(() => (fake.sessions[0]?.audioPackets ?? 0) > 400);
          const session = fake.sessions[0];
          const received = decodeReceiverAudio(
            session.sdp,
            session.audioPayloads,
          );
          const startFrame = Math.round(decodedStart * 44100 / 1000);
          assert(received.length > 44100 * 4);
          assertEquals(
            received,
            input.pcm.subarray(
              startFrame * 4,
              startFrame * 4 + received.length,
            ),
            'receiver decoded the exact current-position PCM prefix',
          );
          assert(
            new DataView(
              received.buffer,
              received.byteOffset,
              received.byteLength,
            ).getInt16(44100 * 4, true) > 1000,
            'signal follows initial silence at the receiver',
          );
          const text = new TextDecoder();
          assert(
            session.parameters.some((p) =>
              p.contentType === 'application/x-dmap-tagged' &&
              text.decode(p.body).includes('Admission Fixture')
            ),
          );
          const progress = () =>
            session.parameters.filter((p) =>
              text.decode(p.body).startsWith('progress:')
            );
          assert(progress().length > 0);
          if (mode === 'post') {
            await until(() => progress().length >= 2);
            assert(
              progress()[1].atMs - progress()[0].atMs > 1000,
              'later keep-alive is observed, not only startup metadata',
            );
          }
          console.log(JSON.stringify({
            mode,
            receiverPackets: session.audioPackets,
            receiverDecodedBytes: received.length,
            decodedStartMs: decodedStart,
            progressMessages: progress().length,
            dnsQueries: dns.queries.length,
            automaticBrowserStarts: browserStarts,
          }));
          playback.stop();
          await until(() => session.closedAtMs !== null);
          assertEquals(playback.queueView().items.length, 1);
          assertEquals(outputs.get(id)!.selected, true);
        } finally {
          await boot.close();
          discovery.close();
          activeBrowse?.close();
          devices.close();
          playback.close();
          fake.close();
          dns.close();
        }
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test('composition: unresolved target produces zero transport starts', async () => {
  const notify = createNotify();
  const outputs = createOutputs({ notify });
  const playback = createPlayback({
    player: createPlayer(),
    library: {} as Library,
    nowPlaying: {} as NowPlaying,
    cfg: {},
    notify,
  });
  let creates = 0;
  const devices = createAirplayDevices({
    outputs,
    resolver: {
      resolve: () => Promise.reject(new Error('no TXT fixture')),
      close() {},
    },
    spawn: () => {
      creates++;
      throw new Error('unresolved target cannot create transport');
    },
  });
  const boot = createAirplayBoot({
    outputs,
    playback,
    notify,
    media: createMedia(),
    devices,
    retryBackoffMs: [],
  });
  try {
    devices.register({
      id: '1',
      name: 'unresolved',
      host: '127.0.0.1',
      type: 'AirPlay',
      selected: true,
      volume: 100,
    });
    const dir = await Deno.makeTempDir({
      prefix: 'melofon-admission-unresolved-',
    });
    try {
      const input = await fixture(dir);
      playback.queueAdd([input.song], { play: true });
      await until(() => playback.playerView().state === 'pause');
      assertEquals(creates, 0);
      assertEquals(playback.queueView().items.length, 1);
      assertEquals(outputs.get('1')!.selected, true);
      assertEquals(devices.admission.describe('1').state, 'failed');
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  } finally {
    await boot.close();
    devices.close();
    playback.close();
  }
});

Deno.test('composition: Pause cancels lookup and late facts cannot start a session', async () => {
  const notify = createNotify();
  const outputs = createOutputs({ notify });
  const playback = createPlayback({
    player: createPlayer(),
    library: {} as Library,
    nowPlaying: {} as NowPlaying,
    cfg: {},
    notify,
  });
  let pendingSignal: AbortSignal | undefined;
  let complete!: (service: MdnsService) => void;
  let creates = 0;
  const devices = createAirplayDevices({
    outputs,
    resolver: {
      resolve(_host, _port, signal) {
        pendingSignal = signal;
        return new Promise((resolve) => complete = resolve);
      },
      close() {},
    },
    spawn: () => {
      creates++;
      throw new Error('cancelled output cannot create a transport');
    },
  });
  const boot = createAirplayBoot({
    outputs,
    playback,
    notify,
    media: createMedia(),
    devices,
    retryBackoffMs: [],
  });
  const dir = await Deno.makeTempDir({ prefix: 'melofon-admission-cancel-' });
  try {
    const input = await fixture(dir);
    devices.register({
      id: '1',
      name: 'pending',
      host: '127.0.0.1',
      port: 7000,
      type: 'AirPlay',
      selected: true,
      volume: 100,
    });
    playback.queueAdd([input.song], { play: true });
    await until(() => pendingSignal !== undefined);
    playback.pause();
    assert(pendingSignal!.aborted);
    complete(receiverService(7000));
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(creates, 0);
    assertEquals(playback.playerView().state, 'pause');
    assertEquals(outputs.get('1')!.selected, true);
    assertEquals(playback.queueView().items.length, 1);
  } finally {
    complete?.(receiverService(7000));
    await boot.close();
    devices.close();
    playback.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name:
    'temporary speaker HTTP playback delivers decoded audio without saving a target; explicit adoption survives reopen',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: 'melofon-temporary-wire-' });
    const mediaDir = `${dir}/media`;
    await Deno.mkdir(mediaDir);
    const input = await fixture(mediaDir);
    const fake = await startFakeRaop({ captureAudio: true });
    const id = BigInt('0x001122334455').toString();
    const setup = async () => {
      let outputs!: ReturnType<typeof createOutputs>;
      let persistence!: ReturnType<typeof createPersistence>;
      let playback!: ReturnType<typeof createPlayback>;
      let devices!: ReturnType<typeof createAirplayDevices>;
      let discovery!: ReturnType<typeof createAirplayDiscovery>;
      let boot!: ReturnType<typeof createAirplayBoot>;
      let announce!: (event: 'up' | 'down', service: MdnsService) => void;
      let song!: SongRow;
      let decodedStart = 0;
      const f = await apiFixture({
        storeDir: `${dir}/db`,
        hats: {
          layersRoot: 'layers',
          extraPorts: 1,
          env: ([port]) => ({ MELOFON_LISTEN_owntone: `${port},${port}` }),
        },
        services: async (f) => {
          assert(f.notify);
          const libraries = createLibraries(f.store);
          if (!(await libraries.list()).length) {
            await libraries.add('Receiver proof', mediaDir);
            await scanLibrary(f.store);
          }
          const library = createLibrary(f.store);
          [song] = await library.listSongs({ offset: 0, size: 10 });
          assert(song);
          persistence = createPersistence(f.store);
          const saved = await persistence.loadOutputs();
          outputs = createOutputs({ notify: f.notify, persistence });
          devices = createAirplayDevices({
            outputs,
            changed: () => f.notify!.emit(['outputs'], undefined, 'all'),
            resolver: {
              resolve: () => Promise.resolve(receiverService(fake.port)),
              close() {},
            },
          });
          for (const row of saved) devices.register(row);
          playback = createPlayback({
            player: createPlayer(),
            library,
            outputs,
            nowPlaying: createNowPlaying(f.store),
            cfg: f.cfg,
            notify: f.notify,
            persistence,
          });
          const snapshot = await planRestore({
            queueIds: await persistence.loadQueue(),
            saved: await persistence.loadPlayerState(),
            getSong: (id) => library.getSong(id),
            nowMs: Date.now(),
            maxAgeMs: 300000,
            selectedOutputPresent: outputs.list().some((o) => o.selected),
          });
          if (snapshot) playback.restore(snapshot);
          const media = createMedia();
          boot = createAirplayBoot({
            outputs,
            playback,
            notify: f.notify,
            devices,
            media: {
              ...media,
              decodePcm(path: string, options?: { startMs?: number }) {
                decodedStart = options?.startMs ?? 0;
                return media.decodePcm(path, options);
              },
            },
            retryBackoffMs: [],
          });
          discovery = createAirplayDiscovery({
            outputs,
            devices,
            state: f.state,
            savedOutput: (id) => persistence.savedOutput(id),
            createBrowser(callback) {
              announce = callback;
              return { resolve() {}, close() {} };
            },
          });
          await f.state.getTyped('airplay.mdns');
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
      const { credential } = await f.login('bearer');
      const own = async (path: string, method = 'GET', body?: unknown) => {
        const r = await fetch(
          `http://melofon.home:${f.extraPorts[0]}/api${path}`,
          {
            method,
            signal: AbortSignal.timeout(5000),
            headers: { 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
        );
        const text = await r.text();
        assert(r.ok, text);
        return text ? JSON.parse(text) : undefined;
      };
      const read = async () => {
        const r = await f.get('/api/v1/speakers', credential);
        assertEquals(r.status, 200);
        return (await r.json()).speakers;
      };
      const audio = async (sessionIndex: number) => {
        await until(() =>
          (fake.sessions[sessionIndex]?.audioPackets ?? 0) > 400
        );
        const session = fake.sessions[sessionIndex];
        const received = decodeReceiverAudio(
          session.sdp,
          session.audioPayloads,
        );
        const startFrame = Math.round(decodedStart * 44100 / 1000);
        assert(received.length > 44100 * 4);
        assertEquals(
          received,
          input.pcm.subarray(startFrame * 4, startFrame * 4 + received.length),
          'HTTP-selected receiver decoded the exact current-position PCM',
        );
        assert(
          received.some((byte) => byte !== 0),
          'received signal is not silence',
        );
      };
      return {
        f,
        own,
        read,
        audio,
        persistence,
        announce: (event: 'up' | 'down') =>
          announce(event, receiverService(fake.port)),
        play: () => own('/player/play', 'PUT'),
        queue: () =>
          own(
            `/queue/items/add?uris=library:track:${wireInt(song.id)}`,
            'POST',
          ),
        async close() {
          await boot.close();
          await playback.close();
          discovery.close();
          devices.close();
          await persistence.drain();
          await f.close();
        },
      };
    };
    try {
      const t = await setup();
      try {
        t.announce('up');
        assertEquals((await t.read())[0].adopted, false);
        await t.own('/outputs/set', 'PUT', { outputs: [id] });
        await t.own(`/outputs/${id}`, 'PUT', { volume: 37 });
        assertEquals((await t.queue()).count, 1);
        await t.play();
        await t.audio(0);
        const connected = (await t.read())[0];
        assertEquals(connected.state.connection, 'connected');
        assertEquals(connected.state.authentication, 'none');
        assertEquals(connected.abilities.formats, ['pcm']);
        const packets = fake.sessions[0].audioPackets;
        t.announce('down');
        let row = (await t.read())[0];
        assertEquals([row.adopted, row.discovered, row.selected], [
          false,
          false,
          true,
        ]);
        await until(() => fake.sessions[0].audioPackets > packets + 30);
        t.announce('up');
        row = (await t.read())[0];
        assertEquals([row.adopted, row.discovered, row.volume], [
          false,
          true,
          37,
        ]);
        await t.persistence.drain();
        assertEquals(await t.f.store.playback.loadOutputs(), []);
        assertEquals(t.persistence.savedOutput(id), undefined);
        assertEquals((await t.own('/queue')).count, 1);
      } finally {
        await t.close();
      }
      const next = await setup();
      try {
        assertEquals(await next.read(), []);
        assertEquals((await next.own('/outputs')).outputs, []);
        assertEquals((await next.own('/queue')).count, 1);
        assertEquals((await next.own('/player')).state, 'pause');
        next.announce('up');
        assertEquals((await next.read())[0].selected, false);
        await next.own('/outputs/set', 'PUT', { outputs: [id] });
        await next.own(`/outputs/${id}`, 'PUT', { volume: 43 });
        await next.play();
        await next.audio(1);
        const adopt = await next.f.json(
          `/api/v1/speakers/${id}/adopt`,
          'POST',
          {},
          (await next.f.login('cookie')).credential,
        );
        assertEquals(adopt.status, 200, await adopt.clone().text());
        assertEquals((await adopt.json()).speaker.adopted, true);
      } finally {
        await next.close();
      }
      const adopted = await setup();
      try {
        const row = (await adopted.read())[0];
        assertEquals([row.id, row.adopted, row.selected, row.volume], [
          id,
          true,
          true,
          43,
        ]);
        assertEquals(row.discovered, false);
        assertEquals((await adopted.own('/queue')).count, 1);
        await adopted.audio(2);
        assertEquals((await adopted.f.store.speakers.loadAdopted()).length, 1);
      } finally {
        await adopted.close();
      }
    } finally {
      fake.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
