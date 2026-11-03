import type { HatContext, HatRequest } from '#melofon/types.ts';
import { fail } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  if (!await context.app.radio.removeArtwork(request.params.id)) {
    fail(404, 'not_found', 'Station not found');
  }
  return {};
}
