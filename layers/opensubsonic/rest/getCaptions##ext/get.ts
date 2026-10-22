// Pinned Endpoints/getcaptions.md: raw captions, optional preferred format.
import { fail, notFound } from '#opensubsonic/envelope.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const format = context.state.params?.get('format') ?? undefined;
  if (format !== undefined && format !== 'srt' && format !== 'vtt') {
    return fail(context, 10, 'Invalid captions format');
  }
  const [videoId, ...choice] = id.split(':');
  const result = await context.app.library.caption(videoId, {
    ...(choice.length ? { key: choice.join(':') } : {}),
    format,
  });
  if (!result) return notFound(context);
  return new Response(result.text, {
    headers: {
      'content-type': result.format === 'vtt'
        ? 'text/vtt'
        : 'application/x-subrip',
    },
  });
};
