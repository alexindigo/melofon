// DELETE /_/outputs/<id> — unregister an output (app.outputs.unregister).
// 404 when the id was never registered.
export default function (
  request: { params: { id: string } },
  context: { app: { outputs: { unregister(id: string): boolean } } },
) {
  const removed = context.app.outputs.unregister(request.params.id);
  if (!removed) {
    return Response.json({ error: 'unknown output id' }, { status: 404 });
  }
  return { ok: true };
}
