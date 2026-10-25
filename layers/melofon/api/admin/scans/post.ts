import type { HatContext, HatRequest } from '#melofon/types.ts';
import { fields } from '#melofon/input.ts';
import { core } from '#melofon/errors.ts';
export default async function (_request: HatRequest, context: HatContext) {
  fields(context, ['libraries', 'folder']);
  await core(() => context.app.scan.request(context.state.json));
  return Response.json({ scan: await context.app.scan.status() }, {
    status: 202,
  });
}
