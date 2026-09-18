// layers/opensubsonic/rest/getVideos/get.ts — GET /rest/getVideos.
// M4: music videos are files rows with isVideo — same id namespace as
// songs, so any client can resolve the same id. No hls (plan §8).
import { ok } from '#opensubsonic/envelope.ts';
import { childOf } from '#opensubsonic/id3.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const videos = await context.app.library.videos();
  return ok(context, { videos: { video: videos.map(childOf) } });
};
