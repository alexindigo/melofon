import { assert, assertEquals, assertRejects } from '@std/assert';
import { Buffer } from 'node:buffer';
import { Decoder, Demuxer, type Frame } from 'node-av';
import {
  type CompressedInput,
  createMedia,
  type InputPcm,
} from '../src/media.ts';
import { createNetwork } from '../src/lookups/net.ts';
import { createRadioSource } from '../src/radio-source.ts';
import { separateIcy } from '../src/icy.ts';
import { createState } from '../src/state.ts';
import { openStore } from '../src/store/index.ts';
import { httpRadio, icyBlock } from './helpers/http-radio.ts';

const MP3 =
  'tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3';
const FLAC = 'tests/fixtures/media/clip.flac';
const M4A = 'tests/fixtures/media/clip.m4a';
const encode = (value: string) => new TextEncoder().encode(value);
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Input did not settle')),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function collect(stream: AsyncIterable<Uint8Array> | null) {
  assert(stream);
  const parts: Uint8Array[] = [];
  for await (const part of stream) {
    assertEquals(part.length % 4, 0);
    parts.push(part);
  }
  return new Uint8Array(Buffer.concat(parts));
}

async function encoded(format: string) {
  const result = await createMedia().transcodeAudio(FLAC, format);
  assert(result);
  const bytes = new Uint8Array(await new Response(result.stream).arrayBuffer());
  await result.completion;
  return bytes;
}
function bytesInput(bytes: Uint8Array, fragment = 137) {
  let at = 0, closed = 0, cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at === bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(at + fragment, bytes.length);
      controller.enqueue(bytes.subarray(at, end));
      at = end;
    },
    cancel() {
      cancelled++;
    },
  }, { highWaterMark: 0 });
  return {
    body,
    close() {
      closed++;
      return Promise.resolve();
    },
    get closed() {
      return closed;
    },
    get cancelled() {
      return cancelled;
    },
    get read() {
      return at;
    },
  };
}
function wav(seconds = 1) {
  const data = new Uint8Array(44 + 44100 * 4 * seconds);
  const view = new DataView(data.buffer);
  for (
    const [at, label] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [
      36,
      'data',
    ]] as const
  ) data.set(encode(label), at);
  view.setUint32(4, data.length - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 44100, true);
  view.setUint32(28, 176400, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, data.length - 44, true);
  for (let at = 44; at < data.length; at += 4) {
    view.setInt16(at, (at % 13001) - 6500, true);
    view.setInt16(at + 2, 6500 - (at % 13001), true);
  }
  return data;
}
function mediaWith(settings: Record<string, number>) {
  return createMedia(undefined, {
    declare() {},
    getTyped: (key) => Promise.resolve(settings[key]),
  });
}

