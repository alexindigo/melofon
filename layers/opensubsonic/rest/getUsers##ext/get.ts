import { fail, ok } from '#opensubsonic/envelope.ts';
import { folderWireId } from '#opensubsonic/params.ts';
import { userOf } from '#opensubsonic/users.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const users = await context.app.user.list(context.state.user!.username);
  if (users === 'forbidden') {
    return fail(context, 50, 'User is not authorized for the given operation');
  }
  const folders = (await context.app.libraries.list()).map((f) =>
    folderWireId(f.id)
  );
  return ok(context, { users: { user: users.map((u) => userOf(u, folders)) } });
};
