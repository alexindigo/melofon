import { tagged } from './tagged.ts';

/** Real ID3 APIC frames over fixture audio, without a media CLI. */
export async function pictured(
  path: string,
  picture?: Uint8Array,
  tags: Record<string, string> = {},
) {
  await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await tagged(path, { TALB: 'Album', TPE2: 'Artist', ...tags });
  if (!picture) return;
  const original = await Deno.readFile(path);
  const size = (original[6] << 21) | (original[7] << 14) | (original[8] << 7) |
    original[9];
  const syncSize = (
    n: number,
  ) => [n >> 21 & 127, n >> 14 & 127, n >> 7 & 127, n & 127];
  const payload = new Uint8Array(14 + picture.length);
  payload.set([0, ...new TextEncoder().encode('image/jpeg'), 0, 3, 0]);
  payload.set(picture, 14);
  const frame = new Uint8Array(10 + payload.length);
  frame.set(new TextEncoder().encode('APIC'));
  frame.set(syncSize(payload.length), 4);
  frame.set(payload, 10);
  const bytes = new Uint8Array(original.length + frame.length);
  bytes.set(original.subarray(0, 10 + size));
  bytes.set(syncSize(size + frame.length), 6);
  bytes.set(frame, 10 + size);
  bytes.set(original.subarray(10 + size), 10 + size + frame.length);
  await Deno.writeFile(path, bytes);
}
