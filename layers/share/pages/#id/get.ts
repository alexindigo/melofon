import {
  album,
  artist,
  baseUrl,
  escape,
  load,
  secured,
  title,
} from '../../public.ts';
import type { ShareContext, ShareRequest } from '../../types.ts';

export default async (request: ShareRequest, context: ShareContext) => {
  const share = await load(request, context, true);
  if (share instanceof Response) return share;
  const tracks = await context.app.shares.tracks(share);
  const base = escape(await baseUrl(request, context));
  const name = share.description || tracks.map(title).join(', ') ||
    'Shared music';
  const rows = tracks.map((track, n) => {
    const seconds = track.durationMs === null
      ? null
      : Math.floor(track.durationMs / 1000);
    const duration = seconds === null
      ? ''
      : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    return `<li><p>${escape(title(track))} — ${escape(artist(track))} — ${
      escape(album(track))
    } ${duration}</p><audio controls preload="none" src="${base}/${n}"></audio></li>`;
  }).join('\n');
  return secured(
    new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${
        escape(name)
      }</title></head><body><main><h1>${
        escape(name)
      }</h1><img src="${base}/cover" alt="Share cover"><p><a href="${base}/m3u">M3U playlist</a>${
        share.downloadable ? ` · <a href="${base}/zip">Download ZIP</a>` : ''
      }</p><ol>${rows}</ol></main></body></html>`,
      {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      },
    ),
  );
};
