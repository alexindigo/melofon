// layers/owntone/api/library/artists/#id/get.ts — GET
// /api/library/artists/<id>. Non-digits → 400; unknown → 404.
import {
  artistPayload,
  badRequest,
  findArtistByWire,
  notFound,
} from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  if (!/^\d+$/.test(request.params.id)) return badRequest();
  const artist = await findArtistByWire(context.app, request.params.id);
  return artist === null ? notFound() : artistPayload(context.app, artist);
};
