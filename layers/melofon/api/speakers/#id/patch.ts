import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { fields } from '#melofon/input.ts';
import { source } from '#melofon/libraries.ts';

export default async function (request: HatRequest, context: HatContext) {
  const body = fields(context, ['connectionStrategy']);
  const speaker = await core(() =>
    context.app.speakers.configure(
      request.params.id,
      body,
      source(request, context),
    )
  );
  return Response.json({ speaker }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
