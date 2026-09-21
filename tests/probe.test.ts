// tests/probe.test.ts — app.media.probe: node-av in-process probe of the
// fixture mp3 (duration + audio-only shape) and the non-throwing contract on
// undecodable input. No ffprobe CLI anywhere in this milestone.
import { assert, assertEquals } from '@std/assert';
import { createMedia } from '../src/media.ts';

const FIXTURE_MP3 =
  'tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3';

Deno.test('probe on the fixture mp3: audio, no video, duration', async () => {
  const probe = await createMedia().probe(FIXTURE_MP3);
  assertEquals(probe.hasAudio, true);
  assertEquals(probe.hasVideo, false);
  assert(probe.durationMs !== null && probe.durationMs > 0);
});

Deno.test('probe on undecodable input returns nulls instead of throwing', async () => {
  const probe = await createMedia().probe('tests/fixtures/library/corrupt.mp3');
  assertEquals(probe, {
    durationMs: null,
    hasVideo: false,
    hasAudio: false,
    bitrateKbps: null,
    audioCodec: null,
  });
});

Deno.test('probe on a missing file returns nulls instead of throwing', async () => {
  const probe = await createMedia().probe('/no/such/file.mp3');
  assertEquals(probe, {
    durationMs: null,
    hasVideo: false,
    hasAudio: false,
    bitrateKbps: null,
    audioCodec: null,
  });
});
