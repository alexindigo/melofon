import { Buffer } from 'node:buffer';
import { tagged } from './tagged.ts';

/** Fixture-only ID3 containers over real compressed audio. */
export async function lyricMp3(
  path: string,
  entries: {
    lang?: string;
    text?: string;
    sylt?: { text: string; timestamp: number }[];
    format?: number;
  }[] = [],
  tags: Record<string, string> = {},
) {
  await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await tagged(path, {
    TIT2: 'Song',
    TPE1: 'Artist',
    TALB: 'Album',
    TPE2: 'Album Artist',
    ...tags,
  });
  const bytes = Buffer.from(await Deno.readFile(path));
  const size = (
    n: number,
  ) => [n >> 21 & 127, n >> 14 & 127, n >> 7 & 127, n & 127];
  const oldSize = bytes[6] * 2097152 + bytes[7] * 16384 + bytes[8] * 128 +
    bytes[9];
  const frames = entries.map((entry) => {
    const synced = entry.sylt !== undefined;
    const payload = synced
      ? Buffer.concat([
        Buffer.from([3]),
        Buffer.from(entry.lang ?? 'eng'),
        Buffer.from([entry.format ?? 2, 1, 0]),
        ...entry.sylt!.map((line) => {
          const time = Buffer.alloc(4);
          time.writeUInt32BE(line.timestamp);
          return Buffer.concat([
            Buffer.from(line.text),
            Buffer.from([0]),
            time,
          ]);
        }),
      ])
      : Buffer.concat([
        Buffer.from([3]),
        Buffer.from(entry.lang ?? 'eng'),
        Buffer.from([0]),
        Buffer.from(entry.text ?? ''),
      ]);
    return Buffer.concat([
      Buffer.from(synced ? 'SYLT' : 'USLT'),
      Buffer.from(size(payload.length)),
      Buffer.from([0, 0]),
      payload,
    ]);
  });
  const result = Buffer.concat([
    bytes.subarray(0, 10 + oldSize),
    ...frames,
    bytes.subarray(10 + oldSize),
  ]);
  result.set(
    size(oldSize + frames.reduce((sum, frame) => sum + frame.length, 0)),
    6,
  );
  await Deno.writeFile(path, result);
}
