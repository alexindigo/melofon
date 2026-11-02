import { intParam } from '#opensubsonic/params.ts';
import { mediaReadRequest } from '#opensubsonic/media-request.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  const params = context.state.params!;
  const id = params.get('mediaId');
  const type = params.get('mediaType');
  const token = params.get('transcodeParams');
  if (!id || type !== 'song' || !token) {
    return new Response('Missing or unsupported media parameters', {
      status: 400,
    });
  }
  const song = await context.app.library.getSong(id);
  if (!song) return new Response('Media not found', { status: 404 });
  return context.app.stream.negotiated(
    mediaReadRequest(request),
    song,
    token,
    context.state.user!.username,
    intParam(params, 'offset', 0),
  );
};
