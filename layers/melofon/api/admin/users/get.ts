import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
export default async function (_request: HatRequest, context: HatContext) {
  return {
    users: await core(() => context.app.users.list(context.state.user.id)),
  };
}
