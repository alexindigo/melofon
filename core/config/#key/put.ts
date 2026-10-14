// PUT /_/config/<key> — set an internal-state key (app.state.set). JSON
// body: { "value": "…" }. Components subscribed with onChange react live
// (e.g. PUT /_/config/airplay.mdns {"value":"off"} stops AirPlay discovery).
// 400 on a bad body. Provenance-logged like every mutation (plan
// command-provenance): the key name, never the value (it may be sensitive).
import { sourceFromRequest } from '../../../src/player.ts';
import type { Log } from '../../../src/logging.ts';
import {
  CONNECTION_STRATEGY_DEFAULT_KEY,
  isConnectionStrategy,
} from '../../../src/connection-strategy.ts';

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
  if (
    request.params.key === CONNECTION_STRATEGY_DEFAULT_KEY &&
    !isConnectionStrategy(value)
  ) {
    return Response.json({ error: 'invalid AirPlay connection strategy' }, {
      status: 400,
    });
  }
  context.app.log.event('config_changed', {
    key: request.params.key,
    source: sourceFromRequest(request),
  });
  await context.app.state.set(request.params.key, value);
  return { ok: true };
}
