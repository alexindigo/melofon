// layers/opensubsonic/rest/getCoverArt/get.ts — GET /rest/getCoverArt.
// Navidrome server/subsonic/media_retrieval.go:65-76: size=0 is original;
// an unknown entity is error 70, distinct from a known entity without art.
import { intParam, requiredParam } from '#opensubsonic/params.ts';
import { notFound } from '#opensubsonic/envelope.ts';
import { resolveArtist } from '#opensubsonic/id3.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const result = await context.app.artwork.get(id, {
    size: intParam(context.state.params!, 'size', 0),
    username: context.state.user!.username,
  });
  if (result.kind !== 'unknown') return result.response;
  // The hat owns derived artists (Various/Unknown), including their existence.
  // Resolve through the same owner as browse/info/download, never duplicate ids
  // or teach core about a protocol-only identity.
  return await resolveArtist(context, id) !== null
    ? context.app.artwork.placeholder()
    : notFound(context);
};
