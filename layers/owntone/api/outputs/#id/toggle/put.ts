// layers/owntone/api/outputs/#id/toggle/put.ts — PUT /api/outputs/<id>/toggle.
import { badRequest, noContent } from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default (request: HatRequest, context: HatContext) => {
  const id = request.params.id;
  if (!/^\d+$/.test(id)) return badRequest();
  return context.app.outputs.toggle(id) === null ? badRequest() : noContent();
};
