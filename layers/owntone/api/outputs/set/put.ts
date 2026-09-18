// layers/owntone/api/outputs/set/put.ts — PUT /api/outputs/set: JSON body
// { outputs: [id, …] } enables exactly those ids.
import { badRequest, noContent } from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  let body: { outputs?: unknown };
  try {
    body = (await request.body.json()) as typeof body;
  } catch {
    return badRequest();
  }
  if (
    !Array.isArray(body.outputs) ||
    !body.outputs.every((id) => typeof id === 'string')
  ) {
    return badRequest();
  }
  return context.app.outputs.setEnabled(body.outputs)
    ? noContent()
    : badRequest();
};
