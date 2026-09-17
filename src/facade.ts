// src/facade.ts — one HTTP entry point over core + N layers. The grammar:
//   1. /_<name>/… → that layer, prefix stripped, then mount rules below.
//      /_/ = no layer = core's own tree (core/, never globbed, named by core).
//   2. Each layer's mounts: a path that is a mount's prefix or prefix/… is
//      claimed by that mount and the app sees the path relative to it
//      (/rest/ping → /ping; /restping is NOT the /rest mount). A path no
//      prefix matches falls back to a direct lookup in each mount app.
//   3. Lookup across candidates: one hit → that app; several → first whose
//      manifest headers match; none → bare 404 from core.
// A layer's routes are 100% the layer's responsibility — core never lends,
// pins, or backstops a route for any layer, and has no opinion on /_status
// (pathfinder's per-hat Layer 0, in that hat's own format).
// `info` (Deno.serve's second handler argument, carrying remoteAddr) must be
// forwarded into every app call, or pathfinder's Layer 0 loopback guard sees
// no peer and fails closed.
import type { PathfinderApp } from '@pathfinder/pathfinder';
import type { Layer } from './layers.ts';

function headersMatch(request: Request, layer: Layer): boolean {
  return layer.headers.length > 0 &&
    layer.headers.every((h) =>
      request.headers.get(h.name)?.includes(h.includes) ?? false
    );
}

// The mount a path belongs to, plus the path relative to it. Prefix claim
// first (/rest/ping → /ping); a bare remainder no prefix matches falls back
// to a lookup in each mount app, so /_opensubsonic/ping works too.
function layerDispatch(
  layer: Layer,
  method: string,
  path: string,
): { app: PathfinderApp; path: string } | null {
  for (const mount of layer.mounts) {
    if (
      mount.prefix !== '' &&
      (path === mount.prefix || path.startsWith(`${mount.prefix}/`))
    ) {
      return { app: mount.app, path: path.slice(mount.prefix.length) || '/' };
    }
  }
  for (const mount of layer.mounts) {
    if (mount.app.lookup(method, path).kind === 'match') {
      return { app: mount.app, path };
    }
  }
  return null;
}

// Re-path the request, keeping the query string (credentials ride it).
function repath(request: Request, path: string): Request {
  const url = new URL(request.url);
  url.pathname = path;
  return new Request(url, request);
}

export function facade(
  coreApp: PathfinderApp,
  layers: Layer[],
  opts: { debugLogRequests?: boolean } = {},
): (request: Request, info?: unknown) => Promise<Response> {
  const candidates = layers.filter((l) => l.port === undefined);
  return async (request: Request, info?: unknown): Promise<Response> => {
    const path = new URL(request.url).pathname;

    // MELOFON_DEBUG_LOG_REQUEST: one line per request — method, path,
    // credential-redacted query, response status, and all request headers
    // (authorization-family redacted) — for client-compat debugging.
    const respond = async (res: Promise<Response>): Promise<Response> => {
      if (!opts.debugLogRequests) return await res;
      const r = await res;
      const url = new URL(request.url);
      const q: string[] = [];
      url.searchParams.forEach((v, k) => {
        // Subsonic credentials: u/p, enc:hex p, t+s token, apiKey extension.
        q.push(
          `${k}=${['u', 'p', 't', 's', 'apiKey'].includes(k) ? '•••' : v}`,
        );
      });
      const hdrs = [...request.headers.entries()]
        .map(([k, v]) =>
          `${k}: ${
            [
                'authorization',
                'proxy-authorization',
                'cookie',
                'x-api-key',
              ].includes(k)
              ? '•••'
              : v
          }`
        )
        .join(' | ');
      console.log(
        `[http] ${request.method} ${path}?${
          q.join('&')
        } -> ${r.status} {${hdrs}}`,
      );
      return r;
    };

    // Amperfy-style reachability probes GET the server root before login and
    // abort on any >= 400 — answer 200. The real UI claims / with M5; until
    // then it's a plain-text hello.
    if (path === '/') {
      return respond(
        Promise.resolve(
          new Response('Hello World!\n', {
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          }),
        ),
      );
    }

    // /_/ — the "no layer" prefix: core's own tree.
    if (path === '/_' || path.startsWith('/_/')) {
      const rest = path.slice(2) || '/';
      return await respond(coreApp(repath(request, rest), info));
    }

    // Force prefix: /_<name> strip → that layer, then mount rules.
    for (const layer of candidates) {
      const prefix = `/_${layer.name}`;
      if (path === prefix || path.startsWith(`${prefix}/`)) {
        const rest = path.slice(prefix.length) || '/';
        const dispatch = layerDispatch(layer, request.method, rest);
        if (dispatch !== null) {
          return await respond(
            dispatch.app(repath(request, dispatch.path), info),
          );
        }
        return respond(
          Promise.resolve(
            Response.json({ detail: 'Not Found' }, { status: 404 }),
          ),
        );
      }
    }

    // Lookup across candidates.
    const hits: { layer: Layer; app: PathfinderApp; path: string }[] = [];
    for (const layer of candidates) {
      const dispatch = layerDispatch(layer, request.method, path);
      if (dispatch !== null) hits.push({ layer, ...dispatch });
    }
    if (hits.length === 1) {
      return await respond(
        hits[0].app(repath(request, hits[0].path), info),
      );
    }
    if (hits.length > 1) {
      const match = hits.find((h) => headersMatch(request, h.layer));
      if (match) {
        return await respond(match.app(repath(request, match.path), info));
      }
    }
    return respond(
      Promise.resolve(Response.json({ detail: 'Not Found' }, { status: 404 })),
    );
  };
}
