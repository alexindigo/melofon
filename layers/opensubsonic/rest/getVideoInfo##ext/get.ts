// layers/opensubsonic/rest/getVideoInfo/get.ts — GET /rest/getVideoInfo.
// Pinned getvideoinfo.md; Subsonic 1.16.1 XSD VideoInfo/Captions/AudioTrack.
import { notFound, ok } from '#opensubsonic/envelope.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const video = await context.app.library.getSong(id);
  if (video === null || !video.isVideo) return notFound(context);
  const details = await context.app.library.videoDetails(id);
  return ok(context, {
    videoInfo: {
      id: video.id,
      captions: (details?.captions ?? []).map((c) => ({
        id: `${id}:${c.key}`,
        name: c.name,
      })),
      audioTrack: (details?.audio ?? []).map((a) => ({
        id: String(a.index),
        ...(a.title || a.language || a.codec
          ? { name: a.title || a.language || a.codec }
          : {}),
        ...(a.language ? { languageCode: a.language } : {}),
      })),
    },
  });
};
