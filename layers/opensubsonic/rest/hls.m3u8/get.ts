// Pinned OpenSubsonic Endpoints/hls.md:18-20,28: repeatable bitrate/size,
// audioTrack, mpegurl success and XML preparation errors. Core owns outputs.
import { notFound } from '#opensubsonic/envelope.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import { hlsFailure, hlsOptions, hlsQuery } from '#opensubsonic/hls.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const params = context.state.params!;
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const song = await context.app.library.getSong(id);
  if (!song?.isVideo) return notFound(context);
  const rungs = [...params.getAll('bitRate'), ...params.getAll('maxBitRate')];
  const options = [];
  for (const raw of rungs.length ? rungs : [undefined]) {
    const option = hlsOptions(context, raw);
    if (option instanceof Response) return option;
    // Retain the explicit digit-syntax conversion boundary used by this hat.
    if (raw !== undefined) option.kbps = Number(raw.split('@')[0]);
    options.push(option);
  }
  const root = context.app.cfg.dataDir;
  if (!root) return hlsFailure(context);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const option of options) {
    const view = await context.app.media.hls(song.path, `${root}/hls`, option);
    if (!view) return hlsFailure(context);
    try {
      const query = `id=${encodeURIComponent(id)}&${hlsQuery(params, option)}`;
      if (options.length > 1) {
        lines.push(
          `#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=${view.bandwidth},RESOLUTION=${view.width}x${view.height}`,
        );
        lines.push(`/rest/hls.m3u8?${query}`);
      } else {
        lines.push(
          `#EXT-X-TARGETDURATION:${
            Math.ceil(Math.max(...view.segments.map((s) => s.duration)))
          }`,
        );
        lines.push('#EXT-X-MEDIA-SEQUENCE:0');
        lines.push(`#EXT-X-PLAYLIST-TYPE:${view.complete ? 'VOD' : 'EVENT'}`);
        for (const [index, segment] of view.segments.entries()) {
          lines.push(`#EXTINF:${segment.duration},`);
          lines.push(
            `/rest/hls/segment.ts?${query}&segmentIndex=${index}&duration=${segment.duration}`,
          );
        }
        if (view.complete) lines.push('#EXT-X-ENDLIST');
      }
    } finally {
      await view.release();
    }
  }
  return new Response(lines.join('\n') + '\n', {
    headers: {
      'content-type': 'application/vnd.apple.mpegurl',
      'cache-control': 'no-store',
    },
  });
};
