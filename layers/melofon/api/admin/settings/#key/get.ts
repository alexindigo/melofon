import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { HttpError } from '@pathfinder/pathfinder';
export default async function (request: HatRequest, context: HatContext) {
  const settings = await core(() =>
    context.app.settings.describe(context.state.user.id)
  );
  const item = settings.find((item) => item.key === request.params.key);
  if (!item) {
    throw new HttpError(404, {
      code: 'unknown_setting',
      message: 'Unknown setting',
      key: request.params.key,
    });
  }
  return item;
}
