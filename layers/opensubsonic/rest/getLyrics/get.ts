// layers/opensubsonic/rest/getLyrics/get.ts — GET /rest/getLyrics.
// Embedded (USLT) lyrics only — no external agent. Empty lyrics element
// when the song or the tag is missing (Subsonic's own "no lyrics" shape).
import { ok } from '#opensubsonic/envelope.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const params = context.state.params!;
  const row = await context.app.library.lyrics({
    artist: params.get('artist') ?? undefined,
    title: params.get('title') ?? undefined,
  });
  if (row === null) return ok(context, { lyrics: {} });
  return ok(context, {
    lyrics: {
      artist: row.artist ?? undefined,
      title: row.title ?? undefined,
      value: row.text,
    },
  });
};
