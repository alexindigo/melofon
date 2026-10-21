// layers/opensubsonic/envelope.ts — the Subsonic response envelope (ok /
// failed, XML+JSON+JSONP). Shared module at the layer root, outside the walked
// mount tree. Subsonic errors ship in the envelope, Navidrome-style: HTTP 200
// with status="failed" (auth failures, missing params). Outcome pages
// (404/500) pass their own HTTP status. The format and operation come from
// 10-auth's single resolution; without it (a page that ran without the
// middleware) the plain json/xml choice applies, never JSONP.
import {
  API_VERSION,
  BINARY_OPERATIONS,
  plainFormat,
} from '#opensubsonic/protocol.ts';
import type { HatContext } from '#opensubsonic/types.ts';

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
  if (
    ['replayGain', 'releaseDate', 'originalReleaseDate'].includes(tag) &&
    Object.keys(obj).length === 0
  ) return '';
  let attrs = '';
  let children = '';
  let text: string | null = null;
  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) continue;
    // Navidrome's H7 optional attributes use omitempty on XML, while JSON
    // reports supported fields even without data. ReplayGain zero is real.
    if (
      [
        'bitRate',
        'bitDepth',
        'samplingRate',
        'channelCount',
        'discNumber',
        'bpm',
        'comment',
        'sortName',
        'musicBrainzId',
        'explicitStatus',
        'version',
        'isCompilation',
      ].includes(key) && (val === '' || val === 0 || val === false)
    ) continue;
    if (key === 'value' && isScalar(val) && tag !== 'cueLine') {
      text = String(val);
      continue;
    }
    // ArtistInfoBase fields are XML elements, not the catalog DTO attributes
    // (Navidrome responses.go:420-436). Applies to both info projections.
    if ((tag === 'artistInfo' || tag === 'artistInfo2') && isScalar(val)) {
      children += xmlElement(key, val);
      continue;
    }
    if (isScalar(val)) attrs += ` ${key}="${escapeXml(String(val))}"`;
    else {children += xmlElement(
        tag === 'structuredLyrics' && key === 'agents' ? 'agent' : key,
        val,
      );}
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
  const format = context.state.format ?? plainFormat(context.state.params);
  if (format.type === 'json') {
    return Response.json({ 'subsonic-response': envelope }, { status });
  }
  if (format.type === 'jsonp') {
    // U+2028/U+2029 are valid JSON but line terminators in older JS parsers.
    const json = JSON.stringify({ 'subsonic-response': envelope })
      .replaceAll('\u2028', '\\u2028')
      .replaceAll('\u2029', '\\u2029');
    return new Response(`${format.callback}(${json})`, {
      status,
      headers: {
        'content-type': 'application/javascript',
        'x-content-type-options': 'nosniff',
      },
    });
  }
  // The XML envelope carries the Subsonic namespace (Navidrome/Subsonic
  // always send it; strict namespace-aware parsers find nothing without it).
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${
    xmlElement('subsonic-response', {
      xmlns: 'http://subsonic.org/restapi',
      ...envelope,
    })
  }`;
  // Binary operations document their XML errors as text/xml.
  const binary = BINARY_OPERATIONS.has(context.state.operation ?? '');
  return new Response(xml, {
    status,
    headers: {
      'content-type': binary
        ? 'text/xml; charset=utf-8'
        : 'application/xml; charset=utf-8',
    },
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
