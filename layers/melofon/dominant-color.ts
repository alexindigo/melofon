// Adapted from Navidrome core/artwork/dominant/dominant.go (GPL-3.0-only).
// Provenance and license information: artwork-codecs-LICENSE.md.

type ColorBin = { index: number; r: number; g: number; b: number; n: number };

/**
 * Prevalent color, not average or salience, as lowercase #rrggbb; empty is ''.
 * Packed straight RGBA; alpha is deliberately ignored, including hidden RGB,
 * matching Navidrome's NRGBA thumbnail path. Never mutates the input.
 */
export function dominantColor(rgba: Uint8Array): string {
  if (rgba.length % 4) {
    throw new RangeError('Dominant color requires packed RGBA');
  }
  if (!rgba.length) return '';
  const bins = new Map<number, ColorBin>();
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const index = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bin = bins.get(index) ?? { index, r: 0, g: 0, b: 0, n: 0 };
    bin.r += r;
    bin.g += g;
    bin.b += b;
    bin.n++;
    bins.set(index, bin);
  }
  // Deterministic bin-index ordering resolves count ties before the 64-bin cap.
  const ranked = [...bins.values()].sort((a, b) =>
    b.n - a.n || a.index - b.index
  ).slice(0, 64);
  const merged: ColorBin[] = [];
  for (const bin of ranked) {
    const lab = oklab(bin);
    // First matching cluster, not the globally nearest one. Recompute means
    // after merging so later bins compare against the accumulated cluster.
    const cluster = merged.find((m) => {
      const other = oklab(m);
      return Math.hypot(
        lab[0] - other[0],
        lab[1] - other[1],
        lab[2] - other[2],
      ) < 0.10;
    });
    if (cluster) {
      cluster.r += bin.r;
      cluster.g += bin.g;
      cluster.b += bin.b;
      cluster.n += bin.n;
    } else merged.push({ ...bin });
  }
  let best = merged[0];
  for (const bin of merged.slice(1)) if (bin.n > best.n) best = bin;
  return '#' +
    [best.r, best.g, best.b].map((v) =>
      Math.round(v / best.n).toString(16).padStart(2, '0')
    ).join('');
}

function srgbToLinear(v: number): number {
  v /= 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function oklab(bin: ColorBin): [number, number, number] {
  const r = srgbToLinear(bin.r / bin.n);
  const g = srgbToLinear(bin.g / bin.n);
  const b = srgbToLinear(bin.b / bin.n);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}
