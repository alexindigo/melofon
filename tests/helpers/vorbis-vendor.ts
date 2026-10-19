import { assert } from '@std/assert';
import { Buffer } from 'node:buffer';

/** Fixture-only packet walk: music-metadata intentionally skips Ogg's vendor
 * string. Read the second packet, not an arbitrary byte match inside audio. */
export async function vorbisVendor(path: string) {
  const bytes = Buffer.from(await Deno.readFile(path));
  if (bytes.subarray(0, 4).toString() !== 'OggS') return undefined;
  let packet = Buffer.alloc(0), number = 0;
  const serial = bytes.readUInt32LE(14);
  for (let at = 0; at < bytes.length;) {
    assert(bytes.subarray(at, at + 4).toString() === 'OggS');
    const segments = bytes.subarray(at + 27, at + 27 + bytes[at + 26]);
    let data = at + 27 + segments.length;
    if (bytes.readUInt32LE(at + 14) === serial) {
      for (const length of segments) {
        packet = Buffer.concat([packet, bytes.subarray(data, data + length)]);
        data += length;
        if (length < 255) {
          if (++number === 2) {
            const prefix = packet.subarray(0, 8).toString() === 'OpusTags'
              ? 8
              : 7;
            assert(
              prefix === 8 ||
                packet.subarray(0, 7).equals(Buffer.from('\x03vorbis')),
            );
            const length = packet.readUInt32LE(prefix);
            assert(prefix + 4 + length <= packet.length);
            return packet.subarray(prefix + 4, prefix + 4 + length);
          }
          packet = Buffer.alloc(0);
        }
      }
    }
    at += 27 + segments.length +
      segments.reduce((sum, length) => sum + length, 0);
  }
  throw new Error('Missing Ogg comment packet');
}
