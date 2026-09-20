// tests/decodepcm.test.ts — app.media.decodePcm: the boots' PCM contract
// (44100 Hz / 16-bit / stereo, RAOP's default quality) on the fixture mp3 —
// frame-chunked stream, exact byte count, sample-aligned chunks — plus the
// startMs seek and the null contract on audio-less/undecodable input. No
// AirPlay device involved: the PCM path is proven at the decoder.
import { assert, assertEquals } from '@std/assert';
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

Deno.test('decodePcm on undecodable input returns null instead of throwing', async () => {
  const media = createMedia();
  assertEquals(
    await media.decodePcm('tests/fixtures/library/corrupt.mp3'),
    null,
  );
  assertEquals(await media.decodePcm('/no/such/file.mp3'), null);
});
