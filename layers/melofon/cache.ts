import type { HatRequest } from './types.ts';

/** HTTP weak comparison, including lists and commas inside opaque tags. A
 * malformed field is ignored; it cannot turn an authorized read into a 304. */
function matches(field: string | null, etag: string): boolean {
  if (field === null) return false;
  if (field.trim() === '*') return true;
  const tag = '(?:W/)?"[\\x21\\x23-\\x7e\\x80-\\xff]*"';
  if (!new RegExp(`^\\s*${tag}(?:\\s*,\\s*${tag})*\\s*$`).test(field)) {
    return false;
  }
  return [...field.matchAll(new RegExp(tag, 'g'))].some((match) =>
    match[0].replace(/^W\//, '') === etag.replace(/^W\//, '')
  );
}

/** Call only after authentication, query validation and resource resolution.
 * The representation key includes its version and canonical query inputs.
 * Only catalog facts belong here: no sidecars, personal or lazy artwork facts. */
export async function catalogResponse(
  request: HatRequest,
  revision: string,
  representation: unknown,
  body: unknown,
): Promise<Response> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([revision, representation])),
  );
  const hash = Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  const etag = `W/"${hash}"`;
  const headers = { ETag: etag, 'Cache-Control': 'private, no-cache' };
  return matches(request._raw.headers.get('If-None-Match'), etag)
    ? new Response(null, { status: 304, headers })
    : Response.json(body, { headers });
}
