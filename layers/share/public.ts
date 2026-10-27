import type { ShareContext, ShareRequest, Track } from './types.ts';

export const security = {
  'Content-Security-Policy':
    "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};
export function secured(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(security)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}
export const error = (status: number) =>
  secured(
    new Response(
      `${
        ({
          404: 'Share not found',
          410: 'Share not available anymore',
          403: 'This share is not downloadable',
          429: 'Too many concurrent streams',
        } as Record<number, string>)[status]
      }\n`,
      { status, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    ),
  );
export async function load(
  request: ShareRequest,
  context: ShareContext,
  visit = false,
) {
  if (!/^[0-9A-Za-z]{10}$/.test(request.params.id)) return error(404);
  if (!await context.app.shares.enabled()) return error(404);
  const row = await context.app.shares[visit ? 'open' : 'resolve'](
    request.params.id,
  );
  return row === 'expired' ? error(410) : row ?? error(404);
}
export const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
export const title = (track: Track) =>
  track.title ?? `[${track.fileName.replaceAll('_', ' ')}]`;
export const album = (track: Track) =>
  track.albumName ?? `[${track.albumFolderName ?? 'Unknown Album'}]`;
export const artist = (track: Track) => track.artistName ?? '[Unknown Artist]';
export const cleanName = (name: string) =>
  name.replace(/[\p{Cc}/\\:"<>|?*,]/gu, '_').replace(/^\.+$/, '_') ||
  'share';
export async function baseUrl(request: ShareRequest, context: ShareContext) {
  const base = await context.app.shares.publicUrl();
  const path = `/share/${encodeURIComponent(request.params.id)}`;
  return base
    ? `${base}${path}`
    : context.app.publicAddress.full(request._raw, path);
}
