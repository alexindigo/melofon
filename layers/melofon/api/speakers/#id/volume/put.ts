import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { volume } from '#melofon/input.ts';
import { source } from '#melofon/libraries.ts';

export default async function (request: HatRequest, context: HatContext) {
  const value = volume(context);
  await core(() =>
    context.app.speakers.setVolume(
      request.params.id,
      value,
      source(request, context),
    )
  );
  return new Response(null, { status: 204 });
}
