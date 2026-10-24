import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { fields } from '#melofon/input.ts';
export default async function (_request: HatRequest, context: HatContext) {
  const body = fields(context, ['changes']);
  return {
    settings: await core(() =>
      context.app.settings.change(context.state.user.id, body.changes)
    ),
  };
}
