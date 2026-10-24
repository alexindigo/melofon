// POST /_/libraries — add a scan source. JSON body: { "name", "path" }.
// Validation and effects belong to the shared core libraries service.
import { LibraryError } from '../../src/library-errors.ts';
interface LibrariesApp {
  app: {
    libraries: {
      add(
        name: string,
        path: string,
        source?: { kind: 'http'; peer?: string; userAgent?: string },
      ): Promise<{ id: string; name: string; path: string }>;
    };
  };
}

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

export default async function (
  request: {
    body: { json(): Promise<unknown> };
    remoteAddr?: { hostname?: string };
    headers: Headers;
  },
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
  try {
    const row = await context.app.libraries.add(name.trim(), path, {
      kind: 'http',
      peer: request.remoteAddr?.hostname,
      userAgent: request.headers.get('user-agent') ?? undefined,
    });
    return { library: row };
  } catch (error) {
    if (!(error instanceof LibraryError)) throw error;
    return Response.json({ code: error.code, message: error.message }, {
      status: 400,
    });
  }
}
