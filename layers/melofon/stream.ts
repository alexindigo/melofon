import type { HatRequest } from './types.ts';
import { fail } from './errors.ts';

/** Wire units are seconds and kbps, not the declaration's bits/s. */
export function streamOptions(request: HatRequest) {
  const params = new URL(request._raw.url).searchParams;
  for (const key of params.keys()) {
    if (
      !['format', 'maxBitRate', 'offset'].includes(key) ||
      params.getAll(key).length !== 1
    ) {
      fail(400, 'invalid_field', 'Unknown or repeated stream parameter');
    }
  }
  const format = params.get('format') ?? undefined;
  if (format !== undefined && !['mp3', 'aac', 'opus', 'ogg'].includes(format)) {
    fail(400, 'invalid_field', 'Invalid format');
  }
  const integer = (key: string, min: number, max: number) => {
    const raw = params.get(key);
    if (raw === null) return undefined;
    const value = Number(raw);
    if (
      !/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min ||
      value > max
    ) {
      fail(400, 'invalid_field', `Invalid ${key}`);
    }
    return value;
  };
  return {
    format,
    maxBitRateKbps: integer('maxBitRate', 1, 9007199254740),
    timeOffset: integer('offset', 0, 9007199254740),
  };
}
