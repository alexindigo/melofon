// layers/owntone/api/outputs/#id/get.ts — GET /api/outputs/<id>. Digits only
// (OwnTone's route regex); unknown → 400 like theirs.
import { badRequest, outputPayload } from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default (request: HatRequest, context: HatContext) => {
  const id = request.params.id;
  if (!/^\d+$/.test(id)) return badRequest();
  const output = context.app.outputs.get(id);
  return output === null ? badRequest() : outputPayload(output);
};
