// POST /_/outputs — operator-registered outputs (M6: manual AirPlay host
// first; mDNS discovery can come later). JSON body:
// { "name", "type": "AirPlay", "host", "port"? }. The id is stable from the
// host (FNV-1a 64-bit, decimal — all digits so the OwnTone wire id regex
// /^\d+$/ accepts it), so re-registering the same device is idempotent.
interface OutputsApp {
  app: {
    outputs: {
      register(output: {
        id: string;
        name: string;
        type: string;
        selected: boolean;
        volume: number;
        host?: string;
        port?: number;
      }): void;
    };
  };
}

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

/** FNV-1a 64-bit of `host`, decimal string. Stable across restarts. */
export function outputIdFromHost(host: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(host)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return hash.toString(10);
}

export default async function (
  request: { body: { json(): Promise<unknown> } },
  context: OutputsApp,
) {
  let body: unknown;
  try {
    body = await request.body.json();
  } catch {
    return badRequest('JSON body with name, type and host is required');
  }
  const { name, type, host, port } = (body ?? {}) as {
    name?: unknown;
    type?: unknown;
    host?: unknown;
    port?: unknown;
  };
  if (typeof name !== 'string' || name.trim() === '') {
    return badRequest('name must be a non-empty string');
  }
  if (type !== 'AirPlay') {
    return badRequest('type must be "AirPlay" (the only boot so far)');
  }
  if (typeof host !== 'string' || host.trim() === '') {
    return badRequest('host must be a non-empty string');
  }
  if (port !== undefined && (!Number.isInteger(port) || port <= 0)) {
    return badRequest('port must be a positive integer');
  }
  const output = {
    id: outputIdFromHost(host.trim()),
    name: name.trim(),
    type,
    selected: false,
    volume: 100,
    host: host.trim(),
    ...(port === undefined ? {} : { port }),
  };
  context.app.outputs.register(output);
  return { output };
}
