// layers/opensubsonic/00-subsonic.ts — the opensubsonic hat's shared module:
// Subsonic envelope (ok/failed, XML+JSON), merged query+form params, the op
// dispatch table, and the hat's structural types. This file is a pathfinder
// middleware by filename grammar (the layer folder is the tree root — a plain
// `subsonic.ts` would silently compile as a `SUBSONIC /` route, and any other
// name is a build error). The default export is a no-op; the named exports
// are the module. See m1-scan-stream/plan-amendment-1.md.

export default () => {};

// --- Structural types (the hat is self-sufficient: no src/ imports) ----------

export interface StateUser {
  username: string;
  displayName: string;
}

export interface HatRequest {
  params: Record<string, string>;
  query: URLSearchParams;
  method: string;
  headers: Headers;
  body: {
    form(): Promise<FormData>;
  };
}

export interface HatContext {
  app: {
    cfg: {
      version?: string;
    };
    user: {
      auth(username: string, password: string): Promise<StateUser | null>;
      authMd5(
        username: string,
        token: string,
        salt: string,
      ): Promise<StateUser | null>;
    };
  };
  state: {
    user?: StateUser;
    params?: URLSearchParams;
  };
}

// --- Params ------------------------------------------------------------------

// Merged request params, Navidrome's postFormToQueryParams model: form body
// first (wins), query string appended after. Credentials and op args arrive
// identically via GET query or POST form.
export async function params(request: HatRequest): Promise<URLSearchParams> {
  const merged = new URLSearchParams();
  if (request.method === 'POST') {
    const contentType = request.headers.get('content-type') ?? '';
    if (contentType.startsWith('application/x-www-form-urlencoded')) {
      const form = await request.body.form();
      for (const [key, value] of form) {
        if (typeof value === 'string') merged.append(key, value);
      }
    }
  }
  for (const [key, value] of request.query) merged.append(key, value);
  return merged;
}

// `op` arrives without `.view` when the #op.view pattern matched, but the
// bare #op pattern captures the whole segment — which pattern wins depends on
// route registration order (pathfinder's fs walk is unsorted). Normalizing
// here makes dispatch correct under either order.
export function normalizeOp(op: string): string {
  return op.endsWith('.view') ? op.slice(0, -'.view'.length) : op;
}

// --- Envelope ----------------------------------------------------------------

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
// `album`, `song` all name their items after the key).
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
  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) continue;
    if (isScalar(val)) attrs += ` ${key}="${escapeXml(String(val))}"`;
    else children += xmlElement(key, val);
  }
  return children === ''
    ? `<${tag}${attrs}/>`
    : `<${tag}${attrs}>${children}</${tag}>`;
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
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${
    xmlElement('subsonic-response', envelope)
  }`;
  return new Response(xml, {
    status,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}

export function okResponse(
  context: HatContext,
  payload: Record<string, unknown>,
): Response {
  return render(context, { ...base(context), ...payload }, 200);
}

// Subsonic errors ship in the envelope, Navidrome-style: HTTP 200 with
// status="failed" (auth failures, missing params). Outcome pages (404/500)
// pass their own HTTP status.
export function failResponse(
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

export function hexDecode(hex: string): string {
  if (!/^([0-9a-fA-F]{2})*$/.test(hex)) throw new Error('bad hex');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

// --- Op dispatch ---------------------------------------------------------------

type OpHandler = (
  request: HatRequest,
  context: HatContext,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

const OPS: Record<string, OpHandler> = {
  ping: () => ({}),
  getLicense: () => ({ license: { valid: true } }),
};

export async function dispatch(
  op: string,
  request: HatRequest,
  context: HatContext,
): Promise<Response> {
  const handler = OPS[op];
  if (handler === undefined) {
    return failResponse(context, 0, `Not implemented: ${op}`);
  }
  return okResponse(context, await handler(request, context));
}
