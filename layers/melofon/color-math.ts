/** Oklab D65 coordinates. Matrices: Bjorn Ottosson, 2021-01-25,
 * https://bottosson.github.io/posts/oklab/ (public domain / MIT).
 * See artwork-codecs-LICENSE.md for provenance. */
export type Oklab = readonly [lightness: number, a: number, b: number];

function linearChannel(byte: number): number {
  const channel = byte / 255;
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

/** Convert sRGB channels in [0, 255] to Oklab, linearizing before the matrices. */
export function srgbToOklab(red: number, green: number, blue: number): Oklab {
  const r = linearChannel(red);
  const g = linearChannel(green);
  const b = linearChannel(blue);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

export function oklabDistanceSquared(left: Oklab, right: Oklab): number {
  return (left[0] - right[0]) ** 2 + (left[1] - right[1]) ** 2 +
    (left[2] - right[2]) ** 2;
}
