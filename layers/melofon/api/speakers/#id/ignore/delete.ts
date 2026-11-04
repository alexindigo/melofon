import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  await core(() => context.app.speakers.unignore(request.params.id));
  return new Response(null, { status: 204 });
}
