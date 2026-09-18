// layers/opensubsonic/rest/getVideoInfo/get.ts — GET /rest/getVideoInfo.
// Minimal videoInfo: the id only — no captions/audioTrack/conversion
// lists (those exist for Subsonic's own player; M4 ships none).
import { notFound, ok } from '#opensubsonic/envelope.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const video = await context.app.library.getSong(id);
  if (video === null || !video.isVideo) return notFound(context);
  return ok(context, { videoInfo: { id: video.id } });
};
