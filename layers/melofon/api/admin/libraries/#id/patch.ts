import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { fields, optionalText } from '#melofon/input.ts';
import { source } from '#melofon/libraries.ts';
export default async function (request: HatRequest, context: HatContext) {
  const body = fields(context, ['name', 'path']);
  const library = await core(() =>
    context.app.libraries.update(request.params.id, {
      name: optionalText(body, 'name'),
      path: optionalText(body, 'path'),
    }, source(request, context))
  );
  return { library };
}
