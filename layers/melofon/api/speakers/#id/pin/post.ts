import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  const pairing = await core(() =>
    context.app.speakers.submitPin(request.params.id, context.state.json)
  );
  return Response.json({ pairing }, {
    status: 202,
    headers: { 'Cache-Control': 'no-store' },
  });
}
