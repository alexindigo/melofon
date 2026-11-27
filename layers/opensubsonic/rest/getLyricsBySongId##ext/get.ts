import { ok } from '#opensubsonic/envelope.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import { structuredLyrics } from '#opensubsonic/lyrics.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const enhanced = context.state.params!.get('enhanced') === 'true';
  const entries = await context.app.library.lyricsBySongId(id, enhanced);
  return ok(context, {
    lyricsList: {
      structuredLyrics: entries
        .filter((entry) => enhanced || (entry.kind ?? 'main') === 'main')
        .map((entry) => structuredLyrics(entry, enhanced)),
    },
  });
};
