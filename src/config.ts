// src/config.ts — env → config. Listen, data dir, first-boot user, and the
// server secret all come from the environment; the Settings UI (M5) does not
// exist yet, so env is the only settings channel. Scan sources are NOT here:
// they live in the libraries table (app.libraries / /_/libraries) since M3;
// env never names a library path.
export interface Config {
  // MELOFON_LISTEN parsed to {hostname, port} or undefined (Deno.serve default).
  listen: { hostname: string; port: number } | undefined;
  // MELOFON_DATA — directory for melofon.duckdb (default ./data).
  dataDir: string;
  user: string | undefined;
  password: string | undefined;
  secret: string | undefined;
  // Server version for protocol envelopes (OpenSubsonic serverVersion), read
  // from deno.json at load — not an env knob.
  version?: string;
  // MELOFON_DEBUG_LOG_REQUEST=1|true — a compact three-event trace per HTTP
  // request (accept/headers/done; credentials always redacted). Off by default.
  debugLogRequests?: boolean;
  // MELOFON_DEBUG_LOG_HEADERS=1|true — additionally dump the request's
  // redacted query + headers on the accept line. Off by default.
  debugLogHeaders?: boolean;
}

export function loadConfig(
  env: (name: string) => string | undefined = (n) => Deno.env.get(n),
): Config {
  let version: string | undefined;
  try {
    const denoJson = JSON.parse(
      Deno.readTextFileSync(new URL('../deno.json', import.meta.url)),
    );
    if (typeof denoJson.version === 'string') version = denoJson.version;
  } catch {
    // deno.json unreadable — version stays undefined, envelopes fall back
  }
  const listenRaw = env('MELOFON_LISTEN');
  let listen: Config['listen'];
  if (listenRaw !== undefined && listenRaw.trim() !== '') {
    const idx = listenRaw.lastIndexOf(':');
    if (idx <= 0 || idx === listenRaw.length - 1) {
      throw new Error(
        `MELOFON_LISTEN must look like host:port, got ${
          JSON.stringify(listenRaw)
        }`,
      );
    }
    const hostname = listenRaw.slice(0, idx);
    const port = Number(listenRaw.slice(idx + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(
        `MELOFON_LISTEN port must be an integer 1..65535, got ${
          JSON.stringify(listenRaw)
        }`,
      );
    }
    listen = { hostname, port };
  }
  return {
    listen,
    dataDir: env('MELOFON_DATA') ?? './data',
    user: env('MELOFON_USER'),
    password: env('MELOFON_PASSWORD'),
    secret: env('MELOFON_SECRET'),
    version,
    debugLogRequests: ['1', 'true'].includes(
      env('MELOFON_DEBUG_LOG_REQUEST') ?? '',
    ),
    debugLogHeaders: ['1', 'true'].includes(
      env('MELOFON_DEBUG_LOG_HEADERS') ?? '',
    ),
  };
}
