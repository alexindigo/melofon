// Non-loopback HTTP -> real lossless decoder -> production boot/exact stream ->
// shipping native library -> independently scheduled UDP/ALAC consumer.
import { assert, assertEquals } from '@std/assert';
import { fixturePcm } from './helpers/decoded-pcm.ts';
import { apiFixture } from './helpers/api.ts';
import { until } from './helpers/speaker-consumer.ts';
import { createTestAirplayDevices } from './helpers/airplay-devices.ts';
import { startFakeRaop } from './helpers/fake-raop.ts';
import { decodeReceiverAudio } from './helpers/raop-audio-consumer.ts';
import { traceTimelineAudio } from './helpers/raop-timeline-audio.ts';
import { renderScheduledAudio } from './helpers/raop-scheduled-consumer.ts';
import { createFfiStream } from '../src/boots/raop-ffi.ts';
import type { AirplayAppendResult } from '../src/boots/airplay-profile.ts';
import { createAirplayBoot } from '../src/boots/airplay.ts';
import { createMedia } from '../src/media.ts';
import { createOutputs, createPlayer } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';
import { createLibrary } from '../src/library.ts';
import { createLibraries } from '../src/libraries.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { scanLibrary } from '../src/scan.ts';
import type { ConnectionStrategy } from '../src/connection-strategy.ts';
import { wireInt } from '../layers/owntone/payloads.ts';

function pcm(frames: number, seed: number) {
  const bytes = new Uint8Array(frames * 4), view = new DataView(bytes.buffer);
  for (let i = 0; i < frames; i++) {
    view.setInt16(i * 4, 1000 + (i + seed) % 12000, true);
    view.setInt16(i * 4 + 2, -900 - (i * 3 + seed) % 13000, true);
  }
  return bytes;
}
async function wav(path: string, pcm: Uint8Array) {
  const bytes = new Uint8Array(44 + pcm.length), h = new DataView(bytes.buffer);
  const e = new TextEncoder();
  bytes.set(e.encode('RIFF'));
  h.setUint32(4, bytes.length - 8, true);
  bytes.set(e.encode('WAVEfmt '), 8);
  h.setUint32(16, 16, true);
  h.setUint16(20, 1, true);
  h.setUint16(22, 2, true);
  h.setUint32(24, 44100, true);
  h.setUint32(28, 176400, true);
  h.setUint16(32, 4, true);
  h.setUint16(34, 16, true);
  bytes.set(e.encode('data'), 36);
  h.setUint32(40, pcm.length, true);
  bytes.set(pcm, 44);
  await Deno.writeFile(path, bytes);
}
async function libraryProof() {
  const path = await Deno.realPath(
    new URL('../helper/raop/libmelofon_raop.so', import.meta.url),
  );
  assertEquals(await Deno.realPath(Deno.env.get('MELOFON_RAOP_LIB')!), path);
  assert(
    (await Deno.readTextFile('/proc/self/maps')).split('\n').some((line) =>
      line.endsWith(` ${path}`)
    ),
  );
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', await Deno.readFile(path)),
  );
  console.log(
    `boot cancellation native library: ${path} sha256=${
      Array.from(hash, (v) => v.toString(16).padStart(2, '0')).join('')
    }`,
  );
}

