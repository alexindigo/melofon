import type { HatContext, HatRequest } from '#melofon/types.ts';
import { fail } from '#melofon/errors.ts';
import { artworkUrl } from '#melofon/artwork.ts';

export const disableStreaming = true;

export default async function (request: HatRequest, context: HatContext) {
  const max = await context.app.radio.artworkMaxBytes();
  const length = request.headers.get('content-length');
  if (length !== null && Number(length) > max) {
    fail(413, 'too_large', 'Artwork is too large');
  }
  // Count before buffering, including chunked bodies without Content-Length.
  let size = 0;
  request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > max) fail(413, 'too_large', 'Artwork is too large');
        controller.enqueue(chunk);
      },
    }),
  );
  const result = await context.app.radio.putArtwork(
    request.params.id,
    await request.body.bytes(),
  );
  if (!result) fail(404, 'not_found', 'Station not found');
  if ('invalid' in result) {
    fail(
      result.invalid === 'too_large' ? 413 : 400,
      result.invalid,
      'Invalid artwork',
    );
  }
  const ref = { kind: 'radio' as const, id: request.params.id };
  const image = await context.app.artwork.describe(ref);
  return {
    artwork: image.kind === 'image'
      ? {
        ...image.descriptor,
        url: artworkUrl(
          ref,
          image.descriptor.version,
          await context.app.publicAddress.prefix(),
        ),
      }
      : null,
  };
}
