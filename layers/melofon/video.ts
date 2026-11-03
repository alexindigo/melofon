import { browseQuery } from './browse.ts';
import { videoFacts } from './browse-payloads.ts';
import { core, fail } from './errors.ts';
import type { HatContext, HatRequest } from './types.ts';

export async function getVideo(context: HatContext, id: string) {
  const { detail } = await core(() => context.app.library.getVideoSnapshot(id));
  if (!detail) fail(404, 'not_found', 'Video not found');
  return detail;
}

export async function videoPlayback(request: HatRequest, context: HatContext) {
  browseQuery(request);
  const detail = await getVideo(context, request.params.id);
  const facts = videoFacts(detail.details);
  return Response.json({
    audioTracks: facts?.audio ?? [],
    captions: (facts?.captions ?? []).map((caption) => ({
      ...caption,
      href: `captions?${new URLSearchParams({
        key: caption.key,
        format: 'vtt',
      })}`,
    })),
    hls: 'hls.m3u8',
  }, { headers: { 'cache-control': 'no-store' } });
}

export async function videoCaption(request: HatRequest, context: HatContext) {
  const params = browseQuery(request, ['key', 'format']);
  const key = params.get('key');
  const format = params.get('format') ?? 'vtt';
  if (!key || (format !== 'vtt' && format !== 'srt')) {
    fail(
      400,
      'invalid_field',
      'A caption key and VTT or SRT format are required',
    );
  }
  const caption = await core(() =>
    context.app.library.caption(
      request.params.id,
      { key, format },
    )
  );
  if (!caption) fail(404, 'not_found', 'Caption not found');
  return new Response(caption.text, {
    headers: {
      'content-type': format === 'vtt'
        ? 'text/vtt; charset=utf-8'
        : 'application/x-subrip; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
