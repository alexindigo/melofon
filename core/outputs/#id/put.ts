// Native output settings; automatically discovered by the core router.
import { isConnectionStrategy } from '../../../src/connection-strategy.ts';
import { type Outputs, sourceFromRequest } from '../../../src/player.ts';

export default async function (request: {
  params: { id: string };
  body: { json(): Promise<unknown> };
  headers?: { get(name: string): string | null };
  remoteAddr?: { hostname?: string };
}, context: { app: { outputs: Pick<Outputs, 'update'> } }) {
  let body: unknown;
  try {
    body = await request.body.json();
  } catch {
    return Response.json({ error: 'JSON body is required' }, { status: 400 });
  }
  if (
    body === null || typeof body !== 'object' || Array.isArray(body) ||
    Object.keys(body).length !== 1 || !('connectionStrategy' in body) ||
    !isConnectionStrategy(body.connectionStrategy)
  ) {
    return Response.json({
      error: 'connectionStrategy must be an exact strategy',
    }, { status: 400 });
  }
  const output = context.app.outputs.update(request.params.id, {
    connectionStrategy: body.connectionStrategy,
  }, sourceFromRequest(request));
  return output === null
    ? Response.json({ error: 'output not found' }, { status: 404 })
    : { output };
}
