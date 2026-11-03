// Encoder-only TypeScript port of evanw/thumbhash, Copyright (c) 2023 Evan Wallace.
// Upstream a652ce6ed691242f459f468f0a8756cda3b90a82, js/thumbhash.js.
// MIT permission notice: artwork-codecs-LICENSE.md.

/** Encode packed, straight (not premultiplied) RGBA, with both dimensions 1..100. */
export function rgbaToThumbHash(
  w: number,
  h: number,
  rgba: Uint8Array,
): Uint8Array {
  if (
    !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 ||
    w > 100 || h > 100 || rgba.length !== w * h * 4
  ) {
    throw new RangeError(
      'ThumbHash requires packed RGBA with dimensions 1..100',
    );
  }
  const { PI, round, max, cos, abs } = Math;

  // Determine the alpha-weighted average color.
  let avgR = 0, avgG = 0, avgB = 0, avgA = 0;
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const alpha = rgba[j + 3] / 255;
    avgR += alpha / 255 * rgba[j];
    avgG += alpha / 255 * rgba[j + 1];
    avgB += alpha / 255 * rgba[j + 2];
    avgA += alpha;
  }
  if (avgA) {
    avgR /= avgA;
    avgG /= avgA;
    avgB /= avgA;
  }

  const hasAlpha = avgA < w * h;
  const lLimit = hasAlpha ? 5 : 7;
  const lx = max(1, round(lLimit * w / max(w, h)));
  const ly = max(1, round(lLimit * h / max(w, h)));
  const l: number[] = [], p: number[] = [], q: number[] = [], a: number[] = [];

  // Convert RGBA to LPQA, compositing atop the average color.
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const alpha = rgba[j + 3] / 255;
    const r = avgR * (1 - alpha) + alpha / 255 * rgba[j];
    const g = avgG * (1 - alpha) + alpha / 255 * rgba[j + 1];
    const b = avgB * (1 - alpha) + alpha / 255 * rgba[j + 2];
    l[i] = (r + g + b) / 3;
    p[i] = (r + g) / 2 - b;
    q[i] = r - g;
    a[i] = alpha;
  }

  // Keep reference JS operation order and Math.round, including quantization ties.
  const encodeChannel = (
    channel: number[],
    nx: number,
    ny: number,
  ): [number, number[], number] => {
    let dc = 0, scale = 0;
    const ac: number[] = [], fx: number[] = [];
    for (let cy = 0; cy < ny; cy++) {
      for (let cx = 0; cx * ny < nx * (ny - cy); cx++) {
        let f = 0;
        for (let x = 0; x < w; x++) fx[x] = cos(PI / w * cx * (x + 0.5));
        for (let y = 0; y < h; y++) {
          for (let x = 0, fy = cos(PI / h * cy * (y + 0.5)); x < w; x++) {
            f += channel[x + y * w] * fx[x] * fy;
          }
        }
        f /= w * h;
        if (cx || cy) {
          ac.push(f);
          scale = max(scale, abs(f));
        } else dc = f;
      }
    }
    if (scale) {
      for (let i = 0; i < ac.length; i++) ac[i] = 0.5 + 0.5 / scale * ac[i];
    }
    return [dc, ac, scale];
  };
  const [lDc, lAc, lScale] = encodeChannel(l, max(3, lx), max(3, ly));
  const [pDc, pAc, pScale] = encodeChannel(p, 3, 3);
  const [qDc, qAc, qScale] = encodeChannel(q, 3, 3);
  const [aDc, aAc, aScale] = hasAlpha ? encodeChannel(a, 5, 5) : [0, [], 0];

  const isLandscape = w > h;
  const header24 = round(63 * lDc) | (round(31.5 + 31.5 * pDc) << 6) |
    (round(31.5 + 31.5 * qDc) << 12) | (round(31 * lScale) << 18) |
    (Number(hasAlpha) << 23);
  const header16 = (isLandscape ? ly : lx) | (round(63 * pScale) << 3) |
    (round(63 * qScale) << 9) | (Number(isLandscape) << 15);
  const hash = [
    header24 & 255,
    (header24 >> 8) & 255,
    header24 >> 16,
    header16 & 255,
    header16 >> 8,
  ];
  const acStart = hasAlpha ? 6 : 5;
  let acIndex = 0;
  if (hasAlpha) hash.push(round(15 * aDc) | (round(15 * aScale) << 4));

  for (const ac of hasAlpha ? [lAc, pAc, qAc, aAc] : [lAc, pAc, qAc]) {
    for (const f of ac) {
      hash[acStart + (acIndex >> 1)] |= round(15 * f) << ((acIndex++ & 1) << 2);
    }
  }
  return new Uint8Array(hash);
}
