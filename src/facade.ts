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
// Candidates are filtered by the bind this facade serves (src/binds.ts): the
// default listen (no listenPort, or listenPort === defaultPort) serves
// unported layers only; an extra bind serves the layers whose claimed ports
// map to it after MELOFON_LISTEN_<layer> / MELOFON_LISTEN_REPLACE_<claimed>.
// `info` (Deno.serve's second handler argument, carrying remoteAddr) must be
// forwarded into every app call, or pathfinder's Layer 0 loopback guard sees
// no peer and fails closed.
//
// MELOFON_DEBUG_LOG_REQUEST: a three-event trace per request (diagnosing
// stream-vs-browse stalls — see plans/diag-request-trace). `accept` at
// facade entry, `headers` when the handler returns a Response (waitMs),
// `done` when Deno.serve's info.completed settles (bodyMs; skipped when the
// caller fakes info without completed — tests). Credentials (u/p/t/s/apiKey)
// are always redacted. Compact by default: the full header dump stays
// behind MELOFON_DEBUG_LOG_HEADERS and rides the accept line.
import type { PathfinderApp } from '@pathfinder/pathfinder';
import type { Layer } from './layers.ts';
import { candidatesForBind } from './binds.ts';

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
// Path unchanged → the ORIGINAL request, not a clone: Deno binds a WebSocket
// upgrade to the original Request object — a clone's 101 completes (headers,
// subprotocol) but the socket never delivers data.
function repath(request: Request, path: string): Request {
  const url = new URL(request.url);
  if (url.pathname === path) return request;
  url.pathname = path;
  return new Request(url, request);
}

// Subsonic credentials: u/p, enc:hex p, t+s token, apiKey extension.
const REDACT_KEYS = ['u', 'p', 't', 's', 'apiKey'];

function redactedQuery(url: URL): string {
  const q: string[] = [];
  url.searchParams.forEach((v, k) => {
    q.push(`${k}=${REDACT_KEYS.includes(k) ? '•••' : v}`);
  });
  return q.join('&');
}

function redactedHeaders(request: Request): string {
  return [...request.headers.entries()]
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
}

// ISO time-of-day with milliseconds: 12:34:56.789.
function timeOfDay(): string {
  return new Date().toISOString().slice(11, 23);
}

interface TraceInfo {
  remoteAddr?: { hostname?: string };
  completed?: Promise<void>;
}

export function facade(
  coreApp: PathfinderApp,
  layers: Layer[],
  opts: {
    listenPort?: number;
    defaultPort?: number;
    env?: Record<string, string>;
    debugLogRequests?: boolean;
    debugLogHeaders?: boolean;
  } = {},
): (request: Request, info?: unknown) => Promise<Response> {
  const candidates = candidatesForBind(
    layers,
    opts.listenPort,
    opts.defaultPort,
    opts.env ?? {},
  );
  // The `/` hello answers on the default listen only; on an extra bind `/`
  // belongs to the bind's hats (the owntone hat serves no Vue → 404).
  const isDefaultListen = opts.listenPort === undefined ||
    opts.listenPort === opts.defaultPort;
  let nextReqId = 0;
  let inflight = 0;
  return async (request: Request, info?: unknown): Promise<Response> => {
    const debug = opts.debugLogRequests === true;
    const path = new URL(request.url).pathname;
    const url = new URL(request.url);
    let reqId = 0;
    const started = performance.now();
    if (debug) {
      reqId = ++nextReqId;
      inflight++;
      const peer = (info as TraceInfo | undefined)?.remoteAddr?.hostname ??
        '?';
      const dump = opts.debugLogHeaders === true
        ? ` ${redactedQuery(url)} {${redactedHeaders(request)}}`
        : '';
      console.log(
        `[http ${timeOfDay()}] accept req=${reqId} inflight=${inflight} ` +
          `${request.method} ${path} peer=${peer}${dump}`,
      );
    }

    // Wraps each dispatch branch: with debug off it is the identity.
    const respond = (res: Promise<Response>): Promise<Response> => {
      if (!debug) return res;
      return res.then((response) => {
        const waitMs = Math.round(performance.now() - started);
        console.log(
          `[http ${timeOfDay()}] headers req=${reqId} inflight=${inflight} ` +
            `${request.method} ${path} -> ${response.status} waitMs=${waitMs}`,
        );
        const completed = (info as TraceInfo | undefined)?.completed;
        if (completed === undefined) {
          // Tests calling the facade without Deno.serve's info: no `done`.
          inflight--;
        } else {
          const done = (aborted: boolean) => {
            inflight--;
            const bodyMs = Math.round(
              performance.now() - started - waitMs,
            );
            console.log(
              `[http ${timeOfDay()}] done req=${reqId} inflight=${inflight} ` +
                `${request.method} ${path} bodyMs=${bodyMs}` +
                (aborted ? ' aborted' : ''),
            );
          };
          void completed.then(
            () => done(false),
            () => done(true), // client disconnected mid-body
          );
        }
        return response;
      });
    };

    // Amperfy-style reachability probes GET the server root before login and
    // abort on any >= 400 — answer 200 on the default listen (the M5 UI
    // replaces this stub on branch `owntone`; master keeps the plain-text
    // hello). Extra binds leave `/` to their hats.
    if (isDefaultListen && path === '/') {
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
