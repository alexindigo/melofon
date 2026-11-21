import { assertEquals } from '@std/assert';
import { concatenate } from './timeline-proof.ts';

/** Independent integer reference, including head exclusion on short chains. */
export function crossfadeReference(parts: Uint8Array[], frames: number) {
  const applied: number[] = [];
  let previousHead = 0;
  let result = parts[0].slice();
  for (let k = 1; k < parts.length; k++) {
    const a = parts[k - 1], b = parts[k];
    let count = Math.min(frames, a.length / 4 - previousHead, b.length / 4 - 1);
    if (count < 2) count = 0;
    applied.push(count);
    const av = new DataView(a.buffer, a.byteOffset, a.length);
    const bv = new DataView(b.buffer, b.byteOffset, b.length);
    const mix = new Uint8Array(count * 4), out = new DataView(mix.buffer);
    for (let i = 0; i < count; i++) {
      const d = BigInt(count - 1);
      for (let c = 0; c < 2; c++) {
        const n =
          BigInt(av.getInt16(a.length - count * 4 + i * 4 + c * 2, true)) *
            (d - BigInt(i)) +
          BigInt(bv.getInt16(i * 4 + c * 2, true)) * BigInt(i);
        const numerator = 2n * n + d, denominator = 2n * d;
        let value = numerator / denominator;
        if (numerator < 0n && numerator % denominator) value--;
        out.setInt16(i * 4 + c * 2, Number(value), true);
      }
    }
    result = concatenate([
      result.subarray(0, result.length - count * 4),
      mix,
      b.subarray(count * 4),
    ]);
    previousHead = count;
  }
  assertEquals(
    result.length,
    parts.reduce((n, p) => n + p.length, 0) -
      applied.reduce((n, f) => n + f, 0) * 4,
  );
  return { pcm: result, applied };
}
