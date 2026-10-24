import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
export default async function (_request: HatRequest, context: HatContext) {
  return {
    settings: await core(() =>
      context.app.settings.describe(context.state.user.id)
    ),
  };
}
