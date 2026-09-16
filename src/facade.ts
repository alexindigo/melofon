// src/facade.ts — one HTTP entry point over N layers. Dispatch on a listen:
//   1. /_<name> for a candidate layer → strip prefix, that layer's app.
//   2. /_status → pinned to the listen's default layer.
//   3. Each candidate's lookup(method, path): one hit → that app; several →
//      first whose manifest headers match; none → 404 from the default layer.
// Until a second layer shares the listen this is a pass-through to the only
// lookup hit — the matcher exists so M1 is "add layers/rest/", not a rewrite.
// `info` (Deno.serve's second handler argument, carrying remoteAddr) must be
// forwarded into every app call, or pathfinder's Layer 0 loopback guard sees
// no peer and fails closed.
import type { Layer } from './layers.ts';

function headersMatch(request: Request, layer: Layer): boolean {
  return layer.headers.length > 0 &&
    layer.headers.every((h) =>
      request.headers.get(h.name)?.includes(h.includes) ?? false
    );
}

export function facade(
  layers: Layer[],
): (request: Request, info?: unknown) => Promise<Response> {
  const candidates = layers.filter((l) => l.port === undefined);
  const defaultLayer = candidates.find((l) => l.name === 'ui') ?? candidates[0];
  return async (request: Request, info?: unknown): Promise<Response> => {
    const path = new URL(request.url).pathname;

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

    // /_status is pinned to the default layer so hats don't each expose ops.
    if (defaultLayer && (path === '/_status' || path.startsWith('/_status/'))) {
      return await defaultLayer.app(request, info);
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
      return Response.json({ detail: 'Not Found' }, { status: 404 });
    }

    if (defaultLayer) return await defaultLayer.app(request, info);
    return Response.json({ detail: 'Not Found' }, { status: 404 });
  };
}