async function scenario(
  strategy: ConnectionStrategy,
  mode: 'replace' | 'backpressure' | 'close' | 'supersede',
) {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-boot-cancel-' });
  await Deno.mkdir(`${dir}/media`);
  const old = pcm(mode === 'backpressure' ? 251 * 352 : 353, 100);
  const replacement = pcm(352, 8000);
  await wav(`${dir}/media/a.wav`, old);
  await wav(`${dir}/media/b.wav`, replacement);
  const flush = Promise.withResolvers<void>(),
    tail = Promise.withResolvers<void>();
  const receiver = await startFakeRaop({
    captureAudio: true,
    captureWire: true,
    beforeFlushReply: () => flush.promise,
  });
  let boot: ReturnType<typeof createAirplayBoot> | undefined;
  let devices: ReturnType<typeof createTestAirplayDevices> | undefined;
  let playback: ReturnType<typeof createPlayback> | undefined;
  let f: Awaited<ReturnType<typeof apiFixture>> | undefined;
  const opens: string[] = [], audio: number[] = [];
  const appends: { bytes: Uint8Array; receipt: AirplayAppendResult }[] = [];
  const cancels: { epoch: bigint; retire: readonly bigint[] }[] = [];
  const acknowledgments: bigint[] = [];
  const cancelAck = Promise.withResolvers<void>();
  let attachmentCount = 0;
  const completedAudio = traceTimelineAudio(createFfiStream);
  let ids: string[] = [];
  try {
    f = await apiFixture({
      hats: {
        layersRoot: 'layers',
        extraPorts: 1,
        env: ([port]) => ({ MELOFON_LISTEN_owntone: `${port},${port}` }),
      },
      services: async (f) => {
        assert(f.notify);
        await createLibraries(f.store).add('Cancellation', `${dir}/media`);
        await scanLibrary(f.store);
        const library = createLibrary(f.store);
        ids = (await library.listSongs({ offset: 0, size: 10 })).sort((a, b) =>
          a.path.localeCompare(b.path)
        ).map((s) => s.id);
        const outputs = createOutputs({ notify: f.notify });
        outputs.register({
          id: '1',
          name: 'Receiver',
          type: 'AirPlay',
          host: '127.0.0.1',
          port: receiver.port,
          selected: true,
          volume: 100,
          connectionStrategy: strategy,
        });
        devices = createTestAirplayDevices(outputs, undefined, () => {
          const native = completedAudio.stream();
          return {
            ...native,
            get epoch() {
              return native.epoch;
            },
            attach(...args: Parameters<typeof native.attach>) {
              const attached = native.attach(...args);
              const first = ++attachmentCount === 1;
              const transport = attached.transport;
              return {
                ...attached,
                transport: {
                  send: transport.send.bind(transport),
                  pcm: transport.pcm.bind(transport),
                  ownsSharedFeed: transport.ownsSharedFeed.bind(transport),
                  cancelPcm: transport.cancelPcm.bind(transport),
                  async close() {
                    await transport.close();
                    if (
                      first && strategy !== 'owntone' && mode === 'replace'
                    ) {
                      await cancelAck.promise;
                      // Drain ACK/reset microtasks before publishing attachment
                      // retirement. This forces the formerly racy empty-set gap.
                      await new Promise<void>((resolve) =>
                        setTimeout(resolve, 0)
                      );
                    }
                  },
                },
              };
            },
            async appendSource(
              input: Parameters<
                ReturnType<typeof createFfiStream>['appendSource']
              >[0],
            ) {
              const receipt = await native.appendSource(input);
              appends.push({ bytes: input.pcm.slice(), receipt });
              return receipt;
            },
            cancel(epoch, retire = []) {
              cancels.push({ epoch, retire: [...retire] });
              const result = native.cancel(epoch, retire);
              assertEquals(
                native.epoch,
                epoch + 1n,
                'fence is synchronous through lazy device boundary',
              );
              return result;
            },
            async ackCancel(epoch) {
              await native.ackCancel(epoch);
              acknowledgments.push(epoch);
              cancelAck.resolve();
            },
            pcm() {
              throw new Error('production must use exact append');
            },
            reset() {
              throw new Error('production must use ordered cancel');
            },
            cancelPcm() {/* Only legacy close calls may reach this shim. */},
          };
        });
        const core = createPlayback({
          player: createPlayer(),
          outputs,
          library,
          cfg: f.cfg,
          notify: f.notify,
          nowPlaying: createNowPlaying(f.store),
        });
        playback = {
          ...core,
          sourceAudio(lease, ms) {
            audio.push(ms);
            return core.sourceAudio(lease, ms);
          },
        };
        const media = createMedia();
        boot = createAirplayBoot({
          outputs,
          playback,
          media: {
            ...media,
            async decodePcm(path, options) {
              // This fixture isolates explicit cancellation. Keep speculative B
              // before decoder acquisition; it must be canceled and joined, not
              // mistaken for the replacement admitted after reset readiness.
              const current = playback!.playerView().current;
              if (
                path.endsWith('/b.wav') && current?.facts.kind === 'song' &&
                current.facts.song.path !== path
              ) {
                await new Promise<void>((resolve) => {
                  options!.signal!.addEventListener('abort', () => resolve(), {
                    once: true,
                  });
                  if (options!.signal!.aborted) resolve();
                });
                options!.signal!.throwIfAborted();
              }
              opens.push(path);
              const decoded = await media.decodePcm(path, options);
              assert(decoded);
              const chunks: Uint8Array[] = [];
              for await (const chunk of decoded) chunks.push(chunk);
              const bytes = new Uint8Array(
                chunks.reduce((n, c) => n + c.length, 0),
              );
              let offset = 0;
              for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.length;
              }
              return fixturePcm({
                async *[Symbol.asyncIterator]() {
                  if (path.endsWith('/b.wav')) {
                    yield bytes.subarray(0, 351 * 4);
                    await tail.promise;
                    yield bytes.subarray(351 * 4); // explicit real packet-completing frame, not b04 padding
                  } else yield bytes; // real decoded PCM in one oversized ingress call
                },
              }, decoded);
            },
          },
          notify: f.notify,
          devices,
          retryBackoffMs: [],
        });
        return { outputs, playback, library };
      },
    });
    const own = async (path: string) => {
      const response = await fetch(
        `http://melofon.home:${f!.extraPorts[0]}/api${path}`,
        { method: 'PUT', signal: AbortSignal.timeout(5000) },
      );
      assertEquals(response.status, 204, await response.text());
    };
    const added = await fetch(
      `http://melofon.home:${f.extraPorts[0]}/api/queue/items/add?uris=${
        (mode === 'backpressure' ? ids.slice(0, 1) : ids)
          .map((id) => `library:track:${wireInt(id)}`).join(',')
      }&playback=start`,
      { method: 'POST', signal: AbortSignal.timeout(5000) },
    );
    assertEquals(added.status, 200, await added.text());
    await until(() => receiver.sessions[0]?.audioPackets >= 1);
    if (mode === 'backpressure') {
      await until(() => completedAudio.epochs.length === 1);
      const receipts = appends.filter((a) => a.receipt.epoch === 1n);
      assert(
        receipts.some((a) =>
          a.receipt.status === 'backpressure' && a.receipt.acceptedFrames > 0n
        ),
      );
      let offset = 0;
      for (const a of receipts) {
        assertEquals(
          a.bytes,
          old.subarray(offset),
          'retry only the unaccepted suffix',
        );
        offset += Number(a.receipt.acceptedFrames) * 4;
      }
      assertEquals(offset, old.length);
      assertEquals(new Set(receipts.map((a) => a.receipt.segment)).size, 1);
      assertEquals(
        completedAudio.realAudio(receiver.sessions[0]),
        old,
      );
      assertEquals(
        Math.round(audio.reduce((a, b) => a + b, 0) * 44.1),
        old.length / 4,
      );
    } else {
      await own('/player/next');
      await until(() => cancels.length === 1);
      if (strategy === 'owntone') {
        await until(() => receiver.sessions[0].flushes === 1);
        assertEquals(
          opens.length,
          1,
          'no replacement decoder before old FLUSH readiness',
        );
        assertEquals(appends.length, 1);
        if (mode === 'close') {
          const closing = boot!.close();
          assertEquals(boot!.close(), closing);
          await closing; // held ACK is deliberately still unresolved
          await until(() => receiver.sessions[0].closedAtMs !== null);
          assertEquals(opens.length, 1);
          await libraryProof();
          return;
        }
        if (mode === 'supersede') {
          await own('/player/seek?position_ms=0');
          assertEquals(
            cancels.length,
            1,
            'new intent shares the already-fenced empty epoch',
          );
          assertEquals(
            opens.length,
            1,
            'newer intent cannot bypass held readiness',
          );
        }
        flush.resolve();
      }
      await until(() => appends.some((a) => a.receipt.acceptedFrames === 351n));
      const b = appends.find((a) => a.receipt.acceptedFrames === 351n)!;
      assertEquals(b.bytes, replacement.subarray(0, 351 * 4));
      assertEquals(
        b.receipt.streamId,
        appends[0].receipt.streamId,
        'attachment replacement retains the player stream',
      );
      assertEquals(b.receipt.epoch, BigInt(cancels.length + 1));
      const session = receiver.sessions.at(-1)!;
      // Timeline starvation can packetize the 351-frame prefix with labelled
      // zero transport; it still must never contain the canceled old partial.
      const anchor = session.wire.findLastIndex((e) =>
        e.kind === 'record' || e.kind === 'flush'
      );
      const prefix = decodeReceiverAudio(
        session.sdp,
        session.wire.slice(anchor).flatMap((e) =>
          e.kind === 'audio' ? [e.data.subarray(12)] : []
        ),
      );
      const realPrefix = Math.min(prefix.length, 351 * 4);
      assertEquals(
        prefix.subarray(0, realPrefix),
        replacement.subarray(0, realPrefix),
      );
      assertEquals(
        prefix.subarray(realPrefix),
        new Uint8Array(prefix.length - realPrefix),
      );
      tail.resolve();
      await until(() => completedAudio.epochs.length === 1);
      assertEquals(
        completedAudio.realAudio(session, strategy === 'owntone' ? 1 : 0),
        replacement,
      );
      assertEquals(opens.map((path) => path.slice(-5)), ['a.wav', 'b.wav']);
      assertEquals(receiver.sessions.length, strategy === 'owntone' ? 1 : 2);
      assertEquals(
        receiver.sessions[0].flushes,
        strategy === 'owntone' ? 1 : 0,
      );
      assertEquals(cancels[0].retire.length, strategy === 'owntone' ? 0 : 1);
      await until(() => acknowledgments.length === cancels.length);
      assertEquals(Math.round(audio.reduce((a, b) => a + b, 0) * 44.1), 705);
    }
    const session = receiver.sessions.at(-1)!;
    await until(() => completedAudio.epochs.length === 1);
    await until(() => session.wire.some((e) => e.kind === 'timing-reply'));
    const pending = renderScheduledAudio(session, receiver.nowMs());
    assertEquals(pending.issues, []);
    assert(
      pending.lastPresentationAtMs !== null &&
        pending.clockUncertaintyMs !== null,
    );
    await until(() =>
      receiver.nowMs() >
        pending.lastPresentationAtMs! + pending.clockUncertaintyMs!
    );
    const rendered = renderScheduledAudio(session, receiver.nowMs());
    assertEquals(rendered.issues, []);
    assertEquals(
      completedAudio.scheduledRealAudio(
        session,
        receiver.nowMs(),
        mode !== 'backpressure' && strategy === 'owntone' ? 1 : 0,
      ),
      mode === 'backpressure' ? old : replacement,
    );
    assertEquals(rendered.pendingFrames, 0);
    if (mode !== 'backpressure' && strategy === 'owntone') {
      const beforeFlush = session.wire.slice(
        0,
        session.wire.findIndex((e) => e.kind === 'flush'),
      );
      const oldPackets = beforeFlush.flatMap((e) =>
        e.kind === 'audio' ? [e.data.subarray(12)] : []
      );
      const oldPcm = decodeReceiverAudio(session.sdp, oldPackets);
      const real = Math.min(old.length, oldPcm.length);
      assertEquals(oldPcm.subarray(0, real), old.subarray(0, real));
      assertEquals(oldPcm.subarray(real), new Uint8Array(oldPcm.length - real));
      assertEquals(
        rendered.ranges.filter((r) => r.epoch === 1),
        [],
        'no canceled old frame renders',
      );
      assertEquals(
        rendered.discarded.reduce((n, r) => n + r.frames, 0),
        oldPcm.length / 4,
      );
      assert(
        rendered.discarded.every((r) => r.reason === 'flush' && r.epoch === 1),
      );
    } else assertEquals(rendered.discarded, []);
    await libraryProof();
  } finally {
    flush.resolve();
    tail.resolve();
    cancelAck.resolve();
    await boot?.close();
    devices?.close();
    await playback?.close();
    receiver.close();
    await f?.close();
    await Deno.remove(dir, { recursive: true });
  }
}

for (const strategy of ['owntone', 'melofon', 'audiostation'] as const) {
  Deno.test(`HTTP exact stream: ${strategy} 353/cancel/351 preserves scheduled replacement prefix`, () =>
    scenario(strategy, 'replace'));
}
Deno.test('HTTP exact stream: partial ingress receipts retry exactly the real decoded suffix', () =>
  scenario('owntone', 'backpressure'));
Deno.test('HTTP exact stream: close joins held FLUSH cancellation without awaiting its ACK', () =>
  scenario('owntone', 'close'));
Deno.test('HTTP exact stream: immediate newer command shares the held fence without erasing its prefix', () =>
  scenario('owntone', 'supersede'));
