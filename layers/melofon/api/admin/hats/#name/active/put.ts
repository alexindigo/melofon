import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core, fail } from '#melofon/errors.ts';
import { fields } from '#melofon/input.ts';
export default function (request: HatRequest, context: HatContext) {
  const { active } = fields(context, ['active']);
  if (typeof active !== 'boolean') {
    fail(400, 'invalid_field', 'active must be a boolean');
  }
  return core(() =>
    active
      ? context.app.hats.activate(context.state.user.id, request.params.name)
      : context.app.hats.deactivate(context.state.user.id, request.params.name)
  );
}
