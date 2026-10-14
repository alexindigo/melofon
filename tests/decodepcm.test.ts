// tests/decodepcm.test.ts — app.media.decodePcm: the boots' PCM contract
// (44100 Hz / 16-bit / stereo, RAOP's default quality) on the fixture mp3 —
// frame-chunked stream, exact byte count, sample-aligned chunks — plus the
// startMs seek and the null contract on audio-less/undecodable input. No
// AirPlay device involved: the PCM path is proven at the decoder.
import { assert, assertEquals } from '@std/assert';
import { AVERROR_EINVAL, FormatContext } from 'node-av';
import { createMedia } from '../src/media.ts';

const FIXTURE_MP3 =
  'tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3';

async function collect(
  stream: AsyncIterable<Uint8Array>,
): Promise<{ bytes: number; chunks: number[] }> {
  let bytes = 0;
  const chunks: number[] = [];
  for await (const chunk of stream) {
    bytes += chunk.length;
    chunks.push(chunk.length);
  }
  return { bytes, chunks };
}

async function positionWav() {
  const sampleRate = 44100;
  const frameBytes = 4;
  const frames = sampleRate * 4;
  const bytes = new Uint8Array(44 + frames * frameBytes);
  const view = new DataView(bytes.buffer);
  const label = (offset: number, text: string) =>
    bytes.set(new TextEncoder().encode(text), offset);
  label(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  label(8, 'WAVE');
  label(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * frameBytes, true);
  view.setUint16(32, frameBytes, true);
  view.setUint16(34, 16, true);
  label(36, 'data');
  view.setUint32(40, frames * frameBytes, true);
  for (let frame = 0; frame < frames; frame++) {
    const left = (Math.floor(frame / (sampleRate / 10)) + 1) * 200 +
      (frame % 197);
    view.setInt16(44 + frame * frameBytes, left, true);
    view.setInt16(46 + frame * frameBytes, -left, true);
  }
  const dir = await Deno.makeTempDir({ prefix: 'melofon-seek-pcm-' });
  const path = `${dir}/position.wav`;
  await Deno.writeFile(path, bytes);
  return {
    dir,
    path,
    sampleRate,
    frameBytes,
    pcm: bytes.subarray(44),
  };
}

Deno.test('decodePcm on the fixture mp3: s16le 44100 stereo, full length', async () => {
  const media = createMedia();
  const pcm = await media.decodePcm(FIXTURE_MP3);
  assert(pcm !== null);
  const { bytes, chunks } = await collect(pcm);
  // The fixture is 1 s of audio: 44100 * 2ch * 2B = 176400 bytes exactly.
  assertEquals(bytes, 176400);
  assert(chunks.length > 0);
  for (const n of chunks) {
    assertEquals(n % 4, 0, 'chunk is sample-aligned (s16 stereo frame)');
  }
});

Deno.test('decodePcm startMs seeks (keyframe granularity)', async () => {
  const media = createMedia();
  const pcm = await media.decodePcm(FIXTURE_MP3, { startMs: 500 });
  assert(pcm !== null);
  const { bytes } = await collect(pcm);
  // Backward keyframe seek lands at or before 500 ms — strictly less audio
  // than the full decode, never more.
  assert(bytes < 176400, `seek shrinks the stream, got ${bytes}`);
  assert(bytes > 0);
});

Deno.test('decodePcm WAV seeks return the requested PCM suffix', async () => {
  const fixture = await positionWav();
  try {
    const media = createMedia();
    for (const startMs of [0, 500, 1250, 1250.5, 3000]) {
      const firstFrame = Math.round(startMs * fixture.sampleRate / 1000);
      const expected = fixture.pcm.subarray(firstFrame * fixture.frameBytes);
      const pcm = await media.decodePcm(fixture.path, { startMs });
      assert(pcm !== null);
      let bytes = 0;
      let chunks = 0;
      for await (const chunk of pcm) {
        assertEquals(chunk.length % fixture.frameBytes, 0);
        assertEquals(
          chunk,
          expected.subarray(bytes, bytes + chunk.length),
          `seek ${startMs}ms returned the wrong source PCM`,
        );
        bytes += chunk.length;
        chunks++;
      }
      assertEquals(bytes, expected.length, `seek ${startMs}ms PCM length`);
      assert(chunks > 0);
    }
  } finally {
    await Deno.remove(fixture.dir, { recursive: true });
  }
});

Deno.test('decodePcm rejects a failed native seek', async () => {
  const fixture = await positionWav();
  const seekFrame = FormatContext.prototype.seekFrame;
  let attempts = 0;
  try {
    // Simulate a negative result at the library return boundary. The content
    // regression above still exercises the real native seek and decoder.
    FormatContext.prototype.seekFrame = () => {
      attempts++;
      return Promise.resolve(AVERROR_EINVAL);
    };
    const pcm = await createMedia().decodePcm(fixture.path, { startMs: 500 });
    if (pcm !== null) {
      // Enter/unwind the old generator so the behavioral red assertion
      // cannot strand its input/decoder when it incorrectly returns a stream.
      const iterator = pcm[Symbol.asyncIterator]();
      try {
        await iterator.next();
      } finally {
        await iterator.return?.();
      }
    }
    assertEquals(attempts, 1);
    assertEquals(pcm, null, 'failed seeking must not return unintended audio');
  } finally {
    FormatContext.prototype.seekFrame = seekFrame;
    await Deno.remove(fixture.dir, { recursive: true });
  }
});

Deno.test('decodePcm on undecodable input returns null instead of throwing', async () => {
  const media = createMedia();
  assertEquals(
    await media.decodePcm('tests/fixtures/library/corrupt.mp3'),
    null,
  );
  assertEquals(await media.decodePcm('/no/such/file.mp3'), null);
});
