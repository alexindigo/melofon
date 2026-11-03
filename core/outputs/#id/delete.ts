// Operator deletion shares the durable forget contract with every hat.
import { sourceFromRequest } from '../../../src/player.ts';
import { SpeakerError, type Speakers } from '../../../src/speakers.ts';

export default async function (
  request: {
    params: { id: string };
    headers?: { get(name: string): string | null };
    remoteAddr?: { hostname?: string };
  },
  context: {
    app: {
      speakers: Speakers;
    };
  },
) {
  try {
    await context.app.speakers.forget(
      request.params.id,
      sourceFromRequest(request),
    );
    return { ok: true };
  } catch (error) {
    if (!(error instanceof SpeakerError)) throw error;
    return Response.json({ error: error.message }, {
      status: error.code === 'not_found'
        ? 404
        : error.code === 'not_adopted'
        ? 409
        : 500,
    });
  }
}
