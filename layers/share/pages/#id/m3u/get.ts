import { artist, baseUrl, load, secured, title } from '../../../public.ts';
import type { ShareContext, ShareRequest } from '../../../types.ts';

export default async (request: ShareRequest, context: ShareContext) => {
  const share = await load(request, context, true);
  if (share instanceof Response) return share;
  const tracks = await context.app.shares.tracks(share);
  const base = await baseUrl(request, context);
  const lines = tracks.map((track, n) =>
    `#EXTINF:${
      track.durationMs === null ? -1 : Math.floor(track.durationMs / 1000)
    },${
      `${artist(track)} - ${title(track)}`.replace(/[\r\n]/g, ' ')
    }\n${base}/${n}`
  );
  return secured(
    new Response(`#EXTM3U\n${lines.join('\n')}\n`, {
      headers: { 'content-type': 'audio/x-mpegurl; charset=utf-8' },
    }),
  );
};
