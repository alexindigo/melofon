import { fail, notFound, ok } from '#opensubsonic/envelope.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import { clientInfo } from '#opensubsonic/transcoding.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { allow: 'POST' },
    });
  }
  const id = requiredParam(context, 'mediaId');
  if (id instanceof Response) return id;
  const type = requiredParam(context, 'mediaType');
  if (type instanceof Response) return type;
  if (type !== 'song') {
    return fail(context, 0, `mediaType '${type}' is not yet supported`);
  }
  let info;
  try {
    info = clientInfo(await request.body.json());
  } catch {
    return fail(context, 0, 'invalid JSON request body');
  }
  if (!info) return fail(context, 0, 'invalid ClientInfo');
  const song = await context.app.library.getSong(id);
  if (!song) return notFound(context);
  const result = await context.app.stream.decision(
    song,
    info,
    context.state.user!.username,
  );
  if (!result) return fail(context, 0, 'Cannot inspect media stream');
  // Only the wire fields cross back out of core (selection is core-private).
  const {
    canDirectPlay,
    canTranscode,
    transcodeReason,
    errorReason,
    transcodeParams,
    sourceStream,
    transcodeStream,
  } = result;
  return ok(context, {
    transcodeDecision: {
      canDirectPlay,
      canTranscode,
      transcodeReason,
      errorReason,
      transcodeParams,
      sourceStream,
      ...(transcodeStream ? { transcodeStream } : {}),
    },
  });
};
