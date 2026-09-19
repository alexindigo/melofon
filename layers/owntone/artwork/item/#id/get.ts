// layers/owntone/artwork/item/#id/get.ts — GET /artwork/item/<track wire>:
// the track's cover (its album's, like OwnTone). app.artwork always returns
// an image. Non-digits → 400; unknown → 404. maxwidth/maxheight ignored (no
// rescaling, same as OpenSubsonic's size).
import { badRequest, findSongByWire, notFound } from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  if (!/^\d+$/.test(request.params.id)) return badRequest();
  const song = await findSongByWire(context.app, request.params.id);
  if (song === null) return notFound();
  return await context.app.artwork.cover(song.albumId ?? song.id);
};
