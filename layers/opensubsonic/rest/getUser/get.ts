// layers/opensubsonic/rest/getUser/get.ts — GET /rest/getUser.
// Navidrome quirk: the authenticated user, not a directory lookup.
// folder is the wire ints of every source (same values as getMusicFolders)
// — every user gets every source until per-user access exists; empty
// sources → empty folder, never a synthetic 0.
import { ok } from '#opensubsonic/envelope.ts';
import { folderWireId } from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const folders = await context.app.libraries.list();
  return ok(context, {
    user: {
      username: context.state.user!.username,
      scrobblingEnabled: true,
      adminRole: true,
      settingsRole: true,
      downloadRole: true,
      uploadRole: false,
      playlistRole: true,
      coverArtRole: true,
      commentRole: false,
      podcastRole: false,
      streamRole: true,
      jukeboxRole: false,
      shareRole: false,
      videoConversionRole: false,
      folder: folders.map((f) => folderWireId(f.id)),
    },
  });
};
