// src/facade.ts — one HTTP entry point over core + N layers. The grammar:
//   1. /_<name>/… → that layer's tree, prefix stripped. /_/ = no layer =
//      core's own tree (core/, never globbed, named by core).
//   2. Each layer's lookup(method, path): one hit → that app; several → first
//      whose manifest headers match; none → bare 404 from core.
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

export function facade(
  coreApp: PathfinderApp,
  layers: Layer[],
): (request: Request, info?: unknown) => Promise<Response> {
  const candidates = layers.filter((l) => l.port === undefined);
  return async (request: Request, info?: unknown): Promise<Response> => {
    const path = new URL(request.url).pathname;

    // Amperfy-style reachability probes GET the server root before login and
    // abort on any >= 400 — answer 200. The real UI claims / with M5; until
    // then it's a plain-text hello.
    if (path === '/') {
      return new Response('Hello World!\n', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    // /_/ — the "no layer" prefix: core's own tree.
    if (path === '/_' || path.startsWith('/_/')) {
      const rest = path.slice(2) || '/';
      return await coreApp(
        new Request(new URL(rest, request.url), request),
        info,
      );
    }

    // Force prefix: /_<name> strip → that layer.
    for (const layer of candidates) {
      const prefix = `/_${layer.name}`;
      if (path === prefix || path.startsWith(`${prefix}/`)) {
        const rest = path.slice(prefix.length) || '/';
        return await layer.app(
          new Request(new URL(rest, request.url), request),
          info,
        );
      }
    }

    // Lookup across candidates.
    const hits: Layer[] = [];
    for (const layer of candidates) {
      const result = layer.app.lookup(request.method, path);
      if (result.kind === 'match') hits.push(layer);
    }
    if (hits.length === 1) return await hits[0].app(request, info);
    if (hits.length > 1) {
      const match = hits.find((l) => headersMatch(request, l));
      if (match) return await match.app(request, info);
    }
    return Response.json({ detail: 'Not Found' }, { status: 404 });
  };
}
