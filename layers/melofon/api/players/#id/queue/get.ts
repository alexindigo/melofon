import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core, fail } from '#melofon/errors.ts';
import { browseInteger, browseQuery } from '#melofon/browse.ts';
import { playerId, queueEntryPayload } from '#melofon/players.ts';

export default async function (request: HatRequest, context: HatContext) {
  const id = playerId(request.params.id);
  const params = browseQuery(request, ['view', 'offset', 'limit']);
  const view = params.get('view') ?? 'upNext';
  if (view !== 'upNext' && view !== 'all') {
    fail(400, 'invalid_field', 'Invalid view');
  }
  const max = Number(
    await context.app.state.getTyped('melofon.queueMaxPageRecords'),
  );
  const defaultLimit = Number(
    await context.app.state.getTyped('melofon.queuePageRecords'),
  );
  const offset = browseInteger(params, 'offset', 0, 0);
  const limit = browseInteger(
    params,
    'limit',
    Math.min(defaultLimit, max),
    1,
    max,
  );
  const page = await core(() =>
    Promise.resolve(
      context.app.players.get(id).queuePageView({ view, offset, limit }),
    )
  );
  return Response.json({
    ...page,
    view,
    offset,
    limit,
    items: page.items.map((entry, index) =>
      queueEntryPayload(entry, page.startIndex + offset + index)
    ),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
