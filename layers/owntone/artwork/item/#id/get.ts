// layers/owntone/artwork/item/#id/get.ts — GET /artwork/item/<track wire>:
// A song's embedded picture precedes its album (ARCHITECTURE §5 rule 8).
// Non-digits → 400; unknown → 404. maxwidth/maxheight are not negotiated here.
import { badRequest, findSongByWire, notFound } from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  if (!/^\d+$/.test(request.params.id)) return badRequest();
  const song = await findSongByWire(context.app, request.params.id);
  if (song === null) return notFound();
  return await context.app.artwork.cover(
    song.pictureHash ? song.id : song.albumId ?? song.id,
  );
};
