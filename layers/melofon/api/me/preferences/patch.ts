import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { fields } from '#melofon/input.ts';

export default function (_request: HatRequest, context: HatContext) {
  const body = fields(context, ['preferences', 'revisions']);
  return core(() =>
    context.app.preferences.change(
      context.state.user.id,
      body.preferences,
      body.revisions,
    )
  );
}
