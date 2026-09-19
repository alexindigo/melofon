// layers/owntone/api/library/playlists/get.ts — GET /api/library/playlists.
// Melofon playlists are per-user; OwnTone's are global — the hat reads the
// seeded cfg.user's list. Unset → empty paging.
import { paged, pagingParams, playlistPayload } from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  const paging = pagingParams(request.query);
  if (paging instanceof Response) return paging;
  const user = context.app.cfg.user;
  const playlists = user === undefined
    ? []
    : await context.app.playlists.list(user);
  return paged(playlists.map(playlistPayload), paging.offset, paging.limit);
};
