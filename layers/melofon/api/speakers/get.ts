import type { HatContext, HatRequest } from '#melofon/types.ts';

export default function (_request: HatRequest, context: HatContext) {
  return Response.json({ speakers: context.app.speakers.list() }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
