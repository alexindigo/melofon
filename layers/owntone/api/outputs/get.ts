// layers/owntone/api/outputs/get.ts — GET /api/outputs. Empty until a boot
// registers a real output (M6); an empty list is valid OwnTone JSON and the
// truth — there is no dummy sink.
import { outputPayload } from '#owntone/payloads.ts';
import type { HatContext } from '#owntone/types.ts';

export default (_request: unknown, context: HatContext) => ({
  outputs: context.app.outputs.list().map(outputPayload),
});
