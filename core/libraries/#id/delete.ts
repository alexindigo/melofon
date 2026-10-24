// DELETE /_/libraries/<id> — remove a scan source and its catalog rows
// (app.libraries.remove). 404 when the id is unknown.
export default async function (
  request: {
    params: { id: string };
    remoteAddr?: { hostname?: string };
    headers: Headers;
  },
  context: {
    app: {
      libraries: {
        remove(
          id: string,
          source?: { kind: 'http'; peer?: string; userAgent?: string },
        ): Promise<boolean>;
      };
    };
  },
) {
  const removed = await context.app.libraries.remove(request.params.id, {
    kind: 'http',
    peer: request.remoteAddr?.hostname,
    userAgent: request.headers.get('user-agent') ?? undefined,
  });
  if (!removed) {
    return Response.json({ error: 'unknown library id' }, { status: 404 });
  }
  return { ok: true };
}
