// DELETE /_/outputs/<id> — unregister an output (app.outputs.unregister).
// 404 when the id was never registered.
import { type CommandSource, sourceFromRequest } from '../../../src/player.ts';

export default function (
  request: {
    params: { id: string };
    headers?: { get(name: string): string | null };
    remoteAddr?: { hostname?: string };
  },
  context: {
    app: {
      outputs: {
        unregister(id: string, source?: CommandSource): boolean;
      };
    };
  },
) {
  const removed = context.app.outputs.unregister(
    request.params.id,
    sourceFromRequest(request),
  );
  if (!removed) {
    return Response.json({ error: 'unknown output id' }, { status: 404 });
  }
  return { ok: true };
}
