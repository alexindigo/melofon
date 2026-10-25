import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core, fail } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  const query = new URL(request._raw.url).searchParams;
  if (
    [...query.keys()].some((key) => key !== 'library') ||
    query.getAll('library').length > 1 || query.get('library') === ''
  ) {
    fail(400, 'invalid_field', 'Invalid library query');
  }
  return Response.json(
    await core(() =>
      context.app.scan.problems(query.get('library') ?? undefined)
    ),
  );
}
