// tests/transcode.test.ts — the streaming audio transcode: flac→mp3 chunked
// (no content-length, body really decodes), m4a/mp3 with format==source →
// byte-identical DirectPlay, raw → DirectPlay, absent → DirectPlay by
// default / mp3 with the flag, maxBitRate clamping and force-transcode,
// video + format=mp3 through the new path, and pre-flight failure → null so
// the hat's envelope stays reachable.
import { assert, assertEquals } from '@std/assert';
import { createMedia } from '../src/media.ts';
import { createStream } from '../src/stream.ts';

const FLAC = 'tests/fixtures/media/clip.flac';
const M4A = 'tests/fixtures/media/clip.m4a';
const MP3 =
  'tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3';
const VIDEO =
  'tests/fixtures/library/Fixture Artist/Fixture Album/03 - Clip.mp4';
const CORRUPT = 'tests/fixtures/library/corrupt.mp3';

const play = (
  cfg: { absentToMp3?: boolean } | undefined,
  opts: {
    path: string;
    isVideo?: boolean;
    format?: string;
    maxBitRateKbps?: number;
  },
) =>
  createStream(createMedia(), undefined, cfg).play(
    new Request('http://x/rest/stream'),
    { path: opts.path, isVideo: opts.isVideo ?? false },
    opts.format,
    undefined,
    opts.maxBitRateKbps,
  );

async function body(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

const isMp3Magic = (b: Uint8Array) =>
  (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) ||
  (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);

/** Stronger than magic: the bytes really parse as audio with a duration. */
async function decodesAsAudio(bytes: Uint8Array): Promise<boolean> {
  const tmp = await Deno.makeTempFile();
  try {
    await Deno.writeFile(tmp, bytes);
    const probed = await createMedia().probe(tmp);
    return probed.hasAudio && probed.durationMs !== null &&
      probed.durationMs > 0;
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
}

Deno.test('flac + format=mp3: chunked transcode, body decodes as mp3', async () => {
  const res = await play(undefined, { path: FLAC, format: 'mp3' });
  assert(res !== null);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get('content-type'), 'audio/mpeg');
  assertEquals(res.headers.get('content-length'), null);
  assertEquals(res.headers.get('accept-ranges'), null);
  const bytes = await body(res);
  assert(isMp3Magic(bytes), 'mp3 magic missing');
  assert(await decodesAsAudio(bytes), 'body does not decode as audio');
  // And it is NOT the flac file itself.
  const onDisk = await Deno.readFile(FLAC);
  assert(bytes.length !== onDisk.length);
});

Deno.test('m4a + format=aac is DirectPlay (byte-identical), via the probed codec', async () => {
  const res = await play(undefined, { path: M4A, format: 'aac' });
  assert(res !== null);
  assertEquals(res.status, 200);
  const bytes = await body(res);
  const onDisk = await Deno.readFile(M4A);
  assertEquals(bytes, onDisk);
});

Deno.test('mp3 + format=mp3 is DirectPlay (byte-identical)', async () => {
  const res = await play(undefined, { path: MP3, format: 'mp3' });
  assert(res !== null);
  assertEquals(await body(res), await Deno.readFile(MP3));
});

Deno.test('format=raw is always DirectPlay', async () => {
  const res = await play(undefined, { path: FLAC, format: 'raw' });
  assert(res !== null);
  assertEquals(await body(res), await Deno.readFile(FLAC));
});

Deno.test('absent format: DirectPlay by default, mp3 with the flag', async () => {
  const direct = await play(undefined, { path: FLAC });
  assert(direct !== null);
  assertEquals(await body(direct), await Deno.readFile(FLAC));

  const flagged = await play({ absentToMp3: true }, { path: FLAC });
  assert(flagged !== null);
  assertEquals(flagged.headers.get('content-type'), 'audio/mpeg');
  const bytes = await body(flagged);
  assert(isMp3Magic(bytes));
  assert(await decodesAsAudio(bytes));
});

Deno.test('maxBitRate forces a transcode even with format absent (flac → mp3)', async () => {
  const res = await play(undefined, { path: FLAC, maxBitRateKbps: 128 });
  assert(res !== null);
  assertEquals(res.headers.get('content-type'), 'audio/mpeg');
  assert(await decodesAsAudio(await body(res)));
});

Deno.test('maxBitRate clamps the encoder bitrate', async () => {
  const unclamped = await play(undefined, { path: FLAC, format: 'mp3' });
  const clamped = await play(undefined, {
    path: FLAC,
    format: 'mp3',
    maxBitRateKbps: 96,
  });
  assert(unclamped !== null && clamped !== null);
  const big = await body(unclamped);
  const small = await body(clamped);
  // ~192k default vs a 96k ceiling: the clamp is strictly smaller.
  assert(
    small.length < big.length * 0.75,
    `clamp ineffective: ${small.length} vs ${big.length}`,
  );
  assert(await decodesAsAudio(small));
});

Deno.test('maxBitRate=0 is no limit (DirectPlay)', async () => {
  const res = await play(undefined, { path: FLAC, maxBitRateKbps: 0 });
  assert(res !== null);
  assertEquals(await body(res), await Deno.readFile(FLAC));
});

Deno.test('video + format=mp3 still answers audio (the old ExtractAudio path)', async () => {
  const res = await play(undefined, {
    path: VIDEO,
    isVideo: true,
    format: 'mp3',
  });
  assert(res !== null);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get('content-type'), 'audio/mpeg');
  assert(isMp3Magic(await body(res)));
});

Deno.test('no profile for the target (flac) is DirectPlay, never an error', async () => {
  const res = await play(undefined, { path: MP3, format: 'flac' });
  assert(res !== null);
  assertEquals(await body(res), await Deno.readFile(MP3));
});

Deno.test('pre-flight failure (no decodable audio) is null for the hat envelope', async () => {
  const res = await play(undefined, { path: CORRUPT, format: 'mp3' });
  assertEquals(res, null);
});

Deno.test('probe reports container bitrate and the codec token', async () => {
  const media = createMedia();
  const flac = await media.probe(FLAC);
  assertEquals(flac.audioCodec, 'flac');
  assert(flac.bitrateKbps !== null && flac.bitrateKbps > 128);
  const m4a = await media.probe(M4A);
  assertEquals(m4a.audioCodec, 'aac');
  const corrupt = await media.probe(CORRUPT);
  assertEquals(corrupt, {
    durationMs: null,
    hasVideo: false,
    hasAudio: false,
    bitrateKbps: null,
    audioCodec: null,
  });
});
