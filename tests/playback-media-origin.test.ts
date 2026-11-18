// Actual lossless decoding -> shipping FFI -> independently scheduled UDP/ALAC.
import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { Buffer } from 'node:buffer';
import {
  AV_NOPTS_VALUE,
  Decoder,
  Demuxer,
  Encoder,
  FF_ENCODER_ALAC,
  FF_ENCODER_FLAC,
  FormatContext,
  Muxer,
  pipeline,
} from 'node-av';
import { createMedia, type PcmOptions } from '../src/media.ts';
import { createFfiStream } from '../src/boots/raop-ffi.ts';
import { profileFromService } from '../src/boots/airplay-profile.ts';
import { startFakeRaop } from './helpers/fake-raop.ts';
import { traceTimelineAudio } from './helpers/raop-timeline-audio.ts';
import { nativeHttpFixture } from './helpers/playback-native-http.ts';
import { createPlaybackSource } from '../src/playback-source.ts';
import { createRadioSource } from '../src/radio-source.ts';
import { createNetwork } from '../src/lookups/net.ts';
import { catalogMedia, createQueueResolver } from '../src/queue-source.ts';
import { httpRadio } from './helpers/http-radio.ts';
import { fixturePcm } from './helpers/decoded-pcm.ts';
import type { AirplayAppendResult } from '../src/boots/airplay-profile.ts';
import { createPlayback } from '../src/playback.ts';
import { createPlayer } from '../src/player.ts';
import type { Library } from '../src/library.ts';
import type { NowPlaying } from '../src/nowplaying.ts';

