import { assertEquals } from '@std/assert';
import { decodeReceiverAudio } from './helpers/raop-audio-consumer.ts';

const SDP =
  'a=rtpmap:96 AppleLossless\r\na=fmtp:96 352 0 16 40 10 14 2 255 0 0 44100\r\n';

Deno.test('receiver ALAC decoder calibration: known uncompressed stereo frame is byte-exact', () => {
  // Independent raw ALAC fixture: CPE element, no explicit size, 16-bit
  // uncompressed samples, END element. First 32 samples are silent.
  const pcm = new Uint8Array(352 * 4);
  const view = new DataView(pcm.buffer);
  let bits = '001' + '0000' + '00000000' + '0000' + '0' + '00' + '1';
  for (let i = 0; i < 352; i++) {
    const left = i < 32 ? 0 : 100 + i;
    const right = i < 32 ? 0 : -200 - i;
    view.setInt16(i * 4, left, true);
    view.setInt16(i * 4 + 2, right, true);
    bits += (left & 0xffff).toString(2).padStart(16, '0');
    bits += (right & 0xffff).toString(2).padStart(16, '0');
  }
  bits += '111';
  bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
  const encoded = Uint8Array.from(
    bits.match(/.{8}/g)!.map((b) => Number.parseInt(b, 2)),
  );
  assertEquals(decodeReceiverAudio(SDP, [encoded]), pcm);
});
