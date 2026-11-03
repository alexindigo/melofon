// Independent lossless fixture encoder. No production image transforms involved.
import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';

export function pixelPng(width: number, height: number, rgba: Uint8Array) {
  function chunk(name: string, payload: Uint8Array) {
    const body = Buffer.concat([Buffer.from(name), payload]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) {
        crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    const result = Buffer.alloc(body.length + 8);
    result.writeUInt32BE(payload.length);
    result.set(body, 4);
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 4);
    return result;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    rows.set(
      rgba.subarray(y * width * 4, (y + 1) * width * 4),
      y * (width * 4 + 1) + 1,
    );
  }
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

export function twoFrameGif() {
  // Two LZW frames: red/blue, then blue/red (100 ms each).
  return new Uint8Array(Buffer.concat([
    Buffer.from('GIF89a'),
    Buffer.from([2, 0, 1, 0, 128, 0, 0, 255, 0, 0, 0, 0, 255]),
    Buffer.from([33, 255, 11]),
    Buffer.from('NETSCAPE2.0'),
    Buffer.from([3, 1, 0, 0, 0]),
    ...[68, 12].map((codes) =>
      Buffer.from([
        33,
        249,
        4,
        0,
        10,
        0,
        0,
        0,
        44,
        0,
        0,
        0,
        0,
        2,
        0,
        1,
        0,
        0,
        2,
        2,
        codes,
        10,
        0,
      ])
    ),
    Buffer.from([59]),
  ]));
}
