import { fail } from '#opensubsonic/envelope.ts';
import { integerParam } from '#opensubsonic/params.ts';
import type { HatContext } from '#opensubsonic/types.ts';

export interface HlsOptions {
  kbps?: number;
  width?: number;
  height?: number;
  audioTrack?: number;
}
export function hlsOptions(
  context: HatContext,
  raw?: string,
): HlsOptions | Response {
  const params = context.state.params!;
  const parts = raw?.split('@');
  const kbps = parts ? integerParam(parts[0]) : undefined;
  const size = parts?.[1] ?? params.get('size');
  const dimensions = size?.split('x');
  const width = dimensions ? integerParam(dimensions[0]) : undefined;
  const height = dimensions ? integerParam(dimensions[1]) : undefined;
  const track = params.get('audioTrack');
  const audioTrack = track === null ? undefined : integerParam(track);
  if (
    (raw !== undefined &&
      (!/^\d+(?:@\d+x\d+)?$/.test(raw) || !kbps || kbps < 0)) ||
    (size != null &&
      (!/^\d+x\d+$/.test(size) || !width || !height || width < 2 ||
        height < 2 || width % 2 || height % 2)) ||
    audioTrack === null || (audioTrack !== undefined && audioTrack < 0)
  ) {
    return fail(context, 10, 'Invalid HLS rendition or audio track');
  }
  return {
    ...(kbps !== undefined ? { kbps: kbps! } : {}),
    ...(width !== undefined ? { width: width!, height: height! } : {}),
    ...(audioTrack !== undefined ? { audioTrack } : {}),
  };
}
export function hlsFailure(context: HatContext): Response {
  return fail(
    {
      ...context,
      state: {
        ...context.state,
        operation: 'hls.m3u8',
        format: { type: 'xml' },
      },
    },
    0,
    'Unable to prepare HLS video',
  );
}
/** Pinned Endpoints/hls.md:28 requires XML even with f=json. Navidrome
 * 18205366 server/subsonic/api.go:302-303 maps invalid parameters to code 0. */
export async function hlsCore<T>(
  context: HatContext,
  operation: () => Promise<T>,
): Promise<T | Response> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'HlsError') throw error;
    return hlsFailure(context);
  }
}
export function hlsQuery(params: URLSearchParams, options: HlsOptions): string {
  const q = new URLSearchParams();
  for (const key of ['u', 'p', 't', 's', 'v', 'c']) {
    const value = params.get(key);
    if (value !== null) q.set(key, value);
  }
  if (options.kbps !== undefined) {
    q.set(
      'bitRate',
      `${options.kbps}${
        options.width === undefined ? '' : `@${options.width}x${options.height}`
      }`,
    );
  } else if (options.width !== undefined) {
    q.set('size', `${options.width}x${options.height}`);
  }
  if (options.audioTrack !== undefined) {
    q.set('audioTrack', String(options.audioTrack));
  }
  return q.toString();
}
