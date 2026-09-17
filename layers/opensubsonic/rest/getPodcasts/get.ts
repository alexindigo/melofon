// layers/opensubsonic/rest/getPodcasts/get.ts — GET /rest/getPodcasts.
// M3 empty-ok stub: melofon is not building podcasts (don't-die beats
// implement-for-real) — the app renders "no podcasts", never an error.
import { ok } from '#opensubsonic/envelope.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default (_request: HatRequest, context: HatContext) =>
  ok(context, { podcasts: { channel: [] } });
