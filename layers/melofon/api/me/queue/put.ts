import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core, fail } from '#melofon/errors.ts';
import { fields } from '#melofon/input.ts';
import { savedQueue } from '#melofon/queue.ts';

export const jsonMaxBytesSetting = 'melofon.queueJsonMaxBytes';

export default async function (_request: HatRequest, context: HatContext) {
  const body = fields(context, ['songIds', 'currentIndex', 'positionMs']);
  const songIds = body.songIds;
  if (!Array.isArray(songIds) || songIds.some((id) => typeof id !== 'string')) {
    fail(400, 'invalid_field', 'songIds must be an array of strings');
  }
  for (const key of ['currentIndex', 'positionMs']) {
    if (
      body[key] !== undefined &&
      (!Number.isSafeInteger(body[key]) || (body[key] as number) < 0)
    ) fail(400, 'invalid_field', `${key} must be a non-negative integer`);
  }
  const currentIndex = body.currentIndex as number | undefined;
  if (songIds.length > 0 && (currentIndex ?? 0) >= songIds.length) {
    fail(
      400,
      'invalid_field',
      'currentIndex must identify an entry in the queue',
    );
  }
  const session =
    (await core(() => context.app.sessions.list(context.state.user.id))).find((
      s,
    ) => s.id === context.state.sessionId);
  if (!session) fail(401, 'unauthenticated', 'Sign in required');
  await context.app.clientQueue.save(context.state.user.username, {
    trackIds: songIds,
    currentIndex,
    positionMs: body.positionMs as number | undefined,
    changedBy: session.deviceName,
  });
  return savedQueue(context);
}