const sleep = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(what: string, check: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 15000;
  while (!await check()) {
    if (performance.now() > deadline) throw new Error(`timed out: ${what}`);
    await sleep();
  }
}
function test(name: string, fn: () => Promise<void>) {
  Deno.test({
    name: `playback media origin: ${name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn,
  });
}
function wav(rate = 44100, frames = rate === 44100 ? 36864 : rate + 137) {
  const bytes = new Uint8Array(44 + frames * 4);
  const view = new DataView(bytes.buffer);
  for (
    const [offset, label] of [[0, 'RIFF'], [8, 'WAVEfmt '], [
      36,
      'data',
    ]] as const
  ) {
    bytes.set(new TextEncoder().encode(label), offset);
  }
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i++) {
    view.setInt16(
      44 + i * 4,
      (i * 17 + Math.floor(i / 197)) % 30001 - 15000,
      true,
    );
    view.setInt16(
      46 + i * 4,
      14000 - (i * 19 + Math.floor(i / 211)) % 28001,
      true,
    );
  }
  return bytes;
}
async function collect(pcm: AsyncIterable<Uint8Array> | null) {
  assert(pcm);
  const parts: Uint8Array[] = [];
  for await (const part of pcm) parts.push(part);
  return new Uint8Array(Buffer.concat(parts));
}
async function lossless(
  kind: 'flac' | 'alac' | 'wav',
  shift = 0,
  rate = 44100,
) {
  const dir = await Deno.makeTempDir({ prefix: 'media-origin-' });
  const bytes = wav(rate);
  const inputPath = `${dir}/input.wav`;
  await Deno.writeFile(inputPath, bytes);
  let path = kind === 'wav'
    ? inputPath
    : `${dir}/source.${kind === 'alac' ? 'm4a' : 'flac'}`;
  if (kind !== 'wav') {
    await using input = await Demuxer.open(inputPath);
    using decoder = await Decoder.create(input.audio()!);
    using encoder = await Encoder.create(
      kind === 'alac' ? FF_ENCODER_ALAC : FF_ENCODER_FLAC,
      { autoResample: true },
    );
    await using output = await Muxer.open(path, {
      format: kind === 'alac' ? 'ipod' : 'flac',
    });
    await pipeline(input, decoder, encoder, output).completion;
  }
  if (shift) {
    // Encoder FIFOs deliberately re-stamp their samples from zero. Shift the
    // real compressed packets when remuxing, so the resulting container really
    // carries a nonzero stream start without changing one audio sample.
    await using input = await Demuxer.open(path);
    path = `${dir}/shifted.m4a`;
    await using output = await Muxer.open(path, { format: 'ipod' });
    const index = output.addStream(input.audio()!);
    for await (const packet of input.packets(input.audio()!.index)) {
      if (!packet) continue;
      try {
        packet.pts += BigInt(shift);
        packet.dts += BigInt(shift);
        await output.writePacket(packet, index);
      } finally {
        packet.free();
      }
    }
    await output.close();
  }
  return { dir, path, bytes, pcm: bytes.subarray(44) };
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
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', await Deno.readFile(path)),
  );
  console.log(
    `media origin native library: ${path} sha256=${
      Array.from(digest, (v) => v.toString(16).padStart(2, '0')).join('')
    }`,
  );
}
function exactPcm(actual: Uint8Array, expected: Uint8Array, message: string) {
  assertEquals(actual.subarray(0, 4), expected.subarray(0, 4), message);
  assertEquals(actual.length, expected.length, message);
  // Compare every byte without the assertion library's quadratic text diff
  // allocation on a deliberately wrong, long patterned negative control.
  assertEquals(Buffer.compare(actual, expected), 0, message);
}
async function render(
  pcm: AsyncIterable<Uint8Array>,
  expected: Uint8Array,
  write?: (
    chunk: Uint8Array,
    append: (part: Uint8Array) => Promise<AirplayAppendResult>,
  ) => Promise<bigint>,
) {
  const receiver = await startFakeRaop({
    captureAudio: true,
    captureWire: true,
  });
  const audio = traceTimelineAudio(createFfiStream);
  const stream = audio.stream();
  const attachment = stream.attach(() => {});
  let frames = 0n, segment = 0n;
  try {
    // Short fixtures fit ingress before starting transport: no decoder/IO pacing
    // can obscure a missing prefix with a genuine underrun.
    for await (const chunk of pcm) {
      assertEquals(chunk.length % 4, 0);
      const append = (pcm: Uint8Array) =>
        stream.appendSource({
          epoch: stream.epoch,
          source: 1n,
          segment: ++segment,
          pcm,
        });
      if (write) {
        frames += await write(chunk, append);
        continue;
      }
      const result = await append(chunk);
      assertEquals(result.status, 'accepted');
      assertEquals(result.acceptedFrames, BigInt(chunk.length / 4));
      frames += result.acceptedFrames;
    }
    const marker = await stream.seal(stream.epoch, 1n, frames);
    assertEquals(marker.status, 'accepted');
    assertEquals(
      (await stream.endStream(stream.epoch, marker.inputEnd)).status,
      'accepted',
    );
    await attachment.start(
      profileFromService({
        name: '001122334455@Origin._raop._tcp.local',
        host: 'fixture.local',
        address: '127.0.0.1',
        port: receiver.port,
        ttlMs: 60000,
        txt: { tp: 'UDP', am: 'AppleTV2,1' },
      }),
      { volume: 100, positionMs: 0, lengthMs: 2000, title: '', artist: '' },
    );
    const key = {
      epoch: stream.epoch,
      source: 1n,
      target: frames,
      revision: 1n,
    };
    assertEquals((await stream.waitCompletion(key)).status, 'complete');
    await until('independent receiver schedule', () => {
      const session = receiver.sessions[0];
      return !!session?.wire.some((e) => e.kind === 'timing-reply');
    });
    exactPcm(
      audio.scheduledRealAudio(receiver.sessions[0], receiver.nowMs()),
      expected,
      'first rendered frame and the entire media suffix are exact',
    );
    exactPcm(
      audio.realAudio(receiver.sessions[0]),
      expected,
      'exact received PCM',
    );
    assertEquals(frames, BigInt(expected.length / 4));
    await stream.ackCompletion(key);
    await libraryProof();
  } finally {
    await attachment.transport.close();
    await stream.close();
    receiver.close();
  }
}

test('backward FLAC seek renders the exact requested frame, not its packet prefix', async () => {
  const f = await lossless('flac');
  try {
    const startMs = 137.3;
    const frame = Math.round(startMs * 44100 / 1000);
    const pcm = await createMedia().decodePcm(f.path, { startMs });
    assert(pcm);
    assertEquals(pcm.originFrame, BigInt(frame));
    assert(Object.isFrozen(pcm));
    await render(pcm, f.pcm.subarray(frame * 4));
  } finally {
    await Deno.remove(f.dir, { recursive: true });
  }
});

test('nonzero ALAC media timestamps preserve zero-relative origin and exact seek', async () => {
  const f = await lossless('alac', 88200);
  const seekFrame = FormatContext.prototype.seekFrame;
  let seeks = 0;
  try {
    await using input = await Demuxer.open(f.path);
    const audio = input.audio()!;
    assert(
      audio.startTime > 0n && audio.startTime !== AV_NOPTS_VALUE,
      'fixture must really have a nonzero media start',
    );
    const media = createMedia();
    assertEquals(await collect(await media.decodePcm(f.path)), f.pcm);
    FormatContext.prototype.seekFrame = function (...args) {
      seeks++;
      return seekFrame.apply(this, args);
    };
    const startMs = 187.5;
    const frame = Math.round(startMs * 44100 / 1000);
    const pcm = await media.decodePcm(f.path, { startMs });
    assert(pcm);
    await render(pcm, f.pcm.subarray(frame * 4));
    assertEquals(seeks, 1, 'actual native backward seek, not only decode-skip');
  } finally {
    FormatContext.prototype.seekFrame = seekFrame;
    await Deno.remove(f.dir, { recursive: true });
  }
});

test('rate-converted seeks skip exact normalized frames without resetting resampler phase', async () => {
  const f = await lossless('wav', 0, 48000);
  try {
    const media = createMedia();
    const full = await collect(await media.decodePcm(f.path));
    const startMs = 137.3;
    const frame = Math.round(startMs * 44100 / 1000);
    const pcm = await media.decodePcm(f.path, { startMs });
    assert(pcm);
    await render(pcm, full.subarray(frame * 4));
  } finally {
    await Deno.remove(f.dir, { recursive: true });
  }
});

test('web decode-skip uses the exact output-frame origin and releases before native completion', async () => {
  const bytes = wav();
  let closed = 0;
  const startMs = 137.3;
  const frame = Math.round(startMs * 44100 / 1000);
  const pcm = await createMedia().decodeInputPcm({
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
    close() {
      closed++;
      return Promise.resolve();
    },
  }, { startFrame: BigInt(frame) });
  assertEquals(pcm.originFrame, BigInt(frame));
  assertEquals(pcm.eof, false);
  await render(
    (async function* () {
      yield* pcm;
      await pcm.completion;
      assertEquals(pcm.eof, true);
      assertEquals(
        closed,
        1,
        'decoder cleanup does not wait for native playout',
      );
    })(),
    bytes.subarray(44 + frame * 4),
  );
});

test('an unproven decoded seek timestamp reopens from the start before yielding any PCM', async () => {
  const f = await lossless('alac');
  const receive = Decoder.prototype.receive;
  const open = Object.getOwnPropertyDescriptor(Demuxer, 'open')!;
  let invalidated = false, opens = 0, closes = 0;
  try {
    Object.defineProperty(Demuxer, 'open', {
      ...open,
      async value(...args: unknown[]) {
        const input = await Reflect.apply(open.value, Demuxer, args) as Demuxer;
        if (args[0] === f.path) {
          opens++;
          const close = input.close.bind(input);
          input.close = () => {
            closes++;
            return close();
          };
        }
        return input;
      },
    });
    Decoder.prototype.receive = async function () {
      const frame = await receive.call(this);
      if (frame && !invalidated) {
        frame.pts = AV_NOPTS_VALUE;
        invalidated = true;
      }
      return frame;
    };
    const startFrame = 6055n;
    const pcm = await createMedia().decodePcm(f.path, { startFrame });
    assert(pcm);
    await render(pcm, f.pcm.subarray(Number(startFrame) * 4));
    assert(
      invalidated,
      'real decoder frame must cross the invalid-origin barrier',
    );
    assertEquals(
      [opens, closes],
      [2, 2],
      'unproven native attempt retired before fresh decode-skip',
    );
    assertEquals(pcm.originFrame, startFrame);
  } finally {
    Decoder.prototype.receive = receive;
    Object.defineProperty(Demuxer, 'open', open);
    await Deno.remove(f.dir, { recursive: true });
  }
});

test('missing packet timestamps cannot become a synthetic seek origin', async () => {
  const f = await lossless('alac');
  const open = Object.getOwnPropertyDescriptor(Demuxer, 'open')!;
  let opens = 0, stripped = 0;
  try {
    Object.defineProperty(Demuxer, 'open', {
      ...open,
      async value(...args: unknown[]) {
        const input = await Reflect.apply(open.value, Demuxer, args) as Demuxer;
        if (args[0] === f.path && ++opens === 1) {
          const packets = input.packets.bind(input);
          input.packets = async function* (index) {
            for await (const packet of packets(index)) {
              if (packet) {
                packet.pts = AV_NOPTS_VALUE;
                stripped++;
              }
              yield packet;
            }
          };
        }
        return input;
      },
    });
    const pcm = await createMedia().decodePcm(f.path, { startFrame: 6055n });
    assert(pcm);
    await render(pcm, f.pcm.subarray(6055 * 4));
    assert(stripped > 0);
    assertEquals(
      opens,
      2,
      'synthesized decoder PTS cannot authorize a seek origin',
    );
  } finally {
    Object.defineProperty(Demuxer, 'open', open);
    await Deno.remove(f.dir, { recursive: true });
  }
});

test('invalid origins reject with source cleanup and beyond-EOF origins remain empty natural EOF', async () => {
  const media = createMedia();
  const options: PcmOptions[] = [
    { startFrame: -1n },
    { startFrame: 0x10000000000000000n },
    { startMs: NaN },
    { startMs: Infinity },
    { startMs: -0.1 },
    { startMs: Number.MAX_VALUE },
    { startMs: 1, startFrame: 1n },
  ];
  for (const option of options) {
    await assertRejects(
      () => media.decodePcm('/absent-origin-input', option),
      RangeError,
    );
    let closed = 0;
    const body = new ReadableStream<Uint8Array>();
    await assertRejects(() =>
      media.decodeInputPcm({
        body,
        close() {
          closed++;
          return Promise.resolve();
        },
      }, option), RangeError);
    assertEquals([closed, body.locked], [1, false]);
  }
  const pcm = await media.decodeInputPcm({
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(wav());
        c.close();
      },
    }),
    close() {
      return Promise.resolve();
    },
  }, { startFrame: 100000n });
  assertEquals(pcm.originFrame, 100000n);
  assertEquals(await collect(pcm), new Uint8Array());
  await pcm.completion;
  assertEquals(pcm.eof, true);
});

test('cleanup settlement stays distinct from natural EOF and unread cancellation', async () => {
  for (const natural of [false, true]) {
    const release = Promise.withResolvers<void>();
    let closed = 0, settled = false;
    const bytes = wav();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });
    const pcm = await createMedia().decodeInputPcm({
      body,
      async close() {
        closed++;
        await release.promise;
      },
    });
    void pcm.completion.then(() => settled = true);
    const work = natural ? collect(pcm) : pcm.return();
    try {
      await until('source cleanup barrier', () => closed === 1);
      assertEquals(
        pcm.eof,
        natural,
        'cleanup never turns canceled input into EOF',
      );
      assertEquals(
        settled,
        false,
        'completion waits for actual resource cleanup',
      );
      release.resolve();
      await work;
      await pcm.completion;
      assertEquals([settled, body.locked, closed], [true, false, 1]);
      await pcm.return();
      assertEquals(pcm.eof, natural);
    } finally {
      release.resolve();
      await work;
    }
  }
});

test('file handles release acquired native resources on unread return and idle abort without claiming EOF', async () => {
  const f = await lossless('wav');
  const open = Object.getOwnPropertyDescriptor(Demuxer, 'open')!;
  const create = Object.getOwnPropertyDescriptor(Decoder, 'create')!;
  let inputs = 0, decoders = 0, closedInputs = 0, closedDecoders = 0;
  try {
    Object.defineProperty(Demuxer, 'open', {
      ...open,
      async value(...args: unknown[]) {
        const input = await Reflect.apply(open.value, Demuxer, args) as Demuxer;
        inputs++;
        const close = input.close.bind(input);
        input.close = () => {
          closedInputs++;
          return close();
        };
        return input;
      },
    });
    Object.defineProperty(Decoder, 'create', {
      ...create,
      async value(...args: unknown[]) {
        const decoder = await Reflect.apply(
          create.value,
          Decoder,
          args,
        ) as Decoder;
        decoders++;
        const close = decoder.close.bind(decoder);
        decoder.close = () => {
          closedDecoders++;
          close();
        };
        return decoder;
      },
    });
    for (const mode of ['unread', 'abort-unread', 'abort-yielded']) {
      const abort = new AbortController();
      const pcm = await createMedia().decodePcm(f.path, {
        signal: abort.signal,
      });
      assert(pcm);
      assertEquals(pcm.originFrame, 0n);
      assertEquals(pcm.eof, false);
      if (mode === 'abort-yielded') {
        assert((await pcm.next()).value!.length > 0);
      }
      if (mode === 'unread') await pcm.return();
      else abort.abort(new Error('idle file canceled'));
      await pcm.completion;
      await pcm.return();
      assertEquals(pcm.eof, false);
      assertEquals([closedInputs, closedDecoders], [inputs, decoders]);
    }
    assertEquals([inputs, decoders], [3, 3]);
  } finally {
    Object.defineProperty(Demuxer, 'open', open);
    Object.defineProperty(Decoder, 'create', create);
    await Deno.remove(f.dir, { recursive: true });
  }
});

test('file cancellation during acquisition preserves its abort reason and releases the acquired input', async () => {
  const f = await lossless('wav');
  const original = Object.getOwnPropertyDescriptor(Decoder, 'create')!;
  const close = Demuxer.prototype.close;
  let released = 0;
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const abort = new AbortController();
  const reason = new Error('origin acquisition canceled');
  try {
    Demuxer.prototype.close = async function () {
      await close.call(this);
      released++;
    };
    Object.defineProperty(Decoder, 'create', {
      ...original,
      async value(...args: unknown[]) {
        entered.resolve();
        await resume.promise;
        return Reflect.apply(original.value, Decoder, args);
      },
    });
    const opening = createMedia().decodePcm(f.path, { signal: abort.signal });
    const failed = assertRejects(() => opening, Error, reason.message);
    await entered.promise;
    abort.abort(reason);
    resume.resolve();
    await failed;
    assertEquals(
      released,
      1,
      'abort joins release of the acquired native input',
    );
  } finally {
    resume.resolve();
    Object.defineProperty(Decoder, 'create', original);
    Demuxer.prototype.close = close;
    await Deno.remove(f.dir, { recursive: true });
  }
});

test('production HTTP seek uses the decoded lossless origin across zero and partial native acceptance', async () => {
  const input = await lossless('alac', 88200);
  let calls = 0;
  const f = await nativeHttpFixture({
    pcm: input.pcm,
    sourcePath: input.path,
    append: async (request, append) => {
      calls++;
      if (calls === 1) {
        return {
          streamId: f.native.id,
          epoch: request.epoch,
          segment: request.segment,
          source: request.source,
          sourceOffset: 0n,
          inputOffset: 0n,
          acceptedFrames: 0n,
          status: 'backpressure',
        };
      }
      return await append(
        calls === 2
          ? { ...request, pcm: request.pcm.subarray(0, 101 * 4) }
          : request,
      );
    },
  });
  try {
    await f.play();
    await until('initial source acquisition', () => f.opens === 1 && !!f.key);
    const position = 137;
    await f.own(`/player/seek?position_ms=${position}`, 'PUT');
    await until('seek decoder opens', () => f.opens === 2);
    await until(
      'seek suffix completes',
      () => f.playback.playerView().state === 'stop',
    );
    assertEquals(f.origins, [0, position]);
    assert(calls > 2, 'zero and partial acceptance actually executed');
    exactPcm(
      f.audio.scheduledRealAudio(f.receiver.sessions[0], f.receiver.nowMs(), 1),
      input.pcm.subarray(Math.round(position * 44100 / 1000) * 4),
      'production seek renders precisely the requested frame and complete suffix',
    );
    await libraryProof();
  } finally {
    await f.close();
    await Deno.remove(input.dir, { recursive: true });
  }
});

for (const command of ['pause', 'stop']) {
  test(`production HTTP ${command}/Play reopens the scheduled bookmark rather than the decoded prefix`, async () => {
    const input = await lossless('flac');
    const f = await nativeHttpFixture({
      pcm: input.pcm,
      sourcePath: input.path,
      persist: true,
    });
    try {
      await f.play();
      await until(
        'scheduled real progress',
        () => f.playback.playerView().itemProgressMs > 150,
      );
      await f.own(`/player/${command}`, 'PUT');
      const saved = await f.saved();
      assert(saved && saved.positionMs > 0 && saved.positionMs < 837);
      await until('native reset settles', () => f.cutoffs.length === 1);
      const cutoff = f.cutoffs[0];
      assert(cutoff.progress && cutoff.progress.sourceFrames > 0n);
      assertEquals(
        saved.positionMs,
        Number(cutoff.progress.sourceFrames * 1000n / 44100n),
      );
      if (command === 'stop') {
        await until(
          'Stop releases the receiver',
          () => f.receiver.sessions[0].closedAtMs !== null,
        );
      }
      await f.own('/player/play', 'PUT');
      await until('bookmark decoder opens', () => f.opens === 2);
      assertEquals(f.origins[1], saved.positionMs);
      await until(
        'resumed tail completes',
        () => f.playback.playerView().state === 'stop',
      );
      const session = f.receiver.sessions[command === 'stop' ? 1 : 0];
      exactPcm(
        f.audio.scheduledRealAudio(
          session,
          f.receiver.nowMs(),
          command === 'stop' ? 0 : 1,
        ),
        input.pcm.subarray(Math.round(saved.positionMs * 44100 / 1000) * 4),
        'the first and every resumed sample match the saved requested origin',
      );
      await libraryProof();
    } finally {
      await f.close();
      await Deno.remove(input.dir, { recursive: true });
    }
  });
}

for (const copied of [0, 101]) {
  test(`finite web retry advances only ${copied} explicitly accepted frames after refused/failed writes`, async () => {
    const input = wav(), originFrame = 6055n;
    const server = httpRadio(() => ({ body: [input] }));
    const real = createMedia();
    const origins: bigint[] = [];
    let closed = 0, retries = 0, first = true;
    const sources = createPlaybackSource({
      media: {
        ...real,
        async decodeInputPcm(source, options) {
          origins.push(options?.startFrame ?? -1n);
          const pcm = await real.decodeInputPcm(source, options);
          void pcm.completion.then(() => closed++);
          if (origins.length !== 1) return pcm;
          return fixturePcm(
            (async function* () {
              const read = await pcm.next();
              assert(!read.done && read.value.length > 101 * 4);
              yield read.value;
              throw new Error('injected decoder failure after a sink refusal');
            })(),
            pcm,
          );
        },
      },
      radio: createRadioSource({ network: createNetwork() }),
    });
    const resolve = createQueueResolver({
      getSong: () => Promise.resolve(null),
      getStation: () => Promise.resolve(null),
    });
    const media = await resolve({
      kind: 'url',
      url: `${server.origin}/source`,
    });
    assert(media?.facts.kind === 'web');
    media.facts = {
      ...media.facts,
      mode: 'finite',
      seekable: true,
      durationMs: 836,
    };
    const pcm = await sources.open(media, {
      signal: new AbortController().signal,
      startFrame: originFrame,
      retry: () => Promise.resolve(++retries === 1),
    });
    assert(pcm);
    let old: Uint8Array | undefined;
    try {
      await render(
        pcm,
        input.subarray(44 + Number(originFrame) * 4),
        async (chunk, append) => {
          if (first) {
            first = false;
            old = chunk;
            // Refusal copies nothing, and a thrown sink operation has no receipt.
            pcm.accept(chunk, 0n);
            if (copied) {
              const receipt = await append(chunk.subarray(0, copied * 4));
              assertEquals(receipt.acceptedFrames, BigInt(copied));
              pcm.accept(chunk, receipt.acceptedFrames);
            }
            const failedWrite = () => {
              // The consumer sees a thrown write before a receipt, so it cannot
              // report the offered suffix as copied to the source owner.
              return Promise.reject<bigint>(new Error('injected sink failure'));
            };
            await assertRejects(
              async () => {
                const receipt = await failedWrite();
                pcm.accept(chunk, receipt);
              },
              Error,
              'injected sink failure',
            );
            assertEquals(pcm.acceptedFrames, BigInt(copied));
            return BigInt(copied);
          }
          if (old) {
            assertThrows(() => pcm.accept(old!, 1n), RangeError, 'stale');
            old = undefined;
          }
          const receipt = await append(chunk);
          assertEquals(receipt.status, 'accepted');
          pcm.accept(chunk, receipt.acceptedFrames);
          return receipt.acceptedFrames;
        },
      );
      await pcm.completion;
      assertEquals(pcm.eof, true);
      assertEquals(origins, [originFrame, originFrame + BigInt(copied)]);
      assertEquals(
        pcm.acceptedFrames,
        BigInt((input.length - 44) / 4) - originFrame,
      );
      assertEquals([closed, retries], [2, 1]);
      await until('both retry responses released', () => server.closed === 2);
    } finally {
      await pcm.return();
      await server.close();
    }
  });
}

test('production source unread return and idle abort join decoder/network cleanup without EOF', async () => {
  const input = await lossless('wav');
  const server = httpRadio(() => ({ body: [input.bytes] }));
  const real = createMedia();
  let acquired = 0, released = 0;
  const observe = async (work: ReturnType<typeof real.decodePcm>) => {
    const pcm = await work;
    assert(pcm);
    acquired++;
    void pcm.completion.then(() => released++);
    return pcm;
  };
  const sources = createPlaybackSource({
    media: {
      ...real,
      decodePcm: (...args) => observe(real.decodePcm(...args)),
      decodeInputPcm: (...args) => observe(real.decodeInputPcm(...args)),
    },
    radio: createRadioSource({ network: createNetwork() }),
  });
  const resolve = createQueueResolver({
    getSong: () => Promise.resolve(null),
    getStation: () => Promise.resolve(null),
  });
  const web = await resolve({ kind: 'url', url: `${server.origin}/source` });
  const song = catalogMedia(
    { id: 'origin', path: input.path } as Parameters<typeof catalogMedia>[0],
  );
  assert(web);
  try {
    for (const media of [song, web]) {
      for (const idleAbort of [false, true]) {
        const controller = new AbortController();
        const pcm = await sources.open(media, {
          signal: controller.signal,
          startMs: 0,
        });
        assert(pcm);
        if (idleAbort) controller.abort(new Error('idle source canceled'));
        else await pcm.return();
        await pcm.completion;
        await pcm.return();
        assertEquals(pcm.eof, false);
        assertEquals(acquired, released);
      }
    }
    const unread = await sources.open(web, {
      signal: new AbortController().signal,
      startMs: 0,
      retry: () => Promise.resolve(true),
    });
    assert(unread);
    await unread.return();
    await unread.completion;
    assertEquals([unread.eof, acquired, released, server.requests.length], [
      false,
      4,
      4,
      2,
    ]);
    await until('unread web responses released', () => server.closed === 2);
  } finally {
    await server.close();
    await Deno.remove(input.dir, { recursive: true });
  }
});

test('retry source return cancels parked network acquisition and joins it without a replacement', async () => {
  let parked = false;
  const server = httpRadio((_request, disconnected) => ({
    body: (async function* () {
      parked = true;
      await new Promise<void>((resolve) =>
        disconnected.addEventListener('abort', () => resolve(), { once: true })
      );
      yield new Uint8Array(); // Only after disconnect; no bytes unblock acquisition.
    })(),
  }));
  const resolve = createQueueResolver({
    getSong: () => Promise.resolve(null),
    getStation: () => Promise.resolve(null),
  });
  const media = await resolve({ kind: 'url', url: `${server.origin}/parked` });
  assert(media);
  const sources = createPlaybackSource({
    media: createMedia(),
    radio: createRadioSource({ network: createNetwork() }),
  });
  const pcm = await sources.open(media, {
    signal: new AbortController().signal,
    startMs: 0,
    retry: () => {
      throw new Error('Cancellation cannot retry');
    },
  });
  assert(pcm);
  try {
    const read = assertRejects(() => pcm.next());
    await until('parked resolution request', () => parked);
    await pcm.return();
    await read;
    await pcm.completion;
    assertEquals(pcm.eof, false);
    await until('parked response released', () => server.closed === 1);
    assertEquals(server.requests.length, 1);
  } finally {
    await pcm.return();
    await server.close();
  }
});

test('production source return interrupts an acquired parked decoder read and releases real TCP', async () => {
  const input = wav(44100, 441000);
  let parked = false, released = 0;
  const server = httpRadio((_request, disconnected) => ({
    body: (async function* () {
      yield input.subarray(0, 300000);
      parked = true;
      await new Promise<void>((resolve) =>
        disconnected.addEventListener('abort', () => resolve(), { once: true })
      );
    })(),
  }));
  const real = createMedia();
  const sources = createPlaybackSource({
    media: {
      ...real,
      async decodeInputPcm(...args) {
        const pcm = await real.decodeInputPcm(...args);
        void pcm.completion.then(() => released++);
        return pcm;
      },
    },
    radio: createRadioSource({ network: createNetwork() }),
  });
  const resolve = createQueueResolver({
    getSong: () => Promise.resolve(null),
    getStation: () => Promise.resolve(null),
  });
  const media = await resolve({ kind: 'url', url: `${server.origin}/live` });
  assert(media);
  const pcm = await sources.open(media, {
    signal: new AbortController().signal,
    startMs: 0,
    retry: () => {
      throw new Error('Cancellation cannot retry');
    },
  });
  assert(pcm);
  try {
    let at = 0;
    while (at < 300000 - 44 - 16384) {
      const read = await pcm.next();
      assert(!read.done);
      assertEquals(
        read.value,
        input.subarray(44 + at, 44 + at + read.value.length),
      );
      at += read.value.length;
    }
    assert(parked);
    const reading = pcm.next().catch((error) => error);
    await pcm.return();
    await reading;
    await pcm.completion;
    assertEquals([pcm.eof, released], [false, 1]);
    await until('parked decode TCP closes', () => server.closed === 1);
    assertEquals(server.requests.length, 1);
  } finally {
    await pcm.return();
    await server.close();
  }
});

test('production catalog acquisition cancellation joins the real acquired native input', async () => {
  const input = await lossless('wav');
  const original = Object.getOwnPropertyDescriptor(Decoder, 'create')!;
  const close = Demuxer.prototype.close;
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const controller = new AbortController();
  let released = 0;
  try {
    Demuxer.prototype.close = async function () {
      await close.call(this);
      released++;
    };
    Object.defineProperty(Decoder, 'create', {
      ...original,
      async value(...args: unknown[]) {
        entered.resolve();
        await resume.promise;
        return Reflect.apply(original.value, Decoder, args);
      },
    });
    const sources = createPlaybackSource({ media: createMedia() });
    const song = catalogMedia(
      { id: 'origin', path: input.path } as Parameters<typeof catalogMedia>[0],
    );
    const opening = sources.open(song, {
      signal: controller.signal,
      startMs: 0,
    });
    const failed = assertRejects(
      () => opening,
      Error,
      'catalog acquisition canceled',
    );
    await entered.promise;
    controller.abort(new Error('catalog acquisition canceled'));
    resume.resolve();
    await failed;
    assertEquals(released, 1);
  } finally {
    resume.resolve();
    Object.defineProperty(Decoder, 'create', original);
    Demuxer.prototype.close = close;
    await Deno.remove(input.dir, { recursive: true });
  }
});

test('failed production native append discards its queued prefix and reopens at the scheduled bookmark', async () => {
  const input = await lossless('flac');
  let failed = false;
  const f = await nativeHttpFixture({
    pcm: input.pcm,
    sourcePath: input.path,
    persist: true,
    append: async (request, append) => {
      if (!failed) {
        failed = true;
        const receipt = await append({
          ...request,
          pcm: request.pcm.subarray(0, 101 * 4),
        });
        assertEquals(receipt.acceptedFrames, 101n);
        return { ...receipt, status: 'error', error: 'busy' };
      }
      return await append(request);
    },
  });
  try {
    await f.play();
    await until(
      'failure pauses source and releases attachment',
      () =>
        failed && f.playback.playerView().state === 'pause' &&
        f.receiver.sessions[0]?.closedAtMs !== null,
    );
    assertEquals(f.playback.playerView().itemProgressMs, 0);
    assertEquals((await f.saved())!.positionMs, 0);
    await f.own('/player/play', 'PUT');
    await until('replacement reopens', () => f.opens === 2);
    assertEquals(
      f.origins,
      [0, 0],
      'a discarded accepted prefix is not a reopen bookmark',
    );
    await until(
      'replacement renders completely',
      () => f.playback.playerView().state === 'stop',
    );
    exactPcm(
      f.audio.scheduledRealAudio(f.receiver.sessions[1], f.receiver.nowMs()),
      input.pcm,
      'failed old prefix cannot skip the replacement origin',
    );
    await libraryProof();
  } finally {
    await f.close();
    await Deno.remove(input.dir, { recursive: true });
  }
});

test('source return cancels and joins the core retry wait without cancelling the player lease', async () => {
  const server = httpRadio(() => ({
    body: [new TextEncoder().encode('not audio')],
  }));
  const resolve = createQueueResolver({
    getSong: () => Promise.resolve(null),
    getStation: () => Promise.resolve(null),
  });
  const media = await resolve({ kind: 'url', url: `${server.origin}/broken` });
  assert(media);
  const playback = createPlayback({
    player: createPlayer(),
    cfg: {},
    library: {} as Library,
    nowPlaying: {} as NowPlaying,
  });
  const sources = createPlaybackSource({
    media: createMedia(),
    radio: createRadioSource({ network: createNetwork() }),
  });
  const entered = Promise.withResolvers<void>();
  let joined = false;
  await playback.queueAddSources([media], { play: true });
  const view = playback.playerView();
  const lease = playback.openSource(view.current!.id, view.generation);
  assert(lease);
  const pcm = await sources.open(media, {
    signal: lease.signal,
    startMs: 0,
    retry(reason, signal) {
      const work = playback.retrySource(lease, reason, signal);
      entered.resolve();
      return work.finally(() => joined = true);
    },
  });
  assert(pcm);
  try {
    const read = assertRejects(() => pcm.next());
    await entered.promise;
    await sleep();
    assertEquals(joined, false, 'the actual core retry wait is still pending');
    await pcm.return();
    await read;
    await pcm.completion;
    assertEquals([joined, lease.signal.aborted, pcm.eof], [true, false, false]);
    await until('failed attempt network cleanup', () => server.closed === 1);
    assertEquals(
      server.requests.length,
      1,
      'canceled retry never opens a replacement',
    );
  } finally {
    await pcm.return();
    await playback.close();
    await server.close();
  }
});
