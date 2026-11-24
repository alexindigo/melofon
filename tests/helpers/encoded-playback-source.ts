import { assert, assertEquals } from '@std/assert';
import { createMedia } from '../../src/media.ts';
import { concatenate } from './timeline-proof.ts';

export async function writeEncodedTone(
  path: string,
  codec: 'flac' | 'mp3' | 'mp3-no-xing',
  seconds: number,
  frequency: number,
) {
  const result = await new Deno.Command('ffmpeg', {
    args: [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${frequency}:sample_rate=44100:duration=${seconds}`,
      '-ac',
      '2',
      ...(codec === 'flac'
        ? ['-c:a', 'flac', '-sample_fmt', 's32']
        : ['-c:a', 'libmp3lame']),
      ...(codec === 'mp3-no-xing' ? ['-write_xing', '0'] : []),
      path,
    ],
  }).output();
  assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
}

/** Decode once outside playback to obtain the PCM oracle and its chunk shape. */
export async function decodeSourceReference(path: string) {
  const reader = await createMedia().decodePcm(path);
  assert(reader);
  const chunks: Uint8Array[] = [];
  for await (const chunk of reader) chunks.push(chunk.slice());
  assert(reader.eof);
  return {
    pcm: concatenate(chunks),
    chunkFrames: chunks.map((c) => c.length / 4),
  };
}
