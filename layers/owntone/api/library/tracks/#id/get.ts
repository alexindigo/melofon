// layers/owntone/api/library/tracks/#id/get.ts — GET
// /api/library/tracks/<id>. Non-digits → 400; unknown → 404.
import {
  albumArtistResolver,
  badRequest,
  findSongByWire,
  notFound,
  trackPayload,
} from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  if (!/^\d+$/.test(request.params.id)) return badRequest();
  const song = await findSongByWire(context.app, request.params.id);
  if (song === null) return notFound();
  const albumArtist = await albumArtistResolver(context.app)(song.albumId);
  return trackPayload(song, albumArtist);
};
