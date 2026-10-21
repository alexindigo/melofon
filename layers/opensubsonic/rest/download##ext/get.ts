// layers/opensubsonic/rest/download/get.ts — GET /rest/download.
// Song id → the single file (unchanged). Album / artist / playlist id →
// a zip of its songs (Navidrome shape), entries named by the simulated
// tree path. Missing id → code 70.
import { notFound } from '#opensubsonic/envelope.ts';
import { zipEntriesFor } from '#opensubsonic/id3.ts';
import { mediaReadRequest } from '#opensubsonic/media-request.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const source = await context.app.stream.source(id);
  if (source !== null) {
    const { path } = source;
    const res = await context.app.stream.file(mediaReadRequest(request), path);
    const name = (path.split('/').pop() ?? 'download').replaceAll('"', '');
    const headers = new Headers(res.headers);
    headers.set('content-disposition', `attachment; filename="${name}"`);
    return new Response(res.body, { status: res.status, headers });
  }
  const named = await zipEntriesFor(context, id);
  if (named === null) return notFound(context);
  const blob = await context.app.zip.archive(named.entries);
  return new Response(request.method === 'HEAD' ? null : blob, {
    headers: {
      'content-type': 'application/zip',
      'content-length': String(blob.size),
      'content-disposition': `attachment; filename="${named.filename}.zip"`,
    },
  });
};
