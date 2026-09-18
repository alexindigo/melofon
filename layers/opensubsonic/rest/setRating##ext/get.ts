// layers/opensubsonic/rest/setRating/get.ts — GET /rest/setRating.
// rating 1..5; 0 clears (Subsonic convention).
import { fail, ok } from '#opensubsonic/envelope.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const raw = context.state.params!.get('rating');
  const rating = raw === null ? NaN : Number(raw);
  if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
    return fail(context, 10, 'rating must be an integer 0-5');
  }
  await context.app.annotation.setRating(
    context.state.user!.username,
    id,
    rating,
  );
  return ok(context, {});
};
