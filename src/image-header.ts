// Inspect bounded source bytes BEFORE invoking any native demuxer/decoder.
// Unknown/truncated formats are servable originals, never decoding candidates.
export interface ImageHeader {
  width: number;
  height: number;
  format: 'png' | 'jpeg' | 'gif' | 'webp';
  animated: boolean;
}

export function imageHeader(bytes: Uint8Array): ImageHeader | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at: number, length: number) =>
    String.fromCharCode(...bytes.subarray(at, at + length));
  if (bytes.length >= 24 && text(0, 8) === '\x89PNG\r\n\x1a\n') {
    let animated = false;
    for (let at = 8; at + 12 <= bytes.length;) {
      const n = v.getUint32(at);
      if (text(at + 4, 4) === 'acTL') animated = true;
      if (n > bytes.length - at - 12) break;
      at += n + 12;
    }
    return {
      width: v.getUint32(16),
      height: v.getUint32(20),
      format: 'png',
      animated,
    };
  }
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(text(0, 6))) {
    const width = v.getUint16(6, true), height = v.getUint16(8, true);
    let at = 13 + (bytes[10] & 128 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0);
    let frames = 0;
    const skipBlocks = () => {
      while (at < bytes.length) {
        const length = bytes[at++];
        if (length === 0) return true;
        if (length > bytes.length - at) return false;
        at += length;
      }
      return false;
    };
    while (at < bytes.length) {
      const block = bytes[at++];
      if (block === 59) break;
      if (block === 33) {
        at++;
        if (!skipBlocks()) return null;
      } else if (block === 44) {
        if (at + 9 > bytes.length) return null;
        // A logical-screen header must not conceal a larger decoding canvas.
        if (
          v.getUint16(at, true) + v.getUint16(at + 4, true) > width ||
          v.getUint16(at + 2, true) + v.getUint16(at + 6, true) > height
        ) return null;
        const flags = bytes[at + 8];
        at += 9 + (flags & 128 ? 3 * 2 ** ((flags & 7) + 1) : 0);
        at++; // LZW minimum code size
        if (!skipBlocks()) return null;
        frames++;
      } else return null;
    }
    return {
      width,
      height,
      format: 'gif',
      animated: frames > 1,
    };
  }
  if (bytes.length >= 30 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    const kind = text(12, 4);
    if (kind === 'VP8X') {
      const u24 = (at: number) =>
        bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536;
      return {
        width: u24(24) + 1,
        height: u24(27) + 1,
        format: 'webp',
        animated: !!(bytes[20] & 2),
      };
    }
    if (kind === 'VP8 ' && text(23, 3) === '\x9d\x01\x2a') {
      return {
        width: v.getUint16(26, true) & 16383,
        height: v.getUint16(28, true) & 16383,
        format: 'webp',
        animated: false,
      };
    }
    if (kind === 'VP8L' && bytes[20] === 47) {
      const bits = v.getUint32(21, true);
      return {
        width: (bits & 16383) + 1,
        height: ((bits >>> 14) & 16383) + 1,
        format: 'webp',
        animated: false,
      };
    }
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    for (let at = 2; at + 4 <= bytes.length;) {
      if (bytes[at++] !== 255) return null;
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (at + 2 > bytes.length) break;
      const length = v.getUint16(at);
      if (length < 2 || length > bytes.length - at) break;
      if (
        [192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207]
          .includes(marker) && length >= 7
      ) {
        return {
          width: v.getUint16(at + 5),
          height: v.getUint16(at + 3),
          format: 'jpeg',
          animated: false,
        };
      }
      at += length;
    }
  }
  return null;
}

export function withinPixels(
  header: ImageHeader | null,
  maxPixels: number,
): header is ImageHeader {
  return header !== null && header.width > 0 && header.height > 0 &&
    header.width <= maxPixels / header.height;
}
