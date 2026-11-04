import type { HatContext, HatRequest } from '#melofon/types.ts';
import { speakerOptions } from '#melofon/speakers.ts';

export default function (request: HatRequest, context: HatContext) {
  return Response.json({
    speakers: context.app.speakers.list(speakerOptions(request)),
  }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
