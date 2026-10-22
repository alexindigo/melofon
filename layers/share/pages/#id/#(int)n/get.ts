import { admit, leased } from '../../../streams.ts';
import { error, load, secured } from '../../../public.ts';
import type { ShareContext, ShareRequest } from '../../../types.ts';

export default async (request: ShareRequest, context: ShareContext) => {
  const share = await load(request, context);
  if (share instanceof Response) return share;
  // Typed capture cannot consume /m3u, /cover or /zip. Validate canonical raw
  // spelling before converting: the framework's int parser normalizes zeros.
  const rawIndex = new URL(request._raw.url).pathname.split('/').pop()!;
  if (!/^(0|[1-9][0-9]*)$/.test(rawIndex)) return error(404);
  const index = Number(request.params.n);
  if (!Number.isSafeInteger(index)) return error(404);
  const track = (await context.app.shares.tracks(share))[index];
  if (!track) return error(404);
  const release = await admit(context, share.id);
  if (!release) {
    const response = error(429);
    response.headers.set('Retry-After', '1');
    return response;
  }
  try {
    return secured(
      leased(
        await context.app.stream.file(request._raw, track.path),
        request._raw.signal,
        release,
      ),
    );
  } catch (err) {
    release();
    if (err instanceof Deno.errors.NotFound) return error(404);
    throw err;
  }
};
