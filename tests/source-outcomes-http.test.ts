// Real HTTP control and real native ALAC consumers, with a deliberately late decoder.
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
import { createLibraries } from '../src/libraries.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { scanLibrary } from '../src/scan.ts';
import { wireInt } from '../layers/owntone/payloads.ts';

Deno.test('HTTP clock and source EOF preserve every buffered tail sample at two native receivers', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-source-tail-' });
  const pcm = (await speakerMedia(dir)).slice(0, 352 * 150 * 4);
  const wav = (await Deno.readFile(`${dir}/media/signal.wav`)).slice(
    0,
    44 + pcm.length,
  );
  const header = new DataView(wav.buffer);
  header.setUint32(4, wav.length - 8, true);
  header.setUint32(40, pcm.length, true);
  await Deno.writeFile(`${dir}/media/signal.wav`, wav);
  const receivers = [
    await startFakeRaop({ captureAudio: true }),
    await startFakeRaop({ captureAudio: true }),
  ];
  let f: Awaited<ReturnType<typeof apiFixture>> | undefined;
  let playback: ReturnType<typeof createPlayback> | undefined;
  let boot: ReturnType<typeof createAirplayBoot> | undefined;
  let devices: ReturnType<typeof createTestAirplayDevices> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let release!: () => void;
  const acquisition = new Promise<void>((done) => release = done);
  let opens = 0, connected = 0, songId = '';
  try {
    f = await apiFixture({
      hats: {
        layersRoot: 'layers',
        extraPorts: 1,
        env: ([port]) => ({ MELOFON_LISTEN_owntone: `${port},${port}` }),
      },
      services: async (f) => {
        assert(f.notify);
        await createLibraries(f.store).add('Tail', `${dir}/media`);
        await scanLibrary(f.store);
        const library = createLibrary(f.store);
        songId = (await library.listSongs({ offset: 0, size: 1 }))[0].id;
        const outputs = createOutputs({ notify: f.notify });
        for (const [i, receiver] of receivers.entries()) {
          outputs.register({
            id: String(i + 1),
            name: `Tail ${i + 1}`,
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
        });
        const media = createMedia();
        boot = createAirplayBoot({
          outputs,
          playback,
          notify: f.notify,
          devices,
          retryBackoffMs: [],
          media: {
            ...media,
            async decodePcm(path) {
              opens++;
              await acquisition;
              // A slow acquisition still yields the entire requested source tail.
              return media.decodePcm(path);
            },
          },
        });
        timer = setInterval(() => void playback!.advanceEnded(), 20);
        return { outputs, playback, library };
      },
    });
    const base = `http://melofon.home:${f.extraPorts[0]}/api`;
    const added = await fetch(
      `${base}/queue/items/add?uris=library:track:${
        wireInt(songId)
      }&playback=start`,
      { method: 'POST', signal: AbortSignal.timeout(5000) },
    );
    assertEquals(added.status, 200, await added.text());
    const read = async () => {
      const response = await fetch(`${base}/player`, {
        signal: AbortSignal.timeout(5000),
      });
      assertEquals(response.status, 200);
      return await response.json();
    };
    await until(() => connected === 2 && opens === 1);
    await new Promise((resolve) => setTimeout(resolve, 1400));
    assertEquals(
      (await read()).state,
      'play',
      'expired duration cannot overtake source acquisition',
    );
    assert(receivers.every((r) => r.sessions[0].audioPayloads.length === 0));
    release();
    await until(() => playback!.playerView().state === 'stop');
    assertEquals((await read()).state, 'stop');
    assertEquals(opens, 1, 'two sinks have one EOF authority');
    for (const receiver of receivers) {
      const session = receiver.sessions[0];
      assertEquals(
        decodeReceiverAudio(session.sdp, session.audioPayloads),
        pcm,
        'every sample, including the final packet, precedes natural stop/flush',
      );
    }
  } finally {
    release();
    clearInterval(timer);
    await boot?.close();
    devices?.close();
    await playback?.close();
    for (const receiver of receivers) receiver.close();
    await f?.close();
    await Deno.remove(dir, { recursive: true });
  }
});
