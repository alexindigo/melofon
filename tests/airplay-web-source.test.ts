// Core enqueue -> real OwnTone controls/reads -> net/ICY/native -> ALAC consumers.
import { assert, assertEquals } from '@std/assert';
import { apiFixture } from './helpers/api.ts';
import { speakerMedia, until } from './helpers/speaker-consumer.ts';
import { startFakeRaop } from './helpers/fake-raop.ts';
import { decodeReceiverAudio } from './helpers/raop-audio-consumer.ts';
import { createTestAirplayDevices } from './helpers/airplay-devices.ts';
import { createFfiSpawn } from '../src/boots/raop-ffi.ts';
import { createAirplayBoot } from '../src/boots/airplay.ts';
import { createMedia } from '../src/media.ts';
import { createOutputs, createPlayer } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';
import { createLibrary } from '../src/library.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createRadio } from '../src/radio.ts';
import { createNetwork } from '../src/lookups/net.ts';
import { createRadioSource } from '../src/radio-source.ts';
import { createPlaybackSource } from '../src/playback-source.ts';
import {
  createQueueResolver,
  type QueueReference,
} from '../src/queue-source.ts';
import { httpRadio, icyBlock } from './helpers/http-radio.ts';

const command = { kind: 'internal' as const, via: 'web-source-consumer' };

