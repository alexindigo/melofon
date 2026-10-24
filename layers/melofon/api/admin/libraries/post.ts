import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { fields, text } from '#melofon/input.ts';
import { source } from '#melofon/libraries.ts';
export default async function (request: HatRequest, context: HatContext) {
  const body = fields(context, ['name', 'path']);
  const library = await core(() =>
    context.app.libraries.add(
      text(body, 'name'),
      text(body, 'path'),
      source(request, context),
    )
  );
  return Response.json({ library }, { status: 201 });
}
