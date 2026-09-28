// PUT /_/config/<key> — set an internal-state key (app.state.set). JSON
// body: { "value": "…" }. Components subscribed with onChange react live
// (e.g. PUT /_/config/airplay.mdns {"value":"off"} stops AirPlay discovery).
// 400 on a bad body. Provenance-logged like every mutation (plan
// command-provenance): the key name, never the value (it may be sensitive).
import { logCmd, sourceFromRequest } from '../../../src/player.ts';

export default async function (
  request: {
    params: { key: string };
    body: { json(): Promise<unknown> };
    headers?: { get(name: string): string | null };
    remoteAddr?: { hostname?: string };
  },
  context: {
    app: { state: { set(key: string, value: string): Promise<void> } };
  },
) {
  let body: unknown;
  try {
    body = await request.body.json();
  } catch {
    return Response.json({ error: 'JSON body with value is required' }, {
      status: 400,
    });
  }
  const { value } = (body ?? {}) as { value?: unknown };
  if (typeof value !== 'string') {
    return Response.json({ error: 'value must be a string' }, {
      status: 400,
    });
  }
  logCmd('config', request.params.key, sourceFromRequest(request));
  await context.app.state.set(request.params.key, value);
  return { ok: true };
}
