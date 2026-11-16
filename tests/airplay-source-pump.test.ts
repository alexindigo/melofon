// Real OwnTone HTTP -> one file decoder -> boot-owned stream -> two consumers.
import { assert, assertEquals } from '@std/assert';
import { apiFixture } from './helpers/api.ts';
import { speakerMedia, until } from './helpers/speaker-consumer.ts';
import { startFakeRaop } from './helpers/fake-raop.ts';
import { decodeReceiverAudio } from './helpers/raop-audio-consumer.ts';
import { renderScheduledAudio } from './helpers/raop-scheduled-consumer.ts';
import {
  createTestAirplayDevices,
  mapStream,
} from './helpers/airplay-devices.ts';
import { createFfiStream } from '../src/boots/raop-ffi.ts';
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

for (const removed of [-1, 0, 1]) {
  Deno.test(
    removed < 0
      ? 'HTTP library stream: one decoder feeds two exact scheduled consumers'
      : `HTTP library stream: detach ${
        removed + 1
      } preserves one decoder, exact partial PCM and PTS`,
    async () => {
      const dir = await Deno.makeTempDir({ prefix: 'melofon-one-source-' });
      const packets = removed < 0 ? 250 : 2;
      const pcm = (await speakerMedia(dir)).slice(0, 352 * packets * 4);
      const wav = (await Deno.readFile(`${dir}/media/signal.wav`)).slice(
        0,
        44 + pcm.length,
      );
      const header = new DataView(wav.buffer);
      header.setUint32(4, wav.length - 8, true);
      header.setUint32(40, pcm.length, true);
      await Deno.writeFile(`${dir}/media/signal.wav`, wav);
      const receivers = [
        await startFakeRaop({ captureAudio: true, captureWire: true }),
        await startFakeRaop({ captureAudio: true, captureWire: true }),
      ];
      let boot: ReturnType<typeof createAirplayBoot> | undefined;
      let devices: ReturnType<typeof createTestAirplayDevices> | undefined;
      let playback: ReturnType<typeof createPlayback> | undefined;
      let f: Awaited<ReturnType<typeof apiFixture>> | undefined;
      const native: AirplayTransport[] = [];
      const ports: number[] = [];
      const connected = new Set<number>();
      const starts: number[] = [];
      const resume = Promise.withResolvers<void>();
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
            devices = createTestAirplayDevices(
              outputs,
              undefined,
              mapStream(createFfiStream, (spawn) => (event) => {
                const i = native.length;
                const driver = spawn((name, value) => {
                  if (name === 'state' && value === 'connected') {
                    connected.add(i);
                  }
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
              }),
            );
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
                  const decoded = await media.decodePcm(path, opts);
                  assert(decoded);
                  return {
                    async *[Symbol.asyncIterator]() {
                      // Real lossless decode, split at exactly one pacer tick so an
                      // 89-frame native partial exists across the HTTP detach.
                      let offset = 0;
                      for await (const chunk of decoded) {
                        let from = 0;
                        if (
                          offset < 441 * 4 && offset + chunk.length >= 441 * 4
                        ) {
                          from = 441 * 4 - offset;
                          yield chunk.subarray(0, from);
                          await resume.promise;
                        }
                        if (from < chunk.length) yield chunk.subarray(from);
                        offset += chunk.length;
                      }
                    },
                  };
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
          receivers.every((r) => r.sessions[0]?.audioPackets === 1)
        );
        assertEquals(starts, [0], 'one source open for both receivers');
        for (const receiver of receivers) {
          const session = receiver.sessions[0];
          assertEquals(
            decodeReceiverAudio(session.sdp, session.audioPayloads),
            pcm.subarray(0, 352 * 4),
            'identical first packet at both receivers from one decoder',
          );
        }
        assertEquals(native.length, 2);
        assert(native.every((t) => !t.ownsSharedFeed()));
        assertEquals(new Set(ports).size, 2);
        const survivor = removed < 0 ? 0 : 1 - removed;
        const timestamp = (i: number) =>
          receivers[survivor].sessions[0].wire.flatMap((e) =>
            e.kind === 'audio'
              ? [new DataView(e.data.buffer, e.data.byteOffset).getUint32(4)]
              : []
          )[i];
        const firstTimestamp = timestamp(0);
        if (removed >= 0) {
          await own('/outputs/set', 'PUT', { outputs: [String(survivor + 1)] });
          await until(() => receivers[removed].sessions[0].closedAtMs !== null);
        }
        resume.resolve();
        await until(() =>
          receivers[survivor].sessions[0].audioPackets === packets
        );
        assertEquals(
          starts,
          [0],
          'attachment departure never reopens the source',
        );
        assertEquals(
          receivers[survivor].sessions.length,
          1,
          'healthy receiver session persists',
        );
        const session = receivers[survivor].sessions[0];
        assertEquals(
          decodeReceiverAudio(session.sdp, session.audioPayloads),
          pcm,
        );
        assertEquals(timestamp(1), (firstTimestamp + 352) >>> 0);
        await until(() => session.wire.some((e) => e.kind === 'timing-reply'));
        const pending = renderScheduledAudio(
          session,
          receivers[survivor].nowMs(),
        );
        assertEquals(pending.issues, []);
        assert(
          pending.lastPresentationAtMs !== null &&
            pending.clockUncertaintyMs !== null,
        );
        await until(() =>
          receivers[survivor].nowMs() >
            pending.lastPresentationAtMs! + pending.clockUncertaintyMs!
        );
        const rendered = renderScheduledAudio(
          session,
          receivers[survivor].nowMs(),
        );
        assertEquals(rendered.pcm, pcm);
        assertEquals(rendered.pendingFrames, 0);
        assertEquals(rendered.discarded, []);
        assertEquals(session.flushes, 0);
        assertEquals(session.teardowns, 0);
        if (removed < 0) {
          const other = receivers[1];
          await until(() =>
            other.sessions[0].audioPackets === packets &&
            other.sessions[0].wire.some((e) => e.kind === 'timing-reply')
          );
          const pendingOther = renderScheduledAudio(
            other.sessions[0],
            other.nowMs(),
          );
          assertEquals(pendingOther.issues, []);
          assert(
            pendingOther.lastPresentationAtMs !== null &&
              pendingOther.clockUncertaintyMs !== null,
          );
          await until(() =>
            other.nowMs() >
              pendingOther.lastPresentationAtMs! +
                pendingOther.clockUncertaintyMs!
          );
          const otherRendered = renderScheduledAudio(
            other.sessions[0],
            other.nowMs(),
          );
          assertEquals(otherRendered.pcm, pcm);
          assertEquals(otherRendered.pendingFrames, 0);
          assertEquals(otherRendered.discarded, []);
          assertEquals(other.sessions.length, 1);
          assertEquals(other.sessions[0].flushes, 0);
          assertEquals(other.sessions[0].teardowns, 0);
          const timestamps = (wire: typeof session.wire) =>
            wire.flatMap((event) =>
              event.kind === 'audio'
                ? [
                  new DataView(event.data.buffer, event.data.byteOffset)
                    .getUint32(4),
                ]
                : []
            );
          assertEquals(
            timestamps(other.sessions[0].wire),
            timestamps(session.wire),
            'both receivers share the same native transport timeline',
          );
        }
        const expected = await Deno.realPath(
          new URL('../helper/raop/libmelofon_raop.so', import.meta.url),
        );
        assertEquals(
          await Deno.realPath(Deno.env.get('MELOFON_RAOP_LIB')!),
          expected,
        );
        assert(
          (await Deno.readTextFile('/proc/self/maps')).split('\n').some((
            line,
          ) => line.endsWith(` ${expected}`)),
        );
        const hash = new Uint8Array(
          await crypto.subtle.digest('SHA-256', await Deno.readFile(expected)),
        );
        console.log(
          `boot stream native library: ${expected} sha256=${
            Array.from(hash, (v) => v.toString(16).padStart(2, '0')).join('')
          }`,
        );
      } finally {
        resume.resolve();
        await boot?.close();
        devices?.close();
        await playback?.close();
        for (const receiver of receivers) receiver.close();
        await f?.close();
        await Deno.remove(dir, { recursive: true });
      }
    },
  );
}
