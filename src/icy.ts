/** Facts from one ICY block. Absent fields leave the current fact unchanged;
 * an explicitly empty StreamTitle clears it. Interpretation belongs to hats. */
export interface IcyMetadata {
  streamTitle?: string;
  streamUrl?: string;
}

/** Wire limit: one unsigned length byte in units of 16 bytes. Not a setting. */
export const ICY_MAX_METADATA_BYTES = 255 * 16;

export class IcyFramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IcyFramingError';
  }
}

/** Missing metaint means ordinary audio; malformed advertised framing is not
 * silently passed to a decoder as audio. No allocation depends on this value. */
export function icyInterval(headers: Headers): number | null {
  const value = headers.get('icy-metaint');
  if (value === null) return null;
  const interval = Number(value);
  if (
    !/^\d+$/.test(value) || !Number.isSafeInteger(interval) || interval <= 0
  ) {
    throw new IcyFramingError(
      'Invalid icy-metaint: expected a positive safe integer',
    );
  }
  return interval;
}

function metadata(bytes: Uint8Array): IcyMetadata {
  const end = bytes.indexOf(0);
  const payload = end < 0 ? bytes : bytes.subarray(0, end);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    // ISO-8859-1 fallback, byte for code point (not WHATWG windows-1252).
    text = Array.from(payload, (byte) => String.fromCharCode(byte)).join('');
  }
  const result: IcyMetadata = {};
  // Consume unknown fields too, so their quoted contents cannot become facts.
  // A quote inside a value is allowed unless followed by the field delimiter.
  for (
    const field of text.matchAll(
      /(?:^|;)\s*([a-z][a-z0-9]*)='([\s\S]*?)'\s*(?=;|$)/gi,
    )
  ) {
    const key = field[1].toLowerCase();
    if (key === 'streamtitle') result.streamTitle = field[2];
    else if (key === 'streamurl') result.streamUrl = field[2];
  }
  return result;
}

/** Pull-only byte deinterleaver. The caller opens through the net owner with
 * Icy-MetaData: 1 and Accept-Encoding: identity, and retains its response lease.
 * This stream owns the body reader: EOF, failure and cancellation release it.
 * It retains one upstream chunk and at most 4080 metadata bytes, never audio
 * history or an interval-sized buffer. No metadata-only queue or prefetch. */
export function separateIcy(
  body: ReadableStream<Uint8Array>,
  headers: Headers,
  onMetadata: (facts: IcyMetadata) => void,
): ReadableStream<Uint8Array> {
  const interval = icyInterval(headers);
  if (interval === null) return body;
  const reader = body.getReader();
  let chunk: Uint8Array = new Uint8Array(0);
  let offset = 0;
  let audioRemaining = interval;
  let block: Uint8Array | undefined;
  let used = 0;
  let finished = false;
  let closing: Promise<void> | undefined;
  const close = (reason?: unknown) => {
    if (closing) return closing;
    finished = true;
    chunk = new Uint8Array(0);
    block = undefined;
    closing = (async () => {
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    })();
    return closing;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!finished) {
          if (offset === chunk.length) {
            const part = await reader.read();
            if (finished) return;
            if (part.done) {
              if (block || audioRemaining === 0) {
                throw new IcyFramingError('Truncated ICY metadata framing');
              }
              await close();
              controller.close();
              return;
            }
            chunk = part.value;
            offset = 0;
            if (chunk.length === 0) continue;
          }
          if (audioRemaining > 0) {
            const size = Math.min(audioRemaining, chunk.length - offset);
            const audio = chunk.subarray(offset, offset + size);
            offset += size;
            audioRemaining -= size;
            controller.enqueue(audio);
            return;
          }
          if (!block) {
            const size = chunk[offset++] * 16;
            if (size === 0) {
              audioRemaining = interval;
              continue;
            }
            block = new Uint8Array(size);
            used = 0;
          }
          const size = Math.min(block.length - used, chunk.length - offset);
          block.set(chunk.subarray(offset, offset + size), used);
          offset += size;
          used += size;
          if (used === block.length) {
            const facts = metadata(block);
            block = undefined;
            audioRemaining = interval;
            if (
              facts.streamTitle !== undefined || facts.streamUrl !== undefined
            ) {
              onMetadata(facts);
            }
          }
        }
      } catch (error) {
        if (finished) return;
        controller.error(error);
        try {
          await close(error);
        } catch { /* Keep the framing, callback or upstream error. */ }
      }
    },
    cancel: close,
  }, { highWaterMark: 0 });
}
