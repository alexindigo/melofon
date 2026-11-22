// Plain HTTP -> real FLAC/MP3 decoders -> production reader -> native pacer ->
// independently scheduled ALAC consumer, across thousands of decoder chunks.
import { assert, assertEquals } from '@std/assert';
import { createMedia } from '../src/media.ts';
import { nativeHttpFixture } from './helpers/playback-native-http.ts';
import { exact } from './helpers/concurrent-playback.ts';
import {
  concatenate,
  timelineControl,
  timelineLibraryProof,
  timelineUntil,
} from './helpers/timeline-proof.ts';

async function decoded(path: string) {
  const reader = await createMedia().decodePcm(path);
  assert(reader);
  const chunks: Uint8Array[] = [];
  for await (const chunk of reader) chunks.push(chunk.slice());
  assert(reader.eof);
  assert(chunks.length > 256, 'normal decoder fragmentation crosses old cap');
  return concatenate(chunks);
}

Deno.test({
  name:
    'timeline acceptance: three-minute FLAC then MP3 complete gaplessly with exact scheduled PCM',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const directory = await Deno.makeTempDir({ prefix: 'long-source-' });
    try {
      const paths = [`${directory}/a.flac`, `${directory}/b.mp3`];
      for (const [i, path] of paths.entries()) {
        const result = await new Deno.Command('ffmpeg', {
          args: [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            `sine=frequency=${440 + i * 220}:sample_rate=44100:duration=180`,
            '-ac',
            '2',
            ...(i === 0
              ? ['-c:a', 'flac', '-sample_fmt', 's32']
              : ['-c:a', 'libmp3lame']),
            path,
          ],
        }).output();
        assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
      }
      const parts = await Promise.all(paths.map(decoded));
      const f = await nativeHttpFixture({
        pcm: new Uint8Array(),
        sourcePath: paths[0],
        additionalSourcePaths: [paths[1]],
      });
      try {
        f.outputs.update('1', { connectionStrategy: 'melofon' });
        const c = await timelineControl(f);
        await c.add();
        const ids = f.playback.queueView().items.map((e) => e.id);
        await c.command('play');
        await timelineUntil(
          'natural FLAC -> MP3 transition',
          () => f.playback.sourcePlanView().playing?.entryId === ids[1],
          200000,
        );
        await timelineUntil(
          'both long sources complete naturally',
          () => f.playback.playerView().state === 'stop',
          200000,
        );
        assert(f.completions.every((r) => r.status === 'complete'));
        // The fixture traces waiters, not unique receipts. Reader/publication
        // observers can await the same retained source completion independently.
        const completed = new Map(f.completions.map((r) => [r.source, r]));
        assertEquals(completed.size, 2);
        assertEquals(
          Array.from(completed.values(), (r) => r.target),
          parts.map((p) => BigInt(p.length / 4)),
        );
        assertEquals(f.audio.epochs.length, 1);
        const expected = concatenate(parts);
        let end = 0n;
        for (const range of f.audio.epochs[0].ranges) {
          if (range.kind !== 'real') continue;
          assertEquals(range.transportStart, end, 'no inter-source silence');
          end += range.frames;
        }
        assertEquals(end, BigInt(expected.length / 4));
        assertEquals(f.receiver.sessions.length, 1);
        const session = f.receiver.sessions[0];
        assertEquals(session.flushes, 0);
        exact(f.audio.realAudio(session), expected);
        exact(
          f.audio.scheduledRealAudio(session, f.receiver.nowMs()),
          expected,
        );
        await timelineLibraryProof();
      } finally {
        await f.close();
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});
