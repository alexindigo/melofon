import { type Oklab, oklabDistanceSquared, srgbToOklab } from './color-math.ts';

const radius = 0.08;

type Totals = { population: number; red: number; green: number; blue: number };
type Color = { rgb: number; lab: Oklab; totals: Totals };
type Bounds = { min: readonly number[]; max: readonly number[] };
type Cell = Bounds & {
  min: number[];
  max: number[];
  l: number;
  a: number;
  b: number;
  index: number;
  colors: Color[];
  totals: Totals;
  included: Totals;
  boundary: Cell[];
  maximumPopulation: number;
  minimumRgb: number;
};

function add(target: Totals, source: Totals) {
  target.population += source.population;
  target.red += source.red;
  target.green += source.green;
  target.blue += source.blue;
}

// Base-256 axes contain all sRGB Oklab cell coordinates and the search halo;
// signed coordinates need no offset because each axis span is less than 256.
function cellKey(l: number, a: number, b: number) {
  return l * 65536 + a * 256 + b;
}

function boxDistanceSquared(left: Bounds, right: Bounds, farthest: boolean) {
  let distance = 0;
  for (let axis = 0; axis < 3; axis++) {
    const delta = farthest
      ? Math.max(
        Math.abs(left.min[axis] - right.max[axis]),
        Math.abs(left.max[axis] - right.min[axis]),
      )
      : Math.max(
        0,
        left.min[axis] - right.max[axis],
        right.min[axis] - left.max[axis],
      );
    distance += delta ** 2;
  }
  return distance;
}

/** Packed straight RGBA; alpha-0 pixels are skipped entirely. Every other pixel
 * counts once with its straight RGB, without backdrop compositing or alpha weights.
 * Empty or fully transparent input returns ''.
 * Each exact RGB is a fixed neighbourhood centre, never a moving/merged mean.
 * Radius/2 cells aggregate integer weights. Actual occupied bounds exclude cells
 * outside the sphere and include whole cells inside it; only boundary cells
 * require point checks. For n pixels, u colours and c occupied cells: O(n + u +
 * c log c + boundary queries/checks), O(u + c) space; worst-case time remains O(u^2).
 * Artwork facts supply at most 100 x 100 pixels; there is no colour-count cap.
 */
export function dominantColor(rgba: Uint8Array): string {
  if (rgba.length % 4 !== 0) {
    throw new RangeError('Expected packed RGBA pixels');
  }
  if (rgba.length === 0) return '';

  const cellSize = radius / 2;
  const counts = new Map<number, number>();
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    const rgb = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    counts.set(rgb, (counts.get(rgb) ?? 0) + 1);
  }
  if (counts.size === 0) return '';

  const grid = new Map<number, Cell>();
  const cells: Cell[] = [];
  for (const [rgb, count] of counts) {
    const red = rgb >>> 16;
    const green = (rgb >>> 8) & 255;
    const blue = rgb & 255;
    const lab = srgbToOklab(red, green, blue);
    const color: Color = {
      rgb,
      lab,
      totals: {
        population: count,
        red: red * count,
        green: green * count,
        blue: blue * count,
      },
    };
    const [l, a, b] = lab.map((coordinate) =>
      Math.floor(coordinate / cellSize)
    );
    const key = cellKey(l, a, b);
    let cell = grid.get(key);
    if (!cell) {
      cell = {
        l,
        a,
        b,
        index: cells.length,
        colors: [],
        min: [...lab],
        max: [...lab],
        totals: { population: 0, red: 0, green: 0, blue: 0 },
        included: { population: 0, red: 0, green: 0, blue: 0 },
        boundary: [],
        maximumPopulation: 0,
        minimumRgb: rgb,
      };
      cells.push(cell);
      grid.set(key, cell);
    }
    cell.colors.push(color);
    cell.minimumRgb = Math.min(cell.minimumRgb, rgb);
    add(cell.totals, color.totals);
    for (let axis = 0; axis < 3; axis++) {
      cell.min[axis] = Math.min(cell.min[axis], lab[axis]);
      cell.max[axis] = Math.max(cell.max[axis], lab[axis]);
    }
  }

  // Classify each unordered cell pair once. The extra cell in the search halo
  // is conservative at floating-point division boundaries, not an epsilon in
  // the radius test. Bounds use the same squared-distance operation order.
  for (const cell of cells) {
    add(cell.included, cell.totals); // A cell's diameter is < radius.
    for (let dl = -3; dl <= 3; dl++) {
      for (let da = -3; da <= 3; da++) {
        for (let db = -3; db <= 3; db++) {
          const other = grid.get(
            cellKey(cell.l + dl, cell.a + da, cell.b + db),
          );
          if (!other || other.index <= cell.index) continue;
          if (boxDistanceSquared(cell, other, false) > radius * radius) {
            continue;
          }
          if (boxDistanceSquared(cell, other, true) <= radius * radius) {
            add(cell.included, other.totals);
            add(other.included, cell.totals);
          } else {
            cell.boundary.push(other);
            other.boundary.push(cell);
          }
        }
      }
    }
  }

  // Visit the most populated candidate regions first. The sum of all possible
  // cells is an exact upper bound, so less populated regions cannot hide a winner.
  for (const cell of cells) {
    cell.maximumPopulation = cell.included.population;
    for (const other of cell.boundary) {
      cell.maximumPopulation += other.totals.population;
    }
  }
  cells.sort((left, right) =>
    right.maximumPopulation - left.maximumPopulation ||
    left.minimumRgb - right.minimumRgb
  );
  let winner = cells[0].colors[0];
  let bestPopulation = 0;
  for (const cell of cells) {
    if (cell.maximumPopulation < bestPopulation) break;
    for (const color of cell.colors) {
      if (
        cell.maximumPopulation === bestPopulation && color.rgb >= winner.rgb
      ) continue;
      let population = cell.included.population;
      const point = { min: color.lab, max: color.lab };
      for (const other of cell.boundary) {
        if (boxDistanceSquared(point, other, false) > radius * radius) continue;
        if (boxDistanceSquared(point, other, true) <= radius * radius) {
          population += other.totals.population;
        } else {
          for (const neighbor of other.colors) {
            if (
              oklabDistanceSquared(color.lab, neighbor.lab) <= radius * radius
            ) {
              population += neighbor.totals.population;
            }
          }
        }
      }
      if (
        population > bestPopulation ||
        (population === bestPopulation && color.rgb < winner.rgb)
      ) {
        bestPopulation = population;
        winner = color;
      }
    }
  }
  // Only the winning centre needs channel sums. This final linear pass keeps the
  // weighted mean independent of pruning order and avoids sums for losing centres.
  const totals: Totals = { population: 0, red: 0, green: 0, blue: 0 };
  for (const cell of cells) {
    for (const color of cell.colors) {
      if (oklabDistanceSquared(winner.lab, color.lab) <= radius * radius) {
        add(totals, color.totals);
      }
    }
  }
  return '#' + [totals.red, totals.green, totals.blue]
    .map((sum) =>
      Math.round(sum / totals.population).toString(16).padStart(2, '0')
    )
    .join('');
}
