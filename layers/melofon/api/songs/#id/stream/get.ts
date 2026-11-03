import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core, fail } from '#melofon/errors.ts';
import { streamOptions } from '#melofon/stream.ts';

export default async function (request: HatRequest, context: HatContext) {
  const options = streamOptions(request);
  const song = await context.app.library.getSong(request.params.id);
  if (!song) fail(404, 'not_found', 'Song not found');
  return core(() =>
    context.app.stream.session(
      request._raw,
      song,
      context.state.user.id,
      context.state.sessionId,
      options,
    )
  );
}
