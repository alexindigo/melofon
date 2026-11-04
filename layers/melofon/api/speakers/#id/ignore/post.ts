import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { fields } from '#melofon/input.ts';

export default async function (request: HatRequest, context: HatContext) {
  fields(context, []);
  const speaker = await core(() =>
    context.app.speakers.ignore(request.params.id)
  );
  return Response.json({ speaker }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
