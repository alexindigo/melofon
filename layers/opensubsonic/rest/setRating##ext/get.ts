// layers/opensubsonic/rest/setRating/get.ts — GET /rest/setRating.
// rating 1..5; 0 clears (Subsonic convention; blank and -0 are 0). Missing
// id or rating is code 10; a value that is not an integer 0-5 is code 0
// (Navidrome); an id outside the catalog is code 70.
import { fail, notFound, ok } from '#opensubsonic/envelope.ts';
import { integerParam, requiredParam } from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const raw = context.state.params!.get('rating');
  if (raw === null) return fail(context, 10, 'Required parameter is missing');
  const rating = integerParam(raw);
  if (rating === null || rating < 0 || rating > 5) {
    return fail(context, 0, 'rating must be an integer 0-5');
  }
  const rated = await context.app.annotation.setRating(
    context.state.user!.username,
    id,
    rating,
  );
  return rated ? ok(context, {}) : notFound(context);
};
