import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
export default async function (_request: HatRequest, context: HatContext) {
  return new Response(
    await core(() => context.app.server.logText(context.state.user.id)),
    {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="melofon.log"',
      },
    },
  );
}
