// layers/opensubsonic/protocol.ts — plugin-private common-protocol facts:
// the implemented protocol version and client-version compatibility, the
// response format (xml/json/jsonp) and the routed operation name. Pure
// except for the injected setting read; no imports outside the plugin.
import type { ResponseFormat } from '#opensubsonic/types.ts';

/** The implemented protocol: reported in every envelope, checked against `v`. */
export const API_VERSION = '1.16.1';

/** Declared in manifest.json; only `on` enables JSONP, including with raw injected reads. */
export const JSONP_SETTING = 'opensubsonic.jsonp';

// Navidrome's callback rule: a JS identifier, optionally dotted.
const CALLBACK = /^[a-zA-Z_$][a-zA-Z0-9_$.]*$/;

// digits.digits[.digits…]; anything else is accepted without comparison.
const COMPARABLE = /^([0-9]+)\.([0-9]+)(?:\.[0-9]+)*$/;

// Exact decimal digit strings: huge components are never rounded through a
// binary64 conversion.
function compareDigits(a: string, b: string): number {
  const x = a.replace(/^0+(?=[0-9])/, '');
  const y = b.replace(/^0+(?=[0-9])/, '');
  if (x.length !== y.length) return x.length < y.length ? -1 : 1;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Major/minor compatibility; the patch part is ignored, with no minimum. */
export function checkVersion(
  client: string,
  server: string = API_VERSION,
): 'compatible' | 'client-old' | 'server-old' {
  const c = COMPARABLE.exec(client);
  const s = COMPARABLE.exec(server)!;
  if (c === null) return 'compatible';
  const major = compareDigits(c[1], s[1]);
  if (major < 0) return 'client-old';
  if (major > 0) return 'server-old';
  return compareDigits(c[2], s[2]) > 0 ? 'server-old' : 'compatible';
}

/** Error-envelope operations whose XML errors are `text/xml` (spec docs). */
export const BINARY_OPERATIONS: ReadonlySet<string> = new Set([
  'stream',
  'download',
  'getCoverArt',
  'getAvatar',
  'hls.m3u8',
]);

/** The routed operation: the repathed URL without its leading `/`, and
 * without `.view` only when the route captured exactly that suffix. */
export function operationName(
  pathname: string,
  ext: string | undefined,
): string {
  const name = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  return ext === '.view' && name.endsWith('.view') ? name.slice(0, -5) : name;
}

/** The synchronous json/xml choice (never JSONP) for unresolved requests. */
export function plainFormat(params?: URLSearchParams): ResponseFormat {
  return params?.get('f') === 'json' ? { type: 'json' } : { type: 'xml' };
}

/** `f` → format. The JSONP setting is read only for `f=jsonp`; when it is
 * off, jsonp is an unrecognized format (XML). When on, the callback must be
 * present and valid; errors are returned, never rendered here. */
export async function resolveFormat(
  params: URLSearchParams,
  setting: (key: string) => Promise<string | null>,
): Promise<
  ResponseFormat | { error: 'missing-callback' | 'invalid-callback' }
> {
  const f = params.get('f');
  if (f !== 'jsonp') return plainFormat(params);
  if (await setting(JSONP_SETTING) !== 'on') return { type: 'xml' };
  const callback = params.get('callback');
  if (callback === null) return { error: 'missing-callback' };
  if (!CALLBACK.test(callback)) return { error: 'invalid-callback' };
  return { type: 'jsonp', callback };
}
