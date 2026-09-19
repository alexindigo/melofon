// layers/owntone/api/library/playlists/#id/tracks/get.ts — GET
// /api/library/playlists/<id>/tracks (paged track objects, playlist order).
import {
  albumArtistResolver,
  badRequest,
  findPlaylistByWire,
  notFound,
  paged,
  pagingParams,
  trackPayload,
} from '#owntone/payloads.ts';
import type { HatContext, HatRequest, SongRow } from '#owntone/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  if (!/^\d+$/.test(request.params.id)) return badRequest();
  const user = context.app.cfg.user;
  if (user === undefined) return notFound();
  const playlist = await findPlaylistByWire(context.app, request.params.id);
  if (playlist === null) return notFound();
  const full = await context.app.playlists.get(user, playlist.id);
  if (full === null) return notFound();
  const paging = pagingParams(request.query);
  if (paging instanceof Response) return paging;
  const albumArtist = albumArtistResolver(context.app);
  const songs = (
    await Promise.all(
      full.trackIds.map((id) => context.app.library.getSong(id)),
    )
  ).filter((s): s is SongRow => s !== null);
  const items = await Promise.all(
    songs.map(async (s) => trackPayload(s, await albumArtist(s.albumId))),
  );
  return paged(items, paging.offset, paging.limit);
};
