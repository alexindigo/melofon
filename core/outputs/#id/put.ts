// Native output settings; automatically discovered by the core router.
import { isConnectionStrategy } from '../../../src/connection-strategy.ts';
import { type Outputs, sourceFromRequest } from '../../../src/player.ts';
import { SpeakerError, type Speakers } from '../../../src/speakers.ts';

export default async function (request: {
  params: { id: string };
  body: { json(): Promise<unknown> };
  headers?: { get(name: string): string | null };
  remoteAddr?: { hostname?: string };
}, context: { app: { outputs: Pick<Outputs, 'get'>; speakers: Speakers } }) {
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
  try {
    const speaker = await context.app.speakers.configure(request.params.id, {
      connectionStrategy: body.connectionStrategy,
    }, sourceFromRequest(request));
    const output = context.app.outputs.get(speaker.id);
    return output === null
      ? Response.json({ error: 'output not found' }, { status: 404 })
      : { output };
  } catch (error) {
    if (!(error instanceof SpeakerError)) throw error;
    return Response.json({ error: error.message }, {
      status: error.code === 'not_found'
        ? 404
        : error.code === 'persistence_failed'
        ? 500
        : 400,
    });
  }
}
