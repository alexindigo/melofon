import { cleanName, error, load, secured } from '../../../public.ts';
import type { ShareContext, ShareRequest } from '../../../types.ts';

export default async (request: ShareRequest, context: ShareContext) => {
  const share = await load(request, context);
  if (share instanceof Response) return share;
  if (!share.downloadable) return error(403);
  const visited = await load(request, context, true);
  if (visited instanceof Response) return visited;
  const tracks = await context.app.shares.tracks(visited);
  const blob = await context.app.zip.archive(tracks.map((track, n) => ({
    name: `${String(n + 1).padStart(2, '0')} - ${
      cleanName(track.path.split('/').pop() ?? track.fileName)
    }`,
    path: track.path,
  })));
  return secured(
    new Response(blob, {
      headers: {
        'content-type': 'application/zip',
        'content-length': String(blob.size),
        'content-disposition': `attachment; filename="${
          cleanName(visited.description || visited.id).replace(
            /[^\x20-\x7e]/g,
            '_',
          )
        }.zip"; filename*=UTF-8''${
          encodeURIComponent(cleanName(visited.description || visited.id))
            .replaceAll("'", '%27')
        }.zip`,
      },
    }),
  );
};
