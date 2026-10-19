// Only music-metadata runs here. Termination stops even a synchronous parser.
import { boundedMetadata } from './lyrics-metadata.ts';

// This module is checked with the main graph as well as in a worker graph.
// State the specific worker API without aliasing or redeclaring its global object.
declare function postMessage(value: unknown): void;
addEventListener('message', async (event) => {
  try {
    const { path, maxBytes } =
      (event as MessageEvent<{ path: string; maxBytes: number }>).data;
    using file = await Deno.open(path, { read: true });
    const header = new Uint8Array(12);
    const length = await file.read(header) ?? 0;
    const ascii = new TextDecoder('latin1').decode(header.subarray(0, length));
    if (
      !(ascii.startsWith('ID3') || ascii.startsWith('fLaC') ||
        ascii.startsWith('OggS') ||
        ['RIFF', 'RF64', 'BW64'].includes(ascii.slice(0, 4)) ||
        ['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'].includes(
          ascii.slice(4, 8),
        ) ||
        (header[0] === 0xff && (header[1] & 0xe0) === 0xe0) ||
        (header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf &&
          header[3] === 0xa3))
    ) {
      throw new Error('Unrecognized media header');
    }
    const metadata = await boundedMetadata(path, maxBytes, { duration: false });
    postMessage({ metadata });
  } catch (error) {
    postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
