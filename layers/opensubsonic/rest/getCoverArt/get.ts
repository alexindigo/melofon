// layers/opensubsonic/rest/getCoverArt/get.ts — GET /rest/getCoverArt.
// Album cover.jpg or the placeholder — always an image. `size` is ignored
// in M1 (no rescaling).
import { requiredParam } from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  return await context.app.artwork.cover(id);
};
