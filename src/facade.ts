// src/facade.ts — one HTTP entry point over core + N layers. The grammar:
//   1. /_<name>/… → that layer, prefix stripped, then mount rules below.
//      /_/ = no layer = core's own tree (core/, never globbed, named by core).
//   2. Each layer's mounts: a path that is a mount's prefix or prefix/… is
//      claimed by that mount and the app sees the path relative to it
//      (/rest/ping → /ping; /restping is NOT the /rest mount). A path no
//      prefix is claimed by any candidate falls back to direct mount lookups.
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
import type { Layer, Mount } from './layers.ts';
import { createPortMapping, type PortMapping } from './binds.ts';
import { type Log, scopedLog } from './logging.ts';

function headersMatch(request: Request, layer: Layer): boolean {
  return layer.headers.length > 0 &&
    layer.headers.every((h) =>
      request.headers.get(h.name)?.includes(h.includes) ?? false
    );
}

// The mount a path belongs to, plus the path relative to it. Prefix claim
// first (/rest/ping → /ping); a bare remainder no prefix matches falls back
// to a lookup in each mount app, so /_opensubsonic/ping works too.
function claims(mount: Mount, path: string): boolean {
  return mount.prefix !== '' &&
    (path === mount.prefix || path.startsWith(`${mount.prefix}/`));
}

function layerDispatch(
  layer: Layer,
  method: string,
  path: string,
  claimedOnly = false,
): { app: PathfinderApp; path: string } | null {
  for (const mount of layer.mounts) {
    if (claims(mount, path)) {
      return { app: mount.app, path: path.slice(mount.prefix.length) || '/' };
    }
  }
  if (claimedOnly) return null;
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

interface TraceInfo {
  remoteAddr?: { hostname?: string };
  completed?: Promise<void>;
}

export function facade(
  coreApp: PathfinderApp,
  layers: Layer[] | (() => Layer[]),
  opts: {
    listenPort?: number;
    defaultPort?: number;
    env?: Record<string, string>;
    mapping?: PortMapping;
    debugLogRequests?: boolean;
    debugLogHeaders?: boolean;
    log?: Log;
  } = {},
): (request: Request, info?: unknown) => Promise<Response> {
  const mapping = opts.mapping ?? createPortMapping(opts.env ?? {});
  // The `/` hello answers on the default listen only; on an extra bind `/`
  // belongs to the bind's hats (the owntone hat serves no Vue → 404).
  const isDefaultListen = opts.listenPort === undefined ||
    opts.listenPort === opts.defaultPort;
  let nextReqId = 0;
  let inflight = 0;
  const log = opts.log ?? scopedLog('facade');
  return async (request: Request, info?: unknown): Promise<Response> => {
    const current = typeof layers === 'function' ? layers() : layers;
    const candidates = current.filter((layer) =>
      isDefaultListen
        ? layer.ports.length === 0
        : mapping.actual(layer).includes(opts.listenPort!)
    );
    const debug = opts.debugLogRequests === true;
    const path = new URL(request.url).pathname;
    let reqId = 0;
    const started = performance.now();
    if (debug) {
      reqId = ++nextReqId;
      inflight++;
      const peer = (info as TraceInfo | undefined)?.remoteAddr?.hostname ??
        '?';
      log.event('http_accept', {
        request,
        req: reqId,
        inflight,
        peer,
        traceHeaders: opts.debugLogHeaders === true,
      });
    }

    // Wraps each dispatch branch: with debug off it is the identity.
    const respond = (res: Promise<Response>): Promise<Response> => {
      if (!debug) return res;
      return res.then((response) => {
        const waitMs = Math.round(performance.now() - started);
        log.event('http_headers', {
          request,
          req: reqId,
          inflight,
          status: response.status,
          waitMs,
        });
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
            log.event('http_done', {
              request,
              req: reqId,
              inflight,
              bodyMs,
              aborted,
            });
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
      const peer = (info as TraceInfo | undefined)?.remoteAddr?.hostname;
      if (rest !== '/health' && rest !== '/_status' && !isLoopback(peer)) {
        return respond(
          Promise.resolve(
            Response.json({ detail: 'Not Found' }, { status: 404 }),
          ),
        );
      }
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

    // A claimed namespace belongs only to its claiming hats, even when an
    // unrelated mount's positional route could match the original bare path.
    // Keep bare aliases/root mounts unchanged when no candidate claims it.
    const claimedOnly = candidates.some((layer) =>
      layer.mounts.some((mount) => claims(mount, path))
    );
    const hits: { layer: Layer; app: PathfinderApp; path: string }[] = [];
    for (const layer of candidates) {
      const dispatch = layerDispatch(layer, request.method, path, claimedOnly);
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

function isLoopback(peer: string | undefined): boolean {
  if (peer === '::1') return true;
  if (!peer || !/^127(?:\.\d{1,3}){3}$/.test(peer)) return false;
  return peer.split('.').every((part) => Number(part) <= 255);
}
