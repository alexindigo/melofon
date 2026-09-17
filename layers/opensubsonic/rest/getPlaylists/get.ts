// layers/opensubsonic/rest/getPlaylists/get.ts — GET /rest/getPlaylists.
// Navidrome quirk: the `username` param is ignored — always the caller's.
import { ok } from '#opensubsonic/envelope.ts';
import { playlistOf } from '#opensubsonic/id3.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const username = context.state.user!.username;
  const rows = await context.app.playlists.list(username);
  return ok(context, {
    playlists: { playlist: rows.map((p) => playlistOf(p, username)) },
  });
};
