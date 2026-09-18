// layers/owntone/api/library/albums/#id/get.ts — GET /api/library/albums/<id>.
// Non-digits → 400 (OwnTone's regex only routes digits); unknown → 404.
import {
  albumPayload,
  badRequest,
  findAlbumByWire,
  notFound,
} from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  if (!/^\d+$/.test(request.params.id)) return badRequest();
  const album = await findAlbumByWire(context.app, request.params.id);
  return album === null ? notFound() : albumPayload(album);
};
