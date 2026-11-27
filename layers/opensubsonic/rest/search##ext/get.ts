// Deprecated pre-1.4 file search; the result contains only Child matches.
import { fail, ok } from '#opensubsonic/envelope.ts';
import { childOf } from '#opensubsonic/id3.ts';
import { safeIntegerParam, safeIntParam } from '#opensubsonic/params.ts';
import { loadPersonal } from '#opensubsonic/personal.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const params = context.state.params!;
  const newerThan = params.get('newerThan');
  const addedAfterMs = safeIntegerParam(newerThan);
  if (
    newerThan !== null && (newerThan.trim() === '' || addedAfterMs === null)
  ) {
    return fail(context, 10, 'newerThan must be an integer epoch timestamp');
  }
  const offset = safeIntParam(params, 'offset', 0);
  const page = await context.app.library.searchSongs({
    artist: params.get('artist')?.trim() || undefined,
    album: params.get('album')?.trim() || undefined,
    title: params.get('title')?.trim() || undefined,
    text: params.get('any')?.trim() || undefined,
    addedAfterMs: addedAfterMs ?? undefined,
    limit: safeIntParam(params, 'count', 20),
    offset,
  });
  const p = await loadPersonal(context, { songs: page.rows.map((s) => s.id) });
  return ok(context, {
    searchResult: {
      offset,
      totalHits: page.total,
      match: page.rows.map((song) => childOf(song, p)),
    },
  });
};
