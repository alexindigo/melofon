// layers/opensubsonic/rest/getUser/get.ts — GET /rest/getUser.
// folder is the wire ints of every source (same values as getMusicFolders)
// — every user gets every source until per-user access exists; empty
// sources → empty folder, never a synthetic 0.
import { fail, notFound, ok } from '#opensubsonic/envelope.ts';
import { folderWireId, requiredParam } from '#opensubsonic/params.ts';
import { userOf } from '#opensubsonic/users.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const username = requiredParam(context, 'username');
  if (username instanceof Response) return username;
  const user = await context.app.user.get(
    context.state.user!.username,
    username,
  );
  if (user === 'forbidden') {
    return fail(context, 50, 'User is not authorized for the given operation');
  }
  if (user === null) return notFound(context);
  const folders = await context.app.libraries.list();
  return ok(context, {
    user: userOf(user, folders.map((f) => folderWireId(f.id))),
  });
};
