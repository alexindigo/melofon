// src/zip.ts — app.zip: a zip archive of catalog files as a Blob, for
// download.view on album/artist/playlist ids (Navidrome shape). Entries are
// stored, not deflated (level 0): audio is already compressed, and deflate
// would be pure CPU waste. Built in memory — the amendment allows it; a
// household album is tens of MB.
import { BlobWriter, Uint8ArrayReader, ZipWriter } from '@zip-js/zip-js';

export interface ZipEntry {
  /** Path inside the archive (the simulated Artist/Album/01 - Song.mp3). */
  name: string;
  /** Absolute path of the file to read. */
  path: string;
}

export interface ZipService {
  archive(entries: ZipEntry[]): Promise<Blob>;
}

export function createZip(): ZipService {
  return {
    async archive(entries) {
      const writer = new ZipWriter(new BlobWriter('application/zip'));
      for (const entry of entries) {
        const bytes = await Deno.readFile(entry.path);
        await writer.add(entry.name, new Uint8ArrayReader(bytes), {
          level: 0,
        });
      }
      return await writer.close();
    },
  };
}
