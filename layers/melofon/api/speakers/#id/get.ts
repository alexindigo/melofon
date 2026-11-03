import type { HatContext, HatRequest } from '#melofon/types.ts';
import { fail } from '#melofon/errors.ts';

export default function (request: HatRequest, context: HatContext) {
  const speaker = context.app.speakers.get(request.params.id);
  if (speaker === null) fail(404, 'not_found', 'Speaker not found');
  return Response.json({ speaker }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
