// A bounded music-metadata input. Declared tag lengths are checked before a
// payload allocation/read; ignored audio and pictures need no buffered copy.
import { parseFromTokenizer } from 'music-metadata';

type Tokenizer = Parameters<typeof parseFromTokenizer>[0];
type Token<T> = { len: number; get(bytes: Uint8Array, offset: number): T };

export async function lyricsMetadata(path: string, maxBytes: number) {
  return await boundedMetadata(path, maxBytes, {
    duration: false,
    skipCovers: true,
    skipPostHeaders: true,
  });
}

// Shared input boundary; the caller chooses whether pictures/post-tags matter.
export async function boundedMetadata(
  path: string,
  maxBytes: number,
  options: Parameters<typeof parseFromTokenizer>[1],
) {
  using file = await Deno.open(path, { read: true });
  const stat = await file.stat();
  let position = 0;
  let remaining = maxBytes;
  const read = async (length: number, at: number, mayBeLess = false) => {
    // Never read an oversized declared tag, even its prefix. The cumulative
    // budget also bounds packetized/multi-part comment blocks.
    if (!Number.isSafeInteger(length) || length < 0 || length > remaining) {
      throw new Error('Metadata exceeds read budget');
    }
    const available = Math.min(length, Math.max(0, stat.size - at));
    if (!mayBeLess && available !== length) {
      throw new Error('Truncated metadata');
    }
    const bytes = new Uint8Array(available);
    remaining -= available;
    await file.seek(at, Deno.SeekMode.Start);
    let offset = 0;
    while (offset < bytes.length) {
      const count = await file.read(bytes.subarray(offset));
      if (count === null) throw new Error('Truncated metadata');
      offset += count;
    }
    return bytes;
  };
  const tokenizer: Tokenizer & { setPosition(at: number): void } = {
    fileInfo: { path, size: stat.size },
    get position() {
      return position;
    },
    setPosition(at) {
      position = at;
    },
    supportsRandomAccess: () => true,
    async peekBuffer(buffer, options = {}) {
      const bytes = await read(
        options.length ?? buffer.length,
        options.position ?? position,
        options.mayBeLess,
      );
      buffer.set(bytes);
      return bytes.length;
    },
    async readBuffer(buffer, options = {}) {
      const length = await this.peekBuffer(buffer, options);
      position = (options.position ?? position) + length;
      return length;
    },
    async peekToken<T>(
      token: Token<T>,
      at?: number | null,
      mayBeLess?: boolean,
    ): Promise<T> {
      return token.get(await read(token.len, at ?? position, mayBeLess), 0);
    },
    async readToken<T>(token: Token<T>, at?: number): Promise<T> {
      const start = at ?? position;
      const bytes = await read(token.len, start);
      position = start + token.len;
      return token.get(bytes, 0);
    },
    peekNumber(token) {
      return this.peekToken(token);
    },
    readNumber(token) {
      return this.readToken(token);
    },
    ignore(length) {
      const skipped = Math.min(length, Math.max(0, stat.size - position));
      position += skipped;
      return Promise.resolve(skipped);
    },
    close: () => Promise.resolve(),
    abort: () => Promise.resolve(),
  };
  return await parseFromTokenizer(tokenizer, options);
}
