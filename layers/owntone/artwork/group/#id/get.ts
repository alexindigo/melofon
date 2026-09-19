// layers/owntone/artwork/group/#id/get.ts — GET /artwork/group/<album wire>:
// the album's cover. app.artwork always returns an image. Non-digits → 400;
// unknown → 404.
import { badRequest, findAlbumByWire, notFound } from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  if (!/^\d+$/.test(request.params.id)) return badRequest();
  const album = await findAlbumByWire(context.app, request.params.id);
  if (album === null) return notFound();
  return await context.app.artwork.cover(album.id);
};
