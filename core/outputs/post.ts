// POST /_/outputs — operator-registered outputs (M6: manual AirPlay host
// first). JSON body: { "name", "type": "AirPlay", "host", "port"? }. Unicast-
// resolves `_raop._tcp` at the host and copies device TXT when it answers;
// a timeout still registers the row but without pretending md=7. The id is
// stable from the host (or the discovered instance if that row exists).
import { airplayOutputId } from '../../src/boots/airplay.ts';
import { sessionFieldsFromTxt } from '../../src/boots/airplay-mdns.ts';
import type { MdnsService } from '../../src/mdns.ts';
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
    airplay?: {
      resolve(address: string): Promise<MdnsService | null>;
    };
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
    (typeof port !== 'number' || !Number.isInteger(port) || port <= 0)
  ) {
    return badRequest('port must be a positive integer');
  }
  const address = host.trim();
  const svc = context.app.airplay !== undefined
    ? await context.app.airplay.resolve(address)
    : null;
  const existing = context.app.outputs.list().find((o) => o.host === address);
  const id = existing?.id ?? airplayOutputId(address);
  const base = {
    id,
    name: name.trim(),
    type,
    selected: existing?.selected ?? false,
    volume: existing?.volume ?? 100,
    ...(connectionStrategy === undefined ? {} : { connectionStrategy }),
  };
  if (svc !== null && (svc.txt.tp ?? '').includes('UDP')) {
    context.app.outputs.register({
      ...base,
      host: svc.address,
      port: svc.port,
      ...sessionFieldsFromTxt(svc.txt),
    }, source);
  } else {
    context.app.outputs.register({
      ...base,
      host: address,
      ...(port === undefined ? {} : { port }),
    }, source);
  }
  return { output: context.app.outputs.get(id) };
}
