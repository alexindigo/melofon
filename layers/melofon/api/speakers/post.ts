import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { fields } from '#melofon/input.ts';
import { source } from '#melofon/libraries.ts';

export default async function (request: HatRequest, context: HatContext) {
  const body = fields(context, [
    'protocol',
    'address',
    'port',
    'name',
    'connectionStrategy',
  ]);
  const speaker = await core(() =>
    context.app.speakers.add(body, source(request, context))
  );
  return Response.json({ speaker }, {
    status: 201,
    headers: { 'Cache-Control': 'no-store' },
  });
}
