// layers/opensubsonic/rest/getLyrics/get.ts — GET /rest/getLyrics.
// Embedded (USLT) lyrics only — no external agent. When the song or the tag
// is missing the lyrics element carries an empty `value` (the schema
// requires the key; a bare empty element breaks strict Decodable clients).
import { ok } from '#opensubsonic/envelope.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const params = context.state.params!;
  const row = await context.app.library.lyrics({
    artist: params.get('artist') ?? undefined,
    title: params.get('title') ?? undefined,
  });
  if (row === null) return ok(context, { lyrics: { value: '' } });
  return ok(context, {
    lyrics: {
      artist: row.artist ?? undefined,
      title: row.title ?? undefined,
      value: row.text,
    },
  });
};
