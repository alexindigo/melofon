// layers/opensubsonic/rest/star/get.ts — GET /rest/star.
// star/unstar targets: repeated `id` = songs, `albumId` = albums,
// `artistId` = artists (modern Subsonic split).
import { fail, ok } from '#opensubsonic/envelope.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const params = context.state.params!;
  const targets: [string, string][] = [
    ...params.getAll('id').map((id): [string, string] => [id, 'song']),
    ...params.getAll('albumId').map((id): [string, string] => [id, 'album']),
    ...params.getAll('artistId').map((
      id,
    ): [string, string] => [id, 'artist']),
  ];
  if (targets.length === 0) {
    return fail(context, 10, 'Required parameter is missing');
  }
  for (const [targetId, targetType] of targets) {
    await context.app.annotation.star(
      context.state.user!.username,
      targetId,
      targetType,
    );
  }
  return ok(context, {});
};
