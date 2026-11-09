import { assertEquals } from '@std/assert';
import { dominantColor } from '#melofon/dominant-color.ts';
import { oklabDistanceSquared, srgbToOklab } from '#melofon/color-math.ts';

// Deliberately no spatial index, pruning or shared accumulation with production.
// Every distinct RGB is evaluated against every fixed centre.
function reference(rgba: Uint8Array): string {
  const counts = new Map<number, number>();
  for (let i = 0; i < rgba.length; i += 4) {
    if (!rgba[i + 3]) continue;
    const rgb = rgba[i] * 65536 + rgba[i + 1] * 256 + rgba[i + 2];
    counts.set(rgb, (counts.get(rgb) ?? 0) + 1);
  }
  const colors = [...counts].map(([rgb, count]) => ({
    rgb,
    count,
    r: rgb >>> 16,
    g: rgb >>> 8 & 255,
    b: rgb & 255,
    lab: srgbToOklab(rgb >>> 16, rgb >>> 8 & 255, rgb & 255),
  }));
  let bestCount = 0, bestRgb = 0xffffff, result = '';
  for (const centre of colors) {
    let count = 0, r = 0, g = 0, b = 0;
    for (const neighbor of colors) {
      if (oklabDistanceSquared(centre.lab, neighbor.lab) > 0.08 ** 2) continue;
      count += neighbor.count;
      r += neighbor.r * neighbor.count;
      g += neighbor.g * neighbor.count;
      b += neighbor.b * neighbor.count;
    }
    if (count > bestCount || (count === bestCount && centre.rgb < bestRgb)) {
      bestCount = count;
      bestRgb = centre.rgb;
      result = '#' +
        [r, g, b].map((v) =>
          Math.round(v / count).toString(16).padStart(2, '0')
        ).join('');
    }
  }
  return result;
}

function check(rgba: Uint8Array) {
  const before = rgba.slice();
  assertEquals(dominantColor(rgba), reference(rgba));
  assertEquals(rgba, before);
}

Deno.test('dominant colour: exact brute-force agreement for seeded random images and views', () => {
  let state = 0x13579b;
  for (let run = 0; run < 40; run++) {
    const rgba = new Uint8Array((run * 13 + 1) * 4);
    for (let i = 0; i < rgba.length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      rgba[i] = state >>> 24;
    }
    check(rgba);
    check(rgba.subarray(4, rgba.length - 4));
  }
});

Deno.test('dominant colour: exact brute-force agreement for dense cells, gradients and boundary ties', () => {
  for (const mode of ['dense', 'gradient', 'random']) {
    const rgba = new Uint8Array(10000 * 4);
    let state = 0x13579b;
    for (let i = 0; i < 10000; i++) {
      const x = i % 100, y = Math.floor(i / 100);
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const rgb = mode === 'dense'
        ? [
          117 + i % 22,
          117 + Math.floor(i / 22) % 22,
          117 + Math.floor(i / 484),
        ]
        : mode === 'gradient'
        ? [
          Math.round(x * 255 / 99),
          Math.round(y * 255 / 99),
          Math.round((x + y) * 255 / 198),
        ]
        : [state >>> 16 & 255, state >>> 8 & 255, state & 255];
      rgba.set([...rgb, 255], i * 4);
    }
    check(rgba);
  }
  // Dense shades cross cell boundaries, including negative a/b, and sit on both
  // sides of the radius around neutral 128. Repeats exercise population weights.
  const boundary: number[] = [];
  for (const r of [0, 1, 10, 11, 127, 128, 129, 151, 152, 153, 254, 255]) {
    for (const g of [0, 128, 152, 153, 255]) {
      for (const b of [0, 128, 152, 153, 255]) {
        for (let repeat = 0; repeat < 1 + r % 3; repeat++) {
          boundary.push(r, g, b, 255);
        }
      }
    }
  }
  check(new Uint8Array(boundary));
  check(new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]));
  check(new Uint8Array([255, 0, 0, 0, 0, 0, 255, 0]));
});
