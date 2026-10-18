// PUT /_/config/<key> — set an internal-state key (app.state.set). JSON
// body: { "value": "…" }. Components subscribed with onChange react live
// (e.g. PUT /_/config/airplay.mdns {"value":"off"} stops AirPlay discovery).
// 400 on a bad body. Provenance-logged like every mutation (plan
// command-provenance): the key name, never the value (it may be sensitive).
import { sourceFromRequest } from '../../../src/player.ts';
import type { Log } from '../../../src/logging.ts';
import { SettingsValidationError } from '../../../src/settings-schema.ts';

export default async function (
  request: {
    params: { key: string };
    body: { json(): Promise<unknown> };
    headers?: { get(name: string): string | null };
    remoteAddr?: { hostname?: string };
  },
  context: {
    app: {
      state: { set(key: string, value: string): Promise<void> };
      log: Log;
    };
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
  try {
    await context.app.state.set(request.params.key, value);
  } catch (error) {
    if (error instanceof SettingsValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
  context.app.log.event('config_changed', {
    key: request.params.key,
    source: sourceFromRequest(request),
  });
  return { ok: true };
}
