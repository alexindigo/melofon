// Native manifest indexes select segments; the cache lease covers the response
// through EOF/cancellation. No route reads or mutates the cache filesystem.
import { fail, notFound } from '#opensubsonic/envelope.ts';
import { integerParam, requiredParam } from '#opensubsonic/params.ts';
import { hlsCore, hlsFailure, hlsOptions } from '#opensubsonic/hls.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const params = context.state.params!;
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const song = await context.app.library.getSong(id);
  if (!song?.isVideo) return notFound(context);
  const segmentIndex = integerParam(params.get('segmentIndex'));
  if (segmentIndex === null || segmentIndex < 0) {
    return fail(context, 10, 'segmentIndex must be a non-negative integer');
  }
  const option = hlsOptions(
    context,
    params.get('bitRate') ?? params.get('maxBitRate') ?? undefined,
  );
  if (option instanceof Response) return option;
  const root = context.app.cfg.dataDir;
  if (!root) return hlsFailure(context);
  const view = await hlsCore(
    context,
    () => context.app.media.hls(song.path, `${root}/hls`, option),
  );
  if (view instanceof Response) return view;
  if (!view) return hlsFailure(context);
  try {
    const stream = await view.segment(segmentIndex);
    return stream
      ? new Response(stream, { headers: { 'content-type': 'video/MP2T' } })
      : new Response(null, { status: 404 });
  } finally {
    await view.release();
  }
};
