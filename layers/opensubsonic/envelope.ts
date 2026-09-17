// layers/opensubsonic/envelope.ts — the Subsonic response envelope (ok /
// failed, XML+JSON). Shared module at the layer root, outside the walked
// mount tree. Subsonic errors ship in the envelope, Navidrome-style: HTTP 200
// with status="failed" (auth failures, missing params). Outcome pages
// (404/500) pass their own HTTP status.
import type { HatContext } from '#opensubsonic/types.ts';

const API_VERSION = '1.16.1';

function base(context: HatContext): Record<string, unknown> {
  return {
    status: 'ok',
    version: API_VERSION,
    type: 'melofon',
    serverVersion: context.app.cfg.version ?? '0.0.0-dev',
    openSubsonic: true,
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' ||
    typeof value === 'boolean';
}

// Subsonic XML convention: objects are elements, scalar fields are
// attributes, arrays repeat the key as the item element (`index`, `artist`,
// `album`, `song` all name their items after the key). One exception: a
// scalar `value` key is mixed content — the element's text, not an attribute
// (genre, lyrics).
function xmlElement(tag: string, value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => xmlElement(tag, item)).join('');
  }
  if (isScalar(value)) {
    return `<${tag}>${escapeXml(String(value))}</${tag}>`;
  }
  const obj = value as Record<string, unknown>;
  let attrs = '';
  let children = '';
  let text: string | null = null;
  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) continue;
    if (key === 'value' && isScalar(val)) {
      text = String(val);
      continue;
    }
    if (isScalar(val)) attrs += ` ${key}="${escapeXml(String(val))}"`;
    else children += xmlElement(key, val);
  }
  const inner = children + (text === null ? '' : escapeXml(text));
  return inner === ''
    ? `<${tag}${attrs}/>`
    : `<${tag}${attrs}>${inner}</${tag}>`;
}

function render(
  context: HatContext,
  envelope: Record<string, unknown>,
  status: number,
): Response {
  const f = context.state.params?.get('f') ?? 'xml';
  if (f === 'json') {
    return Response.json({ 'subsonic-response': envelope }, { status });
  }
  // The XML envelope carries the Subsonic namespace (Navidrome/Subsonic
  // always send it; strict namespace-aware parsers find nothing without it).
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${
    xmlElement('subsonic-response', {
      xmlns: 'http://subsonic.org/restapi',
      ...envelope,
    })
  }`;
  return new Response(xml, {
    status,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}

export function ok(
  context: HatContext,
  payload: Record<string, unknown>,
): Response {
  return render(context, { ...base(context), ...payload }, 200);
}

export function fail(
  context: HatContext,
  code: number,
  message: string,
  status = 200,
): Response {
  return render(
    context,
    { ...base(context), status: 'failed', error: { code, message } },
    status,
  );
}

export function notFound(context: HatContext): Response {
  return fail(context, 70, 'The requested data was not found');
}
