// Position-identifiable stereo PCM, decoded through the real production media API.
export function pcmAt(frame: number): [number, number] {
  return [1000 + (frame % 20000), -1000 - (Math.floor(frame / 20000) % 20000)];
}
export async function writeFixture(path: string) {
  const frames = 180 * 44100;
  const wav = new Uint8Array(44 + frames * 4);
  const data = new DataView(wav.buffer);
  const text = new TextEncoder();
  wav.set(text.encode('RIFF'), 0);
  data.setUint32(4, wav.length - 8, true);
  wav.set(text.encode('WAVEfmt '), 8);
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 2, true);
  data.setUint32(24, 44100, true);
  data.setUint32(28, 176400, true);
  data.setUint16(32, 4, true);
  data.setUint16(34, 16, true);
  wav.set(text.encode('data'), 36);
  data.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i++) {
    const [left, right] = pcmAt(i);
    data.setInt16(44 + i * 4, left, true);
    data.setInt16(46 + i * 4, right, true);
  }
  await Deno.writeFile(path, wav, { createNew: true });
}