Deno.test('core station and URL sources deliver exact ICY-stripped audio to two native receivers with one connection', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'airplay-web-source-' });
  const pcm = (await speakerMedia(dir)).slice(0, 352 * 400 * 4);
  const wav = (await Deno.readFile(`${dir}/media/signal.wav`)).slice(
    0,
    44 + pcm.length,
  );
  // An unbounded WAV source keeps the decoder waiting for live bytes after the
  // signal. No artificial EOF can pause the live engine before receiver playout.
  new DataView(wav.buffer).setUint32(4, 0xffffffff, true);
  new DataView(wav.buffer).setUint32(40, 0xffffffff, true);
  const server = httpRadio((request, disconnected) => {
    const path = new URL(request.url).pathname;
    if (path === '/station.pls') {
      return {
        body: [new TextEncoder().encode('[playlist]\nFile1=/station.m3u\n')],
      };
    }
    if (path === '/station.m3u') {
      return { body: [new TextEncoder().encode('/audio')] };
    }
    return {
      headers: {
        'content-type': 'audio/wav',
        'icy-metaint': '4093',
        'icy-name': 'Wire station',
      },
      body: (async function* () {
        for (let at = 0; at < wav.length; at += 4093) {
          yield wav.subarray(at, at + 4093);
          if (at + 4093 <= wav.length) {
            yield icyBlock("StreamTitle='Artist - Not PCM';");
          }
        }
        await new Promise<void>((done) => {
          if (disconnected.aborted) done();
          else {
            disconnected.addEventListener('abort', () => done(), {
              once: true,
            });
          }
        });
      })(),
    };
  });
  const receivers = [
    await startFakeRaop({ captureAudio: true }),
    await startFakeRaop({ captureAudio: true }),
  ];
  let boot: ReturnType<typeof createAirplayBoot> | undefined;
  let devices: ReturnType<typeof createTestAirplayDevices> | undefined;
  let playback: ReturnType<typeof createPlayback> | undefined;
  let resolve!: ReturnType<typeof createQueueResolver>;
  let stationId = '', opens = 0, connected = 0;
  let f: Awaited<ReturnType<typeof apiFixture>> | undefined;
  try {
    f = await apiFixture({
      hats: {
        layersRoot: 'layers',
        extraPorts: 1,
        env: ([port]) => ({ MELOFON_LISTEN_owntone: `${port},${port}` }),
      },
      services: async (f) => {
        assert(f.notify);
        const library = createLibrary(f.store);
        const radio = createRadio(f.store);
        const station = await radio.create({
          name: 'Saved station',
          streamUrl: `${server.origin}/station.pls`,
          homePageUrl: null,
        });
        assert(!('invalid' in station));
        stationId = station.id;
        resolve = createQueueResolver({
          getSong: (id) => library.getSong(id),
          getStation: (id) => radio.get(id),
        });
        const outputs = createOutputs({ notify: f.notify });
        for (const [i, receiver] of receivers.entries()) {
          outputs.register({
            id: String(i + 1),
            name: `Receiver ${i + 1}`,
            type: 'AirPlay',
            host: '127.0.0.1',
            port: receiver.port,
            selected: true,
            volume: 100,
            connectionStrategy: 'owntone',
          });
        }
        const spawn = createFfiSpawn();
        devices = createTestAirplayDevices(
          outputs,
          (event) =>
            spawn((name, value) => {
              if (name === 'state' && value === 'connected') connected++;
              event(name, value);
            }),
        );
        playback = createPlayback({
          player: createPlayer(),
          outputs,
          library,
          cfg: f.cfg,
          notify: f.notify,
          nowPlaying: createNowPlaying(f.store),
          resolveQueueReference: resolve,
        });
        const media = createMedia();
        const sources = createPlaybackSource({
          media,
          radio: createRadioSource({
            network: createNetwork({ state: f.state }),
            state: f.state,
          }),
        });
        boot = createAirplayBoot({
          outputs,
          playback,
          media,
          notify: f.notify,
          devices,
          retryBackoffMs: [],
          sources: {
            async open(input, options) {
              opens++;
              await until(() => connected >= opens * 2);
              return sources.open(input, options);
            },
          },
        });
        return { outputs, playback, library };
      },
    });
    const own = async (path: string, method = 'GET') => {
      const response = await fetch(
        `http://melofon.home:${f!.extraPorts[0]}/api${path}`,
        { method, signal: AbortSignal.timeout(5000) },
      );
      const body = await response.text();
      assertEquals(response.status, method === 'GET' ? 200 : 204, body);
      return method === 'GET' ? JSON.parse(body) : undefined;
    };
    for (
      const [index, reference] of ([{ kind: 'station', id: stationId }, {
        kind: 'url',
        url: `${server.origin}/audio`,
      }] satisfies QueueReference[]).entries()
    ) {
      const media = await resolve(reference);
      assert(media);
      await playback!.queueAddSources([media], { clear: true }, command);
      await own('/player/play', 'PUT');
      await until(() =>
        receivers.every((r) =>
          (r.sessions[index]?.audioPayloads.length ?? 0) >= 200
        )
      );
      for (const receiver of receivers) {
        const session = receiver.sessions[index];
        assertEquals(
          decodeReceiverAudio(session.sdp, session.audioPayloads.slice(0, 200)),
          pcm.slice(0, 352 * 200 * 4),
        );
      }
      assertEquals(
        opens,
        index + 1,
        'one decoder lifetime per activation, not per sink',
      );
      assertEquals(
        server.requests.filter((r) => new URL(r.url).pathname === '/audio')
          .length,
        index + 1,
        'one upstream audio connection',
      );
      const queue = await own('/queue');
      assertEquals(queue.items[0].data_kind, 'http');
      assertEquals((await own('/player')).state, 'play');
      await own('/player/stop', 'PUT');
      await until(() => server.closed === server.requests.length);
    }
    // Public URL admission now uses the same core reference/source pipeline.
    const admitted = await fetch(
      `http://melofon.home:${f.extraPorts[0]}/api/queue/items/add?uris=${
        encodeURIComponent(`${server.origin}/audio`)
      }&clear=true&playback=start`,
      { method: 'POST', signal: AbortSignal.timeout(5000) },
    );
    assertEquals(admitted.status, 200, await admitted.text());
    assertEquals(playback!.queueView().items.length, 1);
    await until(() => opens === 3);
    await own('/player/stop', 'PUT');
    await until(() => server.closed === server.requests.length);
  } finally {
    await boot?.close();
    devices?.close();
    await playback?.close();
    for (const receiver of receivers) receiver.close();
    await f?.close();
    await server.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('OwnTone pause/stop/next cancel web resolution, probe and active decoder reads without stale outcomes', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'airplay-web-cancel-' });
  await speakerMedia(dir);
  const wav = (await Deno.readFile(`${dir}/media/signal.wav`)).slice(
    0,
    44 + 352 * 400 * 4,
  );
  new DataView(wav.buffer).setUint32(4, 0xffffffff, true);
  new DataView(wav.buffer).setUint32(40, 0xffffffff, true);
  const parked = new Set<string>();
  const server = httpRadio((request, disconnected) => ({
    body: (async function* () {
      const path = new URL(request.url).pathname;
      if (path.includes('probe')) yield new TextEncoder().encode('ID3');
      if (path.includes('playing')) yield wav;
      parked.add(path);
      await new Promise<void>((done) => {
        if (disconnected.aborted) done();
        else {
          disconnected.addEventListener('abort', () => done(), { once: true });
        }
      });
    })(),
  }));
  let boot: ReturnType<typeof createAirplayBoot> | undefined;
  let devices: ReturnType<typeof createTestAirplayDevices> | undefined;
  let playback: ReturnType<typeof createPlayback> | undefined;
  let resolve!: ReturnType<typeof createQueueResolver>;
  let pcmBytes = 0, released = 0;
  let f: Awaited<ReturnType<typeof apiFixture>> | undefined;
  try {
    f = await apiFixture({
      hats: {
        layersRoot: 'layers',
        extraPorts: 1,
        env: ([port]) => ({ MELOFON_LISTEN_owntone: `${port},${port}` }),
      },
      services: (f) => {
        assert(f.notify);
        const library = createLibrary(f.store);
        const outputs = createOutputs({ notify: f.notify });
        outputs.register({
          id: '1',
          name: 'Recording receiver',
          type: 'AirPlay',
          host: '127.0.0.1',
          port: 7000,
          selected: true,
          volume: 100,
          connectionStrategy: 'owntone',
        });
        devices = createTestAirplayDevices(outputs, (event) => ({
          transport: {
            send: () => Promise.resolve(),
            pcm(chunk) {
              pcmBytes += chunk.length;
              return Promise.resolve();
            },
            cancelPcm() {},
            ownsSharedFeed: () => true,
            close: () => Promise.resolve(),
          },
          start() {
            queueMicrotask(() => event('state', 'connected'));
            return Promise.resolve();
          },
        }));
        resolve = createQueueResolver({
          getSong: (id) => library.getSong(id),
          getStation: () => Promise.resolve(null),
        });
        playback = createPlayback({
          player: createPlayer(),
          outputs,
          library,
          cfg: f.cfg,
          notify: f.notify,
          nowPlaying: createNowPlaying(f.store),
          resolveQueueReference: resolve,
        });
        const media = createMedia();
        const sources = createPlaybackSource({
          media: {
            ...media,
            async decodeInputPcm(input, options) {
              const result = await media.decodeInputPcm(input, options);
              void result.completion.then(() => released++);
              return result;
            },
          },
          radio: createRadioSource({ network: createNetwork() }),
        });
        boot = createAirplayBoot({
          outputs,
          playback,
          media,
          sources,
          devices,
          notify: f.notify,
          retryBackoffMs: [],
        });
        return Promise.resolve({ outputs, playback, library });
      },
    });
    const control = async (action: string) => {
      const response = await fetch(
        `http://melofon.home:${f!.extraPorts[0]}/api/player/${action}`,
        { method: 'PUT', signal: AbortSignal.timeout(5000) },
      );
      assertEquals(response.status, 204, await response.text());
    };
    for (const phase of ['headers', 'probe', 'playing']) {
      for (const action of ['pause', 'stop', 'next']) {
        const path = `/${phase}-${action}`;
        const first = await resolve({
          kind: 'url',
          url: `${server.origin}${path}`,
        });
        const next = await resolve({
          kind: 'url',
          url: `${server.origin}/next-${phase}-${action}`,
        });
        assert(first && next);
        const before = pcmBytes, completed = released;
        await playback!.queueAddSources(
          [first, next],
          { clear: true },
          command,
        );
        await control('play');
        await until(() =>
          parked.has(path) && (phase !== 'playing' || pcmBytes > before)
        );
        const old = playback!.playerView().current!.id;
        await control(action);
        if (action === 'next') {
          await until(() => parked.has(`/next-${phase}-${action}`));
          assert(playback!.playerView().current!.id !== old);
          assertEquals(
            playback!.playerView().state,
            'play',
            'cancelled old decode cannot pause its successor',
          );
          await control('stop');
        } else {
          assertEquals(
            playback!.playerView().state,
            action === 'pause' ? 'pause' : 'stop',
          );
        }
        await until(() => server.closed === server.requests.length);
        if (phase === 'playing') await until(() => released > completed);
        assertEquals(
          server.requests.filter((r) => new URL(r.url).pathname === path)
            .length,
          1,
          'cancel does not reconnect',
        );
        await control('stop');
      }
    }
  } finally {
    await boot?.close();
    devices?.close();
    await playback?.close();
    await f?.close();
    await server.close();
    await Deno.remove(dir, { recursive: true });
  }
});
