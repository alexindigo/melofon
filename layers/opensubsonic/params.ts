// layers/opensubsonic/params.ts — request params: merged query+form, typed
// getters, the required-param failure, and the musicFolderId wire-int
// mapping. Shared module at the layer root, outside the walked mount tree.
import { fail } from '#opensubsonic/envelope.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

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

export function intParam(
  params: URLSearchParams,
  name: string,
  fallback: number,
): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return fallback;
  return value;
}

export function requiredParam(
  context: HatContext,
  name: string,
): string | Response {
  const value = context.state.params?.get(name);
  if (value === null || value === undefined || value === '') {
    return fail(context, 10, 'Required parameter is missing');
  }
  return value;
}

// Presence is distinct from content for search3's required empty sync query.
// Other required arguments retain requiredParam's nonempty contract.
export function presentParam(
  context: HatContext,
  name: string,
): string | Response {
  const params = context.state.params;
  return params?.has(name)
    ? params.get(name)!
    : fail(context, 10, 'Required parameter is missing');
}

export function safeIntParam(
  params: URLSearchParams,
  name: string,
  fallback: number,
): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

// These documented limits belong to the wire, never whole-catalog core calls.
export function boundedCountParam(
  params: URLSearchParams,
  name: string,
): number {
  return Math.min(500, safeIntParam(params, name, 10));
}

export function yearParam(
  context: HatContext,
  name: string,
): number | undefined | Response {
  const raw = context.state.params!.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  return raw.trim() !== '' && Number.isSafeInteger(value)
    ? value
    : fail(context, 10, `${name} must be a finite safe integer year`);
}

export function hexDecode(hex: string): string {
  if (!/^([0-9a-fA-F]{2})*$/.test(hex)) throw new Error('bad hex');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

// The spec types musicFolder.id and user.folder as int (OpenSubsonic type
// tables); melofon's storage ids are stable content hashes. The hat maps
// deterministically at the wire boundary: the same int in getMusicFolders,
// getUser.folder, and accepted back in musicFolderId. Deriving from the hash
// (not list position) keeps wire ids stable across source add/remove.
export function folderWireId(id: string): number {
  return Number(BigInt(`0x${id.slice(0, 8)}`) & 0x7fffffffn);
}

// musicFolderId arrives as the wire int; resolve to the storage hash. A
// non-integer value passes through unchanged (a stale client holding a hash);
// an unmatched int stays unmatched (empty results, Navidrome-like).
export async function folderIdParam(
  context: HatContext,
): Promise<string | undefined> {
  const raw = context.state.params!.get('musicFolderId');
  if (raw === null || raw === '') return undefined;
  if (!/^\d+$/.test(raw)) return raw;
  const n = Number(raw);
  const folders = await context.app.libraries.list();
  return (folders.find((f) => folderWireId(f.id) === n) ?? { id: raw }).id;
}
