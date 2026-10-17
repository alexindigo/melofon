// Real ID3v2.4 tagged copies with the fixture's compressed audio unchanged.
export async function tagged(path: string, tags: Record<string, string>) {
  const original = await Deno.readFile(
    'tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3',
  );
  const skip = original[0] === 73 && original[1] === 68 && original[2] === 51
    ? 10 +
      ((original[6] << 21) | (original[7] << 14) | (original[8] << 7) |
        original[9])
    : 0;
  const syncSize = (
    n: number,
  ) => [n >> 21 & 127, n >> 14 & 127, n >> 7 & 127, n & 127];
  const frames = Object.entries(tags).map(([key, value]) => {
    const payload = new TextEncoder().encode(value);
    const frame = new Uint8Array(11 + payload.length);
    frame.set(new TextEncoder().encode(key));
    frame.set(syncSize(payload.length + 1), 4);
    frame[10] = 3;
    frame.set(payload, 11);
    return frame;
  });
  const size = frames.reduce((n, f) => n + f.length, 0);
  const bytes = new Uint8Array(10 + size + original.length - skip);
  bytes.set([73, 68, 51, 4, 0, 0, ...syncSize(size)]);
  let at = 10;
  for (const frame of frames) {
    bytes.set(frame, at);
    at += frame.length;
  }
  bytes.set(original.subarray(skip), at);
  await Deno.writeFile(path, bytes);
}
