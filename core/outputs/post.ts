// POST /_/outputs — operator-registered outputs (M6: manual AirPlay host
// first). JSON body: { "name", "type": "AirPlay", "host", "port"? }. Unicast-
// resolves `_raop._tcp` at the host and copies device TXT when it answers;
// a timeout still registers the row but without pretending md=7. The id is
// stable from the host (or the discovered instance if that row exists).
import type { AirplayDevices } from '../../src/boots/airplay-device.ts';
import { isConnectionStrategy } from '../../src/connection-strategy.ts';
import {
  type CommandSource,
  type Output,
  type OutputRegistration,
  sourceFromRequest,
} from '../../src/player.ts';

interface OutputsApp {
  app: {
    outputs: {
      list(): Output[];
      get(id: string): Output | null;
      register(output: OutputRegistration, source?: CommandSource): void;
    };
    airplay: AirplayDevices;
  };
}

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

export default async function (
  request: {
    body: { json(): Promise<unknown> };
    headers?: { get(name: string): string | null };
    remoteAddr?: { hostname?: string };
  },
  context: OutputsApp,
) {
  const source = sourceFromRequest(request);
  let body: unknown;
  try {
    body = await request.body.json();
  } catch {
    return badRequest('JSON body with name, type and host is required');
  }
  const { name, type, host, port, connectionStrategy } = (body ?? {}) as {
    name?: unknown;
    type?: unknown;
    host?: unknown;
    port?: unknown;
    connectionStrategy?: unknown;
  };
  if (
    connectionStrategy !== undefined &&
    !isConnectionStrategy(connectionStrategy)
  ) {
    return badRequest('invalid AirPlay connection strategy');
  }
  if (typeof name !== 'string' || name.trim() === '') {
    return badRequest('name must be a non-empty string');
  }
  if (type !== 'AirPlay') {
    return badRequest('type must be "AirPlay" (the only boot so far)');
  }
  if (typeof host !== 'string' || host.trim() === '') {
    return badRequest('host must be a non-empty string');
  }
  if (
    port !== undefined &&
    (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 ||
      port > 65535)
  ) {
    return badRequest('port must be a positive integer');
  }
  const address = host.trim();
  const output = await context.app.airplay.registerAddress({
    name: name.trim(),
    host: address,
    ...(port === undefined ? {} : { port: port as number }),
    ...(connectionStrategy === undefined ? {} : { connectionStrategy }),
  }, source);
  return {
    output: output === null ? null : {
      ...output,
      preparation: context.app.airplay.admission.describe(output.id),
    },
  };
}
