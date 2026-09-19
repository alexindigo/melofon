// layers/owntone/api/library/playlists/#id/get.ts — GET
// /api/library/playlists/<id>. Non-digits → 400; unknown → 404.
import {
  badRequest,
  findPlaylistByWire,
  notFound,
  playlistPayload,
} from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  if (!/^\d+$/.test(request.params.id)) return badRequest();
  const playlist = await findPlaylistByWire(context.app, request.params.id);
  return playlist === null ? notFound() : playlistPayload(playlist);
};
