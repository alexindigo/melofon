import { type Oklab, oklabDistanceSquared, srgbToOklab } from './color-math.ts';

const radius = 0.08;

type Color = {
  rgb: number;
  count: number;
  lab: Oklab;
  population: number;
  red: number;
  green: number;
  blue: number;
};

/** Packed straight RGBA; alpha-0 pixels are skipped entirely. Every other pixel
 * counts once with its straight RGB, without backdrop compositing or alpha weights.
 * Empty or fully transparent input returns ''.
 * Each exact RGB is a fixed neighbourhood centre, never a moving/merged mean.
 * For n pixels and u distinct RGBs: O(n + u + p) time, O(u) space, where p is
 * the number of pairs in adjacent radius-sized Oklab cells (worst case u^2).
 * Artwork facts supply at most 100 x 100 pixels; there is no colour-count cap.
 */
export function dominantColor(rgba: Uint8Array): string {
  if (rgba.length % 4 !== 0) {
    throw new RangeError('Expected packed RGBA pixels');
  }
  if (rgba.length === 0) return '';

  const counts = new Map<number, number>();
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    const rgb = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    counts.set(rgb, (counts.get(rgb) ?? 0) + 1);
  }
  if (counts.size === 0) return '';

  const cells = new Map<string, Color[]>();
  const colors: Color[] = [];
  for (const [rgb, count] of counts) {
    const red = rgb >>> 16;
    const green = (rgb >>> 8) & 255;
    const blue = rgb & 255;
    const lab = srgbToOklab(red, green, blue);
    const color: Color = {
      rgb,
      count,
      lab,
      population: count,
      red: red * count,
      green: green * count,
      blue: blue * count,
    };
    const [l, a, b] = lab.map((coordinate) => Math.floor(coordinate / radius));
    // Visit each unordered pair once and add its exact pixel weights to both
    // fixed centres. Integer sums make every permutation produce the same mean.
    for (let dl = -1; dl <= 1; dl++) {
      for (let da = -1; da <= 1; da++) {
        for (let db = -1; db <= 1; db++) {
          const neighbors = cells.get(`${l + dl},${a + da},${b + db}`);
          if (!neighbors) continue;
          for (const other of neighbors) {
            if (oklabDistanceSquared(lab, other.lab) > radius * radius) {
              continue;
            }
            color.population += other.count;
            color.red += (other.rgb >>> 16) * other.count;
            color.green += ((other.rgb >>> 8) & 255) * other.count;
            color.blue += (other.rgb & 255) * other.count;
            other.population += count;
            other.red += red * count;
            other.green += green * count;
            other.blue += blue * count;
          }
        }
      }
    }
    const key = `${l},${a},${b}`;
    const cell = cells.get(key);
    if (cell) cell.push(color);
    else cells.set(key, [color]);
    colors.push(color);
  }

  let winner = colors[0];
  for (const color of colors) {
    if (
      color.population > winner.population ||
      (color.population === winner.population && color.rgb < winner.rgb)
    ) winner = color;
  }
  return '#' + [winner.red, winner.green, winner.blue]
    .map((sum) =>
      Math.round(sum / winner.population).toString(16).padStart(2, '0')
    )
    .join('');
}
