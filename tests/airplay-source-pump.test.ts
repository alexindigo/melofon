// Real OwnTone HTTP -> one file decoder -> native shared feed -> two ALAC consumers.
import { assert, assertEquals } from '@std/assert';
import { apiFixture } from './helpers/api.ts';
import { speakerMedia, until } from './helpers/speaker-consumer.ts';
import { startFakeRaop } from './helpers/fake-raop.ts';
import { decodeReceiverAudio } from './helpers/raop-audio-consumer.ts';
import { createTestAirplayDevices } from './helpers/airplay-devices.ts';
import { createFfiSpawn } from '../src/boots/raop-ffi.ts';
import {
  type AirplayTransport,
  createAirplayBoot,
} from '../src/boots/airplay.ts';
import { createMedia } from '../src/media.ts';
import { createOutputs, createPlayer } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';
import { createLibrary } from '../src/library.ts';
import { createLibraries } from '../src/libraries.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { scanLibrary } from '../src/scan.ts';
import { wireInt } from '../layers/owntone/payloads.ts';

Deno.test('HTTP library play uses one source with exact native fan-out and feed-owner handoff', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-one-source-' });
  const pcm = (await speakerMedia(dir)).slice(0, 352 * 250 * 4);
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
  let boot: ReturnType<typeof createAirplayBoot> | undefined;
  let devices: ReturnType<typeof createTestAirplayDevices> | undefined;
  let playback: ReturnType<typeof createPlayback> | undefined;
  let f: Awaited<ReturnType<typeof apiFixture>> | undefined;
  const native: AirplayTransport[] = [];
  const ports: number[] = [];
  const connected = new Set<number>();
  const starts: number[] = [];
  let songId = '';
  try {
    f = await apiFixture({
      hats: {
        layersRoot: 'layers',
        extraPorts: 1,
        env: ([port]) => ({ MELOFON_LISTEN_owntone: `${port},${port}` }),
      },
      services: async (f) => {
        assert(f.notify);
        await createLibraries(f.store).add('One source', `${dir}/media`);
        await scanLibrary(f.store);
        const library = createLibrary(f.store);
        songId = (await library.listSongs({ offset: 0, size: 1 }))[0].id;
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
        devices = createTestAirplayDevices(outputs, (event) => {
          const i = native.length;
          const driver = spawn((name, value) => {
            if (name === 'state' && value === 'connected') connected.add(i);
            event(name, value);
          });
          native.push(driver.transport);
          return {
            transport: driver.transport,
            start(profile, input, credentials) {
              ports[i] = profile.port;
              return driver.start(profile, input, credentials);
            },
          };
        });
        // Fix the engine's clock at the head. Both runs are exactly packet-sized;
        // this checks every sample, independently of decoder/native read-ahead.
        playback = createPlayback({
          player: createPlayer({ now: () => 0, monotonicNow: () => 0 }),
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
            async decodePcm(path, opts) {
              starts.push(opts?.startMs ?? 0);
              await until(() => connected.size === 2);
              return media.decodePcm(path, opts);
            },
          },
        });
        return { outputs, playback, library };
      },
    });
    const own = async (path: string, method: string, body?: unknown) => {
      const response = await fetch(
        `http://melofon.home:${f!.extraPorts[0]}/api${path}`,
        {
          method,
          signal: AbortSignal.timeout(5000),
          headers: { 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      assertEquals(response.status, 204, await response.text());
    };
    // Queue add returns JSON, unlike the player/output controls.
    const added = await fetch(
      `http://melofon.home:${
        f.extraPorts[0]
      }/api/queue/items/add?uris=library:track:${
        wireInt(songId)
      }&playback=start`,
      { method: 'POST', signal: AbortSignal.timeout(5000) },
    );
    assertEquals(added.status, 200, await added.text());
    await until(() =>
      receivers.every((r) => (r.sessions[0]?.audioPayloads.length ?? 0) >= 250)
    );
    assertEquals(starts, [0], 'one source open for both receivers');
    for (const receiver of receivers) {
      const session = receiver.sessions[0];
      assertEquals(
        decodeReceiverAudio(session.sdp, session.audioPayloads),
        pcm,
        'every source sample arrives once, including the final packet',
      );
    }
    const feed = native.findIndex((t) => t.ownsSharedFeed());
    assert(feed >= 0);
    const owner = receivers.findIndex((r) => r.port === ports[feed]);
    assert(owner >= 0);
    const survivor = 1 - owner;
    await own('/outputs/set', 'PUT', { outputs: [String(survivor + 1)] });
    await until(() =>
      receivers[survivor].sessions[0].audioPayloads.length >= 500
    );
    assertEquals(
      starts,
      [0, 0],
      'one fresh current-position source after owner release',
    );
    assertEquals(
      receivers[survivor].sessions.length,
      1,
      'healthy receiver session persists',
    );
    const twice = new Uint8Array(pcm.length * 2);
    twice.set(pcm);
    twice.set(pcm, pcm.length);
    const session = receivers[survivor].sessions[0];
    assertEquals(
      decodeReceiverAudio(session.sdp, session.audioPayloads),
      twice,
    );
  } finally {
    await boot?.close();
    devices?.close();
    await playback?.close();
    for (const receiver of receivers) receiver.close();
    await f?.close();
    await Deno.remove(dir, { recursive: true });
  }
});