Deno.test('core input MP3, AAC and finite WAV decode to the exact existing PCM consumer with prefix replay and short reads', async () => {
  const media = createMedia();
  const aacBytes = await encoded('aac');
  const dir = await Deno.makeTempDir({ prefix: 'media-input-' });
  try {
    for (
      const [name, bytes] of [
        ['mp3', await encoded('mp3')],
        ['aac', aacBytes],
        ['wav', wav()],
      ] as const
    ) {
      const path = `${dir}/input.${name}`;
      await Deno.writeFile(path, bytes);
      const expected = await collect(await media.decodePcm(path));
      assert(expected.length > 0);
      const source = bytesInput(bytes, name === 'wav' ? 70001 : 13);
      const pcm = await media.decodeInputPcm(source);
      assertEquals(await collect(pcm), expected, `${name} PCM changed`);
      if (name === 'wav') assertEquals(expected, bytes.subarray(44));
      await pcm.completion;
      assertEquals(source.closed, 1);
      assertEquals(source.body.locked, false);
      assertEquals(source.read, bytes.length);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('core input FLAC and forward-readable M4A keep the shared resampler output; a tail index requires seeking', async () => {
  const media = createMedia();
  for (const path of [FLAC]) {
    const source = bytesInput(await Deno.readFile(path));
    const pcm = await media.decodeInputPcm(source);
    assertEquals(
      await collect(pcm),
      await collect(await media.decodePcm(path)),
    );
    await pcm.completion;
    assertEquals(source.closed, 1);
  }
  const bytes = fastStartMov(await Deno.readFile(M4A));
  const dir = await Deno.makeTempDir({ prefix: 'media-input-mov-' });
  try {
    const path = `${dir}/forward.m4a`;
    await Deno.writeFile(path, bytes);
    const source = bytesInput(bytes);
    assertEquals(
      await collect(await media.decodeInputPcm(source)),
      await collect(await media.decodePcm(path)),
    );
    assertEquals(source.closed, 1);
    const tailIndex = bytesInput(await Deno.readFile(M4A));
    await assertRejects(async () =>
      await collect(await media.decodeInputPcm(tailIndex))
    );
    assertEquals(tailIndex.closed, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('real core HTTP -> playlist -> ICY -> callback decoder ignores false/missing MIME and retains metadata separately', async () => {
  const audio = await encoded('mp3');
  const dir = await Deno.makeTempDir({ prefix: 'media-input-http-' });
  const path = `${dir}/stream.mp3`;
  await Deno.writeFile(path, audio);
  const expected = await collect(await createMedia().decodePcm(path));
  try {
    for (const mime of ['', 'text/html', 'audio/aac']) {
      const titles: string[] = [];
      const server = httpRadio((request) => {
        const path = new URL(request.url).pathname;
        if (path === '/station.m3u') return { body: [encode('/audio')] };
        return {
          headers: { 'content-type': mime, 'icy-metaint': '1000' },
          body: (function* () {
            for (let at = 0; at < audio.length; at += 1000) {
              yield audio.subarray(at, at + 1000);
              if (at + 1000 <= audio.length) {
                yield icyBlock("StreamTitle='Artist - Song';");
              }
            }
          })(),
        };
      });
      const session = createRadioSource({ network: createNetwork() }).session(
        `${server.origin}/station.m3u`,
        new AbortController().signal,
      );
      try {
        const lease = await session.open();
        const pcm = await createMedia().decodeInputPcm({
          body: separateIcy(
            lease.response.body!,
            lease.response.headers,
            (facts) => {
              if (facts.streamTitle !== undefined) {
                titles.push(facts.streamTitle);
              }
            },
          ),
          close: () => lease.close(),
        });
        assertEquals(await collect(pcm), expected);
        await pcm.completion;
        assert(titles.length > 0);
        assert(titles.every((title) => title === 'Artist - Song'));
        assertEquals(server.requests.length, 2);
      } finally {
        await session.close();
        await server.close();
      }
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('input probing and native preflight have byte and chunk bounds and close rejected sources', async () => {
  for (
    const [bytes, settings, message] of [
      [
        new Uint8Array(10000),
        { 'media.input.probeBytes': 4096 },
        'Unrecognized',
      ],
      [wav(), { 'media.input.openBytes': 4096 }, 'open byte limit'],
      [wav(), { 'media.input.bufferBytes': 10 }, 'chunk exceeds'],
    ] as const
  ) {
    const source = bytesInput(bytes, 137);
    await assertRejects(
      () => mediaWith(settings).decodeInputPcm(source),
      Error,
      message,
    );
    assertEquals(source.closed, 1);
    assertEquals(source.body.locked, false);
    if (settings['media.input.probeBytes']) assertEquals(source.read, 4110); // One bounded source fragment retained, not drained.
  }
});

Deno.test('empty and no-audio inputs reject without leaking the acquired body', async () => {
  for (
    const bytes of [
      new Uint8Array(),
      encode('not audio'),
      encode('#EXTM3U\nhttp://never.invalid/audio'),
    ]
  ) {
    const source = bytesInput(bytes);
    await assertRejects(() => createMedia().decodeInputPcm(source));
    assertEquals(source.closed, 1);
    assertEquals(source.body.locked, false);
  }
});

Deno.test('pre-abort and abort during prefix read preserve reason and complete cleanup', async () => {
  for (const before of [true, false]) {
    const controller = new AbortController();
    const reason = new Error('caller cancelled prefix');
    let pulled!: () => void;
    const waiting = new Promise<void>((resolve) => pulled = resolve);
    let close = 0, cancel = 0;
    const source: CompressedInput = {
      body: new ReadableStream({
        pull() {
          pulled();
        },
        cancel() {
          cancel++;
        },
      }, { highWaterMark: 0 }),
      close() {
        close++;
        return Promise.resolve();
      },
    };
    if (before) controller.abort(reason);
    const opening = createMedia().decodeInputPcm(source, {
      signal: controller.signal,
    });
    if (!before) {
      await bounded(waiting);
      controller.abort(reason);
    }
    assertEquals(await bounded(opening.catch((error) => error)), reason);
    assertEquals(close, 1);
    assertEquals(cancel, 1);
    assertEquals(source.body.locked, false);
  }
});

Deno.test('abort and open timeout interrupt native open waiting on core bytes', async () => {
  for (const timeout of [false, true]) {
    const controller = new AbortController();
    const reason = new Error('caller cancelled native open');
    const bytes = await Deno.readFile(MP3);
    let pulls = 0, close = 0;
    let parked!: () => void;
    const waiting = new Promise<void>((resolve) => parked = resolve);
    const source: CompressedInput = {
      body: new ReadableStream({
        pull(c) {
          if (++pulls === 1) c.enqueue(bytes.subarray(0, 2048));
          else parked();
        },
      }, { highWaterMark: 0 }),
      close() {
        close++;
        return Promise.resolve();
      },
    };
    const opening = mediaWith({
      'media.input.openTimeoutMs': timeout ? 100 : 10000,
    }).decodeInputPcm(source, { signal: controller.signal });
    await bounded(waiting);
    if (!timeout) controller.abort(reason);
    const error = await bounded(opening.catch((error) => error));
    if (timeout) assertEquals(error.name, 'TimeoutError');
    else assertEquals(error, reason);
    assertEquals(close, 1);
    assertEquals(source.body.locked, false);
  }
});

Deno.test('source read failures retain original identity instead of becoming clean EOF or native EIO', async () => {
  for (const afterPrefix of [false, true]) {
    const reason = new Error('upstream transport dropped');
    let pulls = 0, close = 0;
    const bytes = await Deno.readFile(MP3);
    const source: CompressedInput = {
      body: new ReadableStream({
        pull(c) {
          if (afterPrefix && ++pulls === 1) c.enqueue(bytes.subarray(0, 2048));
          else c.error(reason);
        },
      }, { highWaterMark: 0 }),
      close() {
        close++;
        return Promise.resolve();
      },
    };
    const result = await bounded(
      createMedia().decodeInputPcm(source).catch((error) => error),
    );
    assertEquals(result, reason);
    assertEquals(close, 1);
    assertEquals(source.body.locked, false);
  }
});

/** Observe real native allocations, not merely a cancelled byte stream. */
async function trackNative(run: (released: () => void) => Promise<void>) {
  const open = Object.getOwnPropertyDescriptor(Demuxer, 'open')!;
  const create = Object.getOwnPropertyDescriptor(Decoder, 'create')!;
  const receive = Decoder.prototype.receive;
  const inputs: { value: Demuxer; closed: boolean }[] = [];
  const decoders: { value: Decoder; closed: boolean }[] = [];
  const frames: { value: Frame; freed: boolean }[] = [];
  try {
    Object.defineProperty(Demuxer, 'open', {
      ...open,
      async value(...args: unknown[]) {
        const value = await Reflect.apply(open.value, Demuxer, args) as Demuxer;
        const row = { value, closed: false };
        inputs.push(row);
        const close = value.close.bind(value);
        value.close = () => {
          row.closed = true;
          return close();
        };
        return value;
      },
    });
    Object.defineProperty(Decoder, 'create', {
      ...create,
      async value(...args: unknown[]) {
        const value = await Reflect.apply(
          create.value,
          Decoder,
          args,
        ) as Decoder;
        const row = { value, closed: false };
        decoders.push(row);
        const close = value.close.bind(value);
        value.close = () => {
          row.closed = true;
          close();
        };
        return value;
      },
    });
    Decoder.prototype.receive = async function () {
      const value = await receive.call(this);
      if (value) {
        const row = { value, freed: false };
        frames.push(row);
        const free = value.free.bind(value);
        value.free = () => {
          row.freed = true;
          free();
        };
      }
      return value;
    };
    await run(() => {
      assert(inputs.length > 0 && decoders.length > 0);
      assert(inputs.every((row) => row.closed), 'demuxer not released');
      assert(decoders.every((row) => row.closed), 'decoder not released');
      assert(frames.every((row) => row.freed), 'frame not released');
    });
  } finally {
    for (const row of frames) if (!row.freed) row.value.free();
    for (const row of decoders) if (!row.closed) row.value.close();
    for (const row of inputs) if (!row.closed) await row.value.close();
    Object.defineProperty(Demuxer, 'open', open);
    Object.defineProperty(Decoder, 'create', create);
    Decoder.prototype.receive = receive;
  }
}

Deno.test('return-before-next, break and idle abort release native PCM acquisitions and yielded frames exactly as file decoding does', async () => {
  await trackNative(async (released) => {
    for (const mode of ['unread', 'break', 'abort']) {
      const controller = new AbortController();
      const source = bytesInput(wav());
      const pcm = await createMedia().decodeInputPcm(source, {
        signal: controller.signal,
      });
      if (mode === 'break') {
        for await (const chunk of pcm) {
          assert(chunk.length > 0);
          break;
        }
      } else if (mode === 'abort') controller.abort();
      else await pcm.return();
      await bounded(pcm.completion);
      await pcm.return();
      released();
      assertEquals(source.closed, 1);
      assertEquals(source.body.locked, false);
    }
  });
});

Deno.test('failed reader or decoder acquisition closes the source and any already acquired native input', async () => {
  const locked = bytesInput(wav());
  const reader = locked.body.getReader();
  try {
    await assertRejects(() => createMedia().decodeInputPcm(locked), TypeError);
    assertEquals(locked.closed, 1);
  } finally {
    reader.releaseLock();
  }

  const open = Object.getOwnPropertyDescriptor(Demuxer, 'open')!;
  const create = Object.getOwnPropertyDescriptor(Decoder, 'create')!;
  const reason = new Error('decoder acquisition failed');
  let acquired: Demuxer | undefined;
  let closed = false;
  const source = bytesInput(wav());
  try {
    Object.defineProperty(Demuxer, 'open', {
      ...open,
      async value(...args: unknown[]) {
        const value = await Reflect.apply(open.value, Demuxer, args) as Demuxer;
        acquired = value;
        const close = value.close.bind(value);
        value.close = () => {
          closed = true;
          return close();
        };
        return value;
      },
    });
    Object.defineProperty(Decoder, 'create', {
      ...create,
      value() {
        return Promise.reject(reason);
      },
    });
    assertEquals(
      await createMedia().decodeInputPcm(source).catch((error) => error),
      reason,
    );
    assert(acquired && closed);
    assertEquals(source.closed, 1);
    assertEquals(source.body.locked, false);
  } finally {
    await acquired?.close();
    Object.defineProperty(Demuxer, 'open', open);
    Object.defineProperty(Decoder, 'create', create);
  }
});

Deno.test('live input yields PCM before upstream EOF and return interrupts a parked native read and closes real TCP', async () => {
  const audio = wav(10);
  let parked = false;
  const server = httpRadio((_request, signal) => ({
    body: (async function* () {
      yield audio.subarray(0, 300000);
      parked = true;
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      );
    })(),
  }));
  const session = createRadioSource({ network: createNetwork() }).session(
    `${server.origin}/live`,
    new AbortController().signal,
  );
  let pcm: InputPcm | undefined;
  try {
    const lease = await session.open();
    pcm = await bounded(
      createMedia().decodeInputPcm({
        body: lease.response.body!,
        close: () => lease.close(),
      }),
    );
    assert(parked);
    const expected = audio.subarray(44, 300000);
    let at = 0;
    while (at < expected.length - 16384) {
      const part = await bounded(pcm.next());
      assert(!part.done);
      assertEquals(part.value, expected.subarray(at, at + part.value.length));
      at += part.value.length;
    }
    const next = pcm.next().catch((error) => error);
    await bounded(pcm.return());
    await bounded(next);
    await bounded(pcm.completion);
    const end = performance.now() + 3000;
    while (server.closed !== 1) {
      assert(performance.now() < end);
      await sleep(10);
    }
    assertEquals(server.requests.length, 1);
  } finally {
    await pcm?.return();
    await session.close();
    await server.close();
  }
});

Deno.test('mid-decode read failure and caller abort reach the PCM consumer and release pending native work', async () => {
  await trackNative(async (released) => {
    for (const mode of ['failure', 'abort']) {
      const controller = new AbortController();
      const reason = new Error(`mid-decode ${mode}`);
      let output!: ReadableStreamDefaultController<Uint8Array>;
      let pulls = 0, closed = 0;
      let park!: () => void;
      const parked = new Promise<void>((resolve) => park = resolve);
      const source: CompressedInput = {
        body: new ReadableStream({
          start(c) {
            output = c;
          },
          pull(c) {
            if (++pulls === 1) c.enqueue(wav(10).subarray(0, 300000));
            else park();
          },
        }, { highWaterMark: 0 }),
        close() {
          closed++;
          return Promise.resolve();
        },
      };
      const pcm = await createMedia().decodeInputPcm(source, {
        signal: controller.signal,
      });
      const first = await bounded(pcm.next());
      assert(!first.done && first.value.length > 0);
      const consuming = collect(pcm).catch((error) => error);
      await bounded(parked);
      if (mode === 'failure') output.error(reason);
      else controller.abort(reason);
      assertEquals(await bounded(consuming), reason);
      await bounded(pcm.completion);
      released();
      assertEquals(closed, 1);
      assertEquals(source.body.locked, false);
    }
  });
});

/** Turn a self-contained MOV data reference into an external reference. */
function externalMov(bytes: Uint8Array, target: string): Uint8Array {
  const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'dinf', 'stbl']);
  const rewrite = (data: Uint8Array): Buffer => {
    const parts: Buffer[] = [];
    for (let at = 0; at < data.length;) {
      const view = Buffer.from(data.subarray(at));
      const size = view.readUInt32BE(0);
      assert(size >= 8 && size <= view.length);
      const type = view.toString('ascii', 4, 8);
      let payload: Buffer = view.subarray(8, size);
      if (containers.has(type)) payload = rewrite(payload);
      if (type === 'dref') {
        const url = Buffer.concat([
          Buffer.alloc(4),
          Buffer.from(target + '\0'),
        ]);
        const entry = Buffer.alloc(8);
        entry.writeUInt32BE(8 + url.length);
        entry.write('url ', 4);
        payload = Buffer.concat([payload.subarray(0, 8), entry, url]);
      }
      if (type === 'stco') {
        for (let i = 0; i < payload.readUInt32BE(4); i++) {
          const position = 8 + i * 4;
          payload.writeUInt32BE(
            payload.readUInt32BE(position) + Buffer.byteLength(target) + 1,
            position,
          );
        }
      }
      const header = Buffer.from(view.subarray(0, 8));
      header.writeUInt32BE(8 + payload.length);
      parts.push(header, payload);
      at += size;
    }
    return Buffer.concat(parts);
  };
  return rewrite(bytes);
}

/** Move the fixture's tail moov before mdat and adjust absolute sample offsets.
 * This changes only container layout, not the AAC payload or timing. */
function fastStartMov(bytes: Uint8Array): Uint8Array {
  const data = Buffer.from(bytes);
  const atoms: { at: number; size: number; type: string }[] = [];
  for (let at = 0; at < data.length;) {
    const size = data.readUInt32BE(at);
    assert(size >= 8 && at + size <= data.length);
    atoms.push({ at, size, type: data.toString('ascii', at + 4, at + 8) });
    at += size;
  }
  const moov = atoms.find((atom) => atom.type === 'moov')!;
  const mdat = atoms.find((atom) => atom.type === 'mdat')!;
  assert(moov.at > mdat.at);
  const movie = Buffer.from(data.subarray(moov.at, moov.at + moov.size));
  const patch = (part: Buffer) => {
    for (let at = 0; at < part.length;) {
      const size = part.readUInt32BE(at);
      const type = part.toString('ascii', at + 4, at + 8);
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) {
        patch(part.subarray(at + 8, at + size));
      }
      if (type === 'stco') {
        for (let i = 0; i < part.readUInt32BE(at + 12); i++) {
          const position = at + 16 + i * 4;
          part.writeUInt32BE(part.readUInt32BE(position) + moov.size, position);
        }
      }
      at += size;
    }
  };
  patch(movie);
  return Buffer.concat([
    data.subarray(0, mdat.at),
    movie,
    data.subarray(mdat.at, moov.at),
    data.subarray(moov.at + moov.size),
  ]);
}

Deno.test('malicious nested playlists and external MOV references cannot bypass core networking', async () => {
  const server = httpRadio(() => ({ body: [wav()] }), {
    requireMetadata: false,
  });
  const file = await Deno.makeTempFile({
    prefix: 'media-forbidden-',
    suffix: '.wav',
  });
  await Deno.writeFile(file, wav());
  try {
    const movie = fastStartMov(await Deno.readFile(M4A));
    const expected = await collect(
      await createMedia().decodeInputPcm(bytesInput(movie)),
    );
    const targets = [`${server.origin}/forbidden`, `file://${file}`];
    for (const target of targets) {
      for (
        const bytes of [
          encode(`#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${target}\n`),
          encode(`ffconcat version 1.0\nfile '${target}'\n`),
        ]
      ) {
        const source = bytesInput(bytes);
        await assertRejects(async () => {
          const pcm = await createMedia().decodeInputPcm(source);
          await collect(pcm);
        });
        assertEquals(source.closed, 1);
        assertEquals(source.body.locked, false);
        assertEquals(
          server.requests.length,
          0,
          'FFmpeg opened a secondary HTTP resource',
        );
      }
      // Disabled data references are ignored: only the root AAC is decoded,
      // never the different WAV at the forbidden HTTP or file URI.
      const source = bytesInput(externalMov(movie, target));
      const pcm = await createMedia().decodeInputPcm(source);
      assertEquals(await collect(pcm), expected);
      await pcm.completion;
      assertEquals(source.closed, 1);
      assertEquals(source.body.locked, false);
      assertEquals(server.requests.length, 0);
    }
  } finally {
    await server.close();
    await Deno.remove(file);
  }
});

Deno.test('media input budgets are owner-declared validated settings and updates affect subsequent acquisitions', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'media-input-settings-' });
  const store = await openStore(dir);
  try {
    const state = createState(store);
    const media = createMedia(undefined, state);
    assertEquals(await state.getTyped('media.input.probeBytes'), 65536);
    assertEquals(await state.getTyped('media.input.openBytes'), 1048576);
    assertEquals(await state.getTyped('media.input.openTimeoutMs'), 10000);
    assertEquals(await state.getTyped('media.input.bufferBytes'), 1048576);
    await assertRejects(() => state.set('media.input.probeBytes', '0'));
    await state.set('media.input.probeBytes', '1');
    await assertRejects(() => media.decodeInputPcm(bytesInput(wav())));
    await state.set('media.input.probeBytes', '65536');
    assertEquals(
      await collect(await media.decodeInputPcm(bytesInput(wav()))),
      wav().subarray(44),
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
