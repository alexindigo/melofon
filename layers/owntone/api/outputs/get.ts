// layers/owntone/api/outputs/get.ts — GET /api/outputs (M5: the one dummy
// fifo).
import { outputPayload } from '#owntone/payloads.ts';
import type { HatContext } from '#owntone/types.ts';

export default (_request: unknown, context: HatContext) => ({
  outputs: context.app.outputs.list().map(outputPayload),
});
