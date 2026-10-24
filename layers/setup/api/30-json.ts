import type { SetupContext, SetupRequest } from '../types.ts';
import { fail } from '../errors.ts';

export const disableStreaming = true;
export default async function (request: SetupRequest, context: SetupContext) {
  if (
    context.miss !== undefined ||
    !['POST', 'PUT', 'PATCH'].includes(request.method)
  ) return;
  const max = Number(await context.app.state.getTyped('setup.jsonMaxBytes'));
  const length = request.headers.get('content-length');
  if (length !== null && Number(length) > max) {
    fail(413, 'too_large', 'Request body is too large');
  }
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
      'application/json'
  ) {
    fail(
      415,
      'unsupported_media_type',
      'Content-Type must be application/json',
    );
  }
  let size = 0;
  request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > max) fail(413, 'too_large', 'Request body is too large');
        controller.enqueue(chunk);
      },
    }),
  );
  const bytes = await request.body.bytes();
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
  } catch {
    fail(400, 'not_json', 'Body must be a JSON object');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail(400, 'not_json', 'Body must be a JSON object');
  }
  context.state.json = parsed as Record<string, unknown>;
}
