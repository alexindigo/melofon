// POST /_/libraries — add a scan source. JSON body: { "name", "path" }.
// The path must be a readable directory; the row is idempotent by path
// (re-adding returns the existing row). 400 on invalid input.
interface LibrariesApp {
  app: {
    libraries: {
      add(
        name: string,
        path: string,
      ): Promise<{ id: string; name: string; path: string }>;
    };
  };
}

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

export default async function (
  request: { body: { json(): Promise<unknown> } },
  context: LibrariesApp,
) {
  let body: unknown;
  try {
    body = await request.body.json();
  } catch {
    return badRequest('JSON body with name and path is required');
  }
  const { name, path } = (body ?? {}) as { name?: unknown; path?: unknown };
  if (typeof name !== 'string' || name.trim() === '') {
    return badRequest('name must be a non-empty string');
  }
  if (typeof path !== 'string' || path.trim() === '') {
    return badRequest('path must be a non-empty string');
  }
  const stat = await Deno.stat(path).catch(() => null);
  if (stat === null || !stat.isDirectory) {
    return badRequest(`path is not a readable directory: ${path}`);
  }
  const row = await context.app.libraries.add(name.trim(), path);
  return { library: row };
}
