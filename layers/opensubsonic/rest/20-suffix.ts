// layers/opensubsonic/rest/20-suffix.ts — the `.view` suffix gate, after
// 10-auth (so unauthenticated requests still fail 40/10 first). Every op
// folder is `<op>##ext` (pathfinder 0.2.3 empty-ok capture): `ext` is absent
// on /rest/ping, ".view" on /rest/ping.view — anything else (/rest/pingXYZ)
// is not an op and answers the same 404 envelope as rest/404.ts. HLS routes
// (hls.m3u8/, hls/) carry no `##ext`, so `ext` is absent there and this
// passes them through. Handlers never read `ext`.
import { fail } from '#opensubsonic/envelope.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default (request: HatRequest, context: HatContext) => {
  const ext = request.params.ext;
  if (ext !== undefined && ext !== '.view') {
    return fail(context, 0, 'Not found', 404);
  }
};
