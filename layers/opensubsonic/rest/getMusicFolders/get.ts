// layers/opensubsonic/rest/getMusicFolders/get.ts — GET /rest/getMusicFolders.
import { ok } from '#opensubsonic/envelope.ts';
import { folderWireId } from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const folders = await context.app.libraries.list();
  return ok(context, {
    musicFolders: {
      musicFolder: folders.map((f) => ({
        id: folderWireId(f.id),
        name: f.name,
      })),
    },
  });
};
