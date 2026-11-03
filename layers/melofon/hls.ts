import { fail } from './errors.ts';
import type { HatContext, HatRequest, HlsOptions, HlsView } from './types.ts';
import { getVideo } from './video.ts';

function integer(raw: string, minimum: number): number {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum) {
    fail(400, 'invalid_field', 'Invalid HLS rendition or audio track');
  }
  return value;
}

/** Only media selection travels in links. Authentication stays in headers. */
export function hlsOptions(request: HatRequest, master = true): HlsOptions[] {
  const params = new URL(request._raw.url).searchParams;
  for (const key of params.keys()) {
    if (
      !['bitRate', 'size', 'audioTrack'].includes(key) ||
      ((key !== 'bitRate' || !master) && params.getAll(key).length !== 1)
    ) fail(400, 'invalid_field', 'Unknown or repeated HLS parameter');
  }
  const track = params.get('audioTrack');
  const audioTrack = track === null ? undefined : integer(track, 0);
  const rungs = params.getAll('bitRate');
  return (rungs.length ? rungs : [undefined]).map((raw) => {
    if (raw !== undefined && !/^\d+(?:@\d+x\d+)?$/.test(raw)) {
      fail(400, 'invalid_field', 'Invalid HLS rendition');
    }
    const [rate, embeddedSize] = raw?.split('@') ?? [];
    if (embeddedSize !== undefined && params.has('size')) {
      fail(400, 'invalid_field', 'Specify HLS dimensions only once');
    }
    const size = embeddedSize ?? params.get('size');
    let dimensions: Pick<HlsOptions, 'width' | 'height'> = {};
    if (size != null) {
      if (!/^\d+x\d+$/.test(size)) {
        fail(400, 'invalid_field', 'Invalid HLS size');
      }
      const [width, height] = size.split('x').map((n) => integer(n, 2));
      if (width % 2 || height % 2) {
        fail(400, 'invalid_field', 'HLS dimensions must be even');
      }
      dimensions = { width, height };
    }
    return {
      ...(rate === undefined ? {} : { kbps: integer(rate, 1) }),
      ...dimensions,
      ...(audioTrack === undefined ? {} : { audioTrack }),
    };
  });
}

export function hlsQuery(option: HlsOptions): string {
  const params = new URLSearchParams();
  if (option.kbps !== undefined) {
    params.set(
      'bitRate',
      `${option.kbps}${
        option.width === undefined ? '' : `@${option.width}x${option.height}`
      }`,
    );
  } else if (option.width !== undefined) {
    params.set('size', `${option.width}x${option.height}`);
  }
  if (option.audioTrack !== undefined) {
    params.set('audioTrack', String(option.audioTrack));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

export async function hlsVideo(
  context: HatContext,
  id: string,
  options: HlsOptions[],
) {
  const detail = await getVideo(context, id);
  if (
    options.some((option) =>
      option.audioTrack !== undefined &&
      !detail.details?.audio.some((track) => track.index === option.audioTrack)
    )
  ) {
    fail(400, 'invalid_field', 'Unknown video audio track');
  }
  return detail.song;
}

export async function withHls<T>(
  context: HatContext,
  path: string,
  option: HlsOptions,
  consume: (view: HlsView) => T | Promise<T>,
): Promise<T> {
  const root = context.app.cfg.dataDir;
  if (!root) fail(500, 'internal_error', 'Unable to prepare HLS video');
  const view = await context.app.media.hls(path, `${root}/hls`, option);
  if (!view) fail(500, 'internal_error', 'Unable to prepare HLS video');
  try {
    return await consume(view);
  } finally {
    await view.release();
  }
}

export async function hlsPlaylist(request: HatRequest, context: HatContext) {
  const options = hlsOptions(request);
  const song = await hlsVideo(context, request.params.id, options);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const option of options) {
    await withHls(context, song.path, option, (view) => {
      const query = hlsQuery(option);
      if (options.length > 1) {
        lines.push(
          `#EXT-X-STREAM-INF:BANDWIDTH=${view.bandwidth},RESOLUTION=${view.width}x${view.height}`,
          `hls.m3u8${query}`,
        );
      } else {
        lines.push(
          `#EXT-X-TARGETDURATION:${
            Math.ceil(Math.max(...view.segments.map((s) => s.duration)))
          }`,
          '#EXT-X-MEDIA-SEQUENCE:0',
          `#EXT-X-PLAYLIST-TYPE:${view.complete ? 'VOD' : 'EVENT'}`,
        );
        for (const [index, segment] of view.segments.entries()) {
          lines.push(
            `#EXTINF:${segment.duration},`,
            `hls/segments/${index}.ts${query}`,
          );
        }
        if (view.complete) lines.push('#EXT-X-ENDLIST');
      }
    });
  }
  return new Response(lines.join('\n') + '\n', {
    headers: {
      'content-type': 'application/vnd.apple.mpegurl',
      'cache-control': 'no-store',
    },
  });
}

export async function hlsSegment(request: HatRequest, context: HatContext) {
  const options = hlsOptions(request, false);
  const index = integer(request.params.index, 0);
  const song = await hlsVideo(context, request.params.id, options);
  return withHls(context, song.path, options[0], async (view) => {
    const body = await view.segment(index);
    if (!body) fail(404, 'not_found', 'HLS segment not found');
    return new Response(body, {
      headers: { 'content-type': 'video/MP2T', 'cache-control': 'no-store' },
    });
  });
}
