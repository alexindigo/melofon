// layers/opensubsonic/rest/stream/get.ts — GET /rest/stream.
// app.stream decides (M4): DirectPlay = original bytes, Range-aware;
// ExtractAudio = a video id + an audio `format` → in-process audio track.
// Not a scrobble — playing does not mark anything.
import { fail, notFound } from '#opensubsonic/envelope.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const song = await context.app.library.getSong(id);
  if (song === null) return notFound(context);
  const res = await context.app.stream.play(
    request._raw,
    { path: song.path, isVideo: song.isVideo },
    context.state.params!.get('format') ?? undefined,
  );
  if (res === null) {
    return fail(context, 0, 'audio extraction failed');
  }
  return res;
};
