// Core raster source, independent of hats, system fonts and external services.
// Unifont's bitmap format is one hex-encoded 8/16 x 16 glyph per BMP code point.
import { encodeImagePixels } from './media.ts';
import { imageHash } from './images.ts';

// Bump when font data, text layout or palette policy changes.
export const RADIO_TILE_REVISION = 'unifont-18.0.01-tile-1';

function identifyPng(png: Uint8Array, identity: string) {
  // Keep input identity even when different URLs happen to yield the same RGB
  // palette or names normalize to identical pixels. Only a digest is embedded.
  const text = new TextEncoder().encode(`melofon-radio\0${identity}`);
  const chunk = new Uint8Array(12 + text.length);
  new DataView(chunk.buffer).setUint32(0, text.length);
  chunk.set(new TextEncoder().encode('tEXt'), 4);
  chunk.set(text, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  new DataView(chunk.buffer).setUint32(
    chunk.length - 4,
    (crc ^ 0xffffffff) >>> 0,
  );
  // Insert before IEND. PNG pixel compression remains in node-av.
  const result = new Uint8Array(png.length + chunk.length);
  result.set(png.subarray(0, -12));
  result.set(chunk, png.length - 12);
  result.set(png.subarray(-12), png.length - 12 + chunk.length);
  return result;
}

interface Cell {
  glyphs: string[];
  width: number;
}

function lineWidth(cells: Cell[]) {
  return cells.reduce((sum, cell) => sum + cell.width, 0);
}

function wrap(cells: Cell[], width: number): Cell[][] {
  const lines: Cell[][] = [];
  let line: Cell[] = [];
  for (const cell of cells) {
    if (lineWidth(line) + cell.width > width && line.length) {
      // Prefer a word boundary; long words and CJK wrap by grapheme.
      const space = line.findLastIndex((c) =>
        c.glyphs.every((g) => /^0+$/.test(g))
      );
      if (space > 0) {
        lines.push(line.slice(0, space));
        line = line.slice(space + 1);
      } else {
        lines.push(line);
        line = [];
      }
    }
    line.push(cell);
  }
  if (line.length) lines.push(line);
  return lines;
}

export function createRadioArtwork() {
  let font: Promise<Map<number, string>> | undefined;
  async function glyphs() {
    font ??= (async () => {
      const bytes = await Deno.readFile(
        new URL('./fonts/unifont-18.0.01.hex.gz', import.meta.url),
      );
      const text = await new Response(
        new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
      ).text();
      return new Map(
        text.trim().split('\n').map((line) => {
          const [code, glyph] = line.split(':');
          return [parseInt(code, 16), glyph];
        }),
      );
    })();
    try {
      return await font;
    } catch (error) {
      font = undefined;
      throw error;
    }
  }

  return async (
    name: string,
    streamUrl: string,
    size: number,
    maxCharacters: number,
  ) => {
    const table = await glyphs();
    const cellFor = (text: string): Cell => {
      const glyphs = Array.from(
        text,
        (char) => table.get(char.codePointAt(0)!) ?? table.get(0xfffd)!,
      );
      return { glyphs, width: Math.max(...glyphs.map((g) => g.length / 4)) };
    };
    const cells: Cell[] = [];
    const text = name.normalize('NFC').replace(/\s+/gu, ' ').replace(
      /[\p{Cc}\p{Cf}]/gu,
      '',
    ).trim();
    for (
      const { segment } of new Intl.Segmenter('und', {
        granularity: 'grapheme',
      }).segment(text)
    ) {
      if (cells.length === maxCharacters) {
        cells.push(cellFor('\u2026'));
        break;
      }
      cells.push(cellFor(segment));
    }
    if (!cells.length) cells.push(cellFor('\ufffd'));
    const padding = Math.ceil(size / 16);
    const available = size - padding * 2;
    let scale = Math.max(1, Math.floor(size / 96));
    let lines = wrap(cells, Math.floor(available / scale));
    while (scale > 1 && lines.length * 20 * scale > available) {
      scale--;
      lines = wrap(cells, Math.floor(available / scale));
    }
    const maxLines = Math.max(1, Math.floor(available / (20 * scale)));
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      const last = lines[maxLines - 1];
      const ellipsis = cellFor('\u2026');
      while (lineWidth(last) + ellipsis.width > available / scale) last.pop();
      last.push(ellipsis);
    }
    const hash = await imageHash(new TextEncoder().encode(streamUrl));
    // A URL-derived dark RGB palette with white text (contrast at least 7:1).
    const background = [0, 2, 4].map((i) =>
      24 + parseInt(hash.slice(i, i + 2), 16) % 64
    );
    const pixels = new Uint8Array(size * size * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels.set([...background, 255], i);
    }
    let y = Math.floor((size - (lines.length * 20 - 4) * scale) / 2);
    for (const line of lines) {
      let x = Math.floor((size - lineWidth(line) * scale) / 2);
      for (const cell of line) {
        for (const glyph of cell.glyphs) {
          const width = glyph.length / 4;
          const left = x + Math.floor((cell.width - width) * scale / 2);
          for (let row = 0; row < 16; row++) {
            const bits = parseInt(
              glyph.slice(row * width / 4, (row + 1) * width / 4),
              16,
            );
            for (let col = 0; col < width; col++) {
              if (!(bits & (1 << (width - col - 1)))) continue;
              for (let dy = 0; dy < scale; dy++) {
                for (let dx = 0; dx < scale; dx++) {
                  pixels.set(
                    [255, 255, 255, 255],
                    ((y + row * scale + dy) * size + left + col * scale + dx) *
                      4,
                  );
                }
              }
            }
          }
        }
        x += cell.width * scale;
      }
      y += 20 * scale;
    }
    return identifyPng(
      await encodeImagePixels(pixels, size, size),
      await imageHash(
        new TextEncoder().encode(
          JSON.stringify([
            RADIO_TILE_REVISION,
            name,
            streamUrl,
            size,
            maxCharacters,
          ]),
        ),
      ),
    );
  };
}
