// Cold plain-HTTP control -> real file decoder -> production boot -> native RAOP.
import { assert, assertEquals } from '@std/assert';
import { apiFixture } from './api.ts';
import { createMedia } from '../../src/media.ts';
import { createLibrary } from '../../src/library.ts';
import { createLibraries } from '../../src/libraries.ts';
import { scanLibrary } from '../../src/scan.ts';
import { createOutputs, createPlayer } from '../../src/player.ts';
import { createPlayback } from '../../src/playback.ts';
import { createNowPlaying } from '../../src/nowplaying.ts';
import { createAirplayBoot } from '../../src/boots/airplay.ts';
import { createFfiStream } from '../../src/boots/raop-ffi.ts';
import { createTestAirplayDevices } from './airplay-devices.ts';
import { startFakeRaop } from './fake-raop.ts';
import { wireInt } from '../../layers/owntone/payloads.ts';
import { traceTimelineAudio } from './raop-timeline-audio.ts';
import type { PlaybackSource } from '../../src/player.ts';
import type {
  AirplayCompletionKey,
  AirplayTimelineStream,
} from '../../src/boots/airplay-profile.ts';
import { createPlaybackSource } from '../../src/playback-source.ts';
import { createRadioSource } from '../../src/radio-source.ts';
import { createNetwork } from '../../src/lookups/net.ts';
import { httpRadio } from './http-radio.ts';

export async function nativeHttpFixture(options: {
  pcm: Uint8Array;
  declaredMs?: number | null;
  acquisition?: Promise<void>;
  web?: 'finite' | 'live';
  afterFirstChunk?: Promise<void>;
}) {
  const directory = await Deno.makeTempDir({ prefix: 'native-http-' });
  await Deno.mkdir(`${directory}/media`);
  const wav = new Uint8Array(44 + options.pcm.length);
  const view = new DataView(wav.buffer), text = new TextEncoder();
  wav.set(text.encode('RIFF'), 0);
  view.setUint32(4, wav.length - 8, true);
  wav.set(text.encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 44100, true);
  view.setUint32(28, 176400, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  wav.set(text.encode('data'), 36);
  view.setUint32(40, options.pcm.length, true);
  wav.set(options.pcm, 44);
  await Deno.writeFile(`${directory}/media/source.wav`, wav);
  const receiver = await startFakeRaop({
    captureAudio: true,
    captureWire: true,
  });
  let playback!: ReturnType<typeof createPlayback>;
  let boot!: ReturnType<typeof createAirplayBoot>;
  let devices!: ReturnType<typeof createTestAirplayDevices>;
  let timer: ReturnType<typeof setInterval> | undefined;
  let opens = 0, songId = '';
  let native!: AirplayTimelineStream, token: PlaybackSource | undefined;
  let key: AirplayCompletionKey | undefined;
  const ackStates: { state: string; generation: number }[] = [];
  const audio = traceTimelineAudio(() => {
    native = createFfiStream();
    return {
      ...native,
      get epoch() {
        return native.epoch;
      },
      async seal(epoch, source, target) {
        const result = await native.seal(epoch, source, target);
        if (result.status === 'accepted') {
          key = { epoch, source, target, revision: 1n };
        }
        return result;
      },
      async ackCompletion(key) {
        ackStates.push(playback.playerView());
        await native.ackCompletion(key);
      },
    };
  });
  const radio = options.web
    ? httpRadio(() => ({
      headers: {
        'content-type': 'audio/wav',
        ...(options.web === 'live'
          ? { 'icy-name': 'Finite live response' }
          : {}),
      },
      body: [wav],
    }))
    : undefined;
  const f = await apiFixture({
    hats: {
      layersRoot: 'layers',
      extraPorts: 1,
      env: ([port]) => ({ MELOFON_LISTEN_owntone: `${port},${port}` }),
    },
    services: async (f) => {
      assert(f.notify);
      await createLibraries(f.store).add('Native gate', `${directory}/media`);
      await scanLibrary(f.store);
      const catalog = createLibrary(f.store);
      songId = (await catalog.listSongs({ offset: 0, size: 1 }))[0].id;
      const library = {
        ...catalog,
        async getSong(id: string) {
          const song = await catalog.getSong(id);
          return song && options.declaredMs !== undefined
            ? { ...song, durationMs: options.declaredMs }
            : song;
        },
      };
      const outputs = createOutputs({ notify: f.notify });
      outputs.register({
        id: '1',
        name: 'Scheduled gate',
        type: 'AirPlay',
        host: '127.0.0.1',
        port: receiver.port,
        selected: true,
        volume: 100,
        connectionStrategy: 'owntone',
      });
      const media = createMedia();
      const sources = createPlaybackSource({
        media,
        state: f.state,
        radio: createRadioSource({
          network: createNetwork({ state: f.state }),
          state: f.state,
        }),
      });
      const engine = createPlayback({
        player: createPlayer(),
        library,
        outputs,
        cfg: f.cfg,
        notify: f.notify,
        nowPlaying: createNowPlaying(f.store),
        ...(options.web
          ? { prepareQueueMedia: sources.prepare, state: f.state }
          : {}),
      });
      if (options.web) await f.state.set('playback.source.retryBackoffMs', '');
      playback = {
        ...engine,
        openSource(...args) {
          token = engine.openSource(...args) ?? undefined;
          return token ?? null;
        },
      };
      devices = createTestAirplayDevices(outputs, undefined, audio.stream);
      boot = createAirplayBoot({
        outputs,
        playback,
        notify: f.notify,
        devices,
        retryBackoffMs: [],
        ...(options.web ? { sources } : {}),
        media: {
          ...media,
          async decodePcm(path, settings) {
            opens++;
            await options.acquisition;
            const decoded = await media.decodePcm(path, settings);
            if (!decoded || !options.afterFirstChunk) return decoded;
            return (async function* () {
              let first = true;
              for await (const chunk of decoded) {
                yield chunk;
                if (first) {
                  first = false;
                  await options.afterFirstChunk;
                }
              }
            })();
          },
        },
      });
      timer = setInterval(() => void playback.advanceEnded(), 10);
      return { outputs, playback, library };
    },
  });
  const own = async (path: string, method = 'GET') => {
    const response = await fetch(
      `http://melofon.home:${f.extraPorts[0]}/api${path}`,
      {
        method,
        signal: AbortSignal.timeout(10000),
      },
    );
    const body = await response.text();
    assertEquals(response.status, method === 'PUT' ? 204 : 200, body);
    return body ? JSON.parse(body) : undefined;
  };
  return {
    receiver,
    playback,
    own,
    audio,
    ackStates,
    get native() {
      return native;
    },
    get token() {
      return token;
    },
    get key() {
      return key;
    },
    get opens() {
      return opens;
    },
    play: () =>
      own(
        `/queue/items/add?uris=${
          encodeURIComponent(
            radio
              ? `${radio.origin}/source`
              : `library:track:${wireInt(songId)}`,
          )
        }&playback=start`,
        'POST',
      ),
    async close() {
      clearInterval(timer);
      await boot.close();
      devices.close();
      await playback.close();
      receiver.close();
      await f.close();
      await radio?.close();
      await Deno.remove(directory, { recursive: true });
    },
  };
}
