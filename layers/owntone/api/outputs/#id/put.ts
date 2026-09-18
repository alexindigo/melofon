// layers/owntone/api/outputs/#id/put.ts — PUT /api/outputs/<id>: JSON body
// { selected?, volume? } (pin/format/offset_ms are not implemented in M5).
import { badRequest, noContent } from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  const id = request.params.id;
  if (!/^\d+$/.test(id)) return badRequest();
  let body: { selected?: unknown; volume?: unknown };
  try {
    body = (await request.body.json()) as typeof body;
  } catch {
    return badRequest();
  }
  const opts: { selected?: boolean; volume?: number } = {};
  if (typeof body.selected === 'boolean') opts.selected = body.selected;
  if (typeof body.volume === 'number') opts.volume = body.volume;
  const updated = context.app.outputs.update(id, opts);
  return updated === null ? badRequest() : noContent();
};
