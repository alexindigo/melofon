import type { ArtworkRef, HatContext, HatRequest } from './types.ts';
import { browseInteger, browseQuery } from './browse.ts';
import { matches } from './cache.ts';
import { fail } from './errors.ts';

/** Typed native ids keep entity namespaces separate from legacy hat aliases. */
export function artworkUrl(
  ref: ArtworkRef,
  version: string,
  prefix = '',
  size?: number,
): string {
  const query = new URLSearchParams({ v: version });
  if (size !== undefined) query.set('size', String(size));
  return `${prefix}/api/v1/artwork/${
    encodeURIComponent(`${ref.kind}:${ref.id}`)
  }?${query}`;
}

function artworkRef(id: string): ArtworkRef {
  const colon = id.indexOf(':');
  const kind = id.slice(0, colon);
  if (
    colon < 1 || !id.slice(colon + 1) ||
    !['song', 'album', 'artist', 'playlist', 'podcast'].includes(kind)
  ) fail(400, 'invalid_field', 'Invalid artwork id');
  return { kind: kind as ArtworkRef['kind'], id: id.slice(colon + 1) };
}

export async function artworkResponse(
  request: HatRequest,
  context: HatContext,
) {
  const params = browseQuery(request, ['size', 'v']);
  const ref = artworkRef(request.params.id);
  const size = browseInteger(params, 'size', 0, 0);
  // Core authorizes and binds the descriptor to the actual rendition before any
  // validator or body can be returned, including a populated playlist cache.
  const result = await context.app.artwork.get(ref, {
    size,
    username: context.state.user.username,
  });
  if (result.kind === 'unknown') fail(404, 'not_found', 'Artwork not found');
  if (result.kind === 'placeholder') {
    result.response.headers.set('Cache-Control', 'no-store');
    return result.response;
  }
  const bytes = await result.response.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const etag = `"${
    Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0'))
      .join('')
  }"`;
  const headers = new Headers(result.response.headers);
  headers.set('ETag', etag);
  headers.set(
    'Cache-Control',
    params.get('v') === result.descriptor.version &&
      result.rendition !== 'fallback'
      ? 'private, max-age=31536000, immutable'
      : 'private, no-cache',
  );
  // Authenticated images, including private playlists, never cross logins or a
  // shared cache. The URL version describes source + rendition policy, not size.
  headers.set('Vary', 'Cookie, Authorization');
  return matches(request._raw.headers.get('If-None-Match'), etag)
    ? new Response(null, { status: 304, headers })
    : new Response(bytes, { headers });
}
