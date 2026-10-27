// Pinned spec Endpoints/{create,get,update,delete}share.md; Navidrome
// 18205366 server/subsonic/sharing.go:33-53 supplies album-vs-track entries.
import { fail } from '#opensubsonic/envelope.ts';
import { albumV1Of, childOf } from '#opensubsonic/id3.ts';
import { loadPersonal } from '#opensubsonic/personal.ts';
import { safeIntegerParam } from '#opensubsonic/params.ts';
import type {
  HatContext,
  HatRequest,
  ShareOptions,
  ShareRow,
} from '#opensubsonic/types.ts';

export const shareForbidden = (context: HatContext) =>
  fail(context, 50, 'User is not authorized for the given operation');
export async function requireSharing(
  context: HatContext,
): Promise<Response | null> {
  return await context.app.shares.enabled() ? null : shareForbidden(context);
}
export function shareOptions(context: HatContext): ShareOptions | Response {
  const p = context.state.params!;
  const result: ShareOptions = {};
  if (p.has('description')) result.description = p.get('description')!;
  if (p.has('expires')) {
    const expires = safeIntegerParam(p.get('expires'));
    if (expires === null || !Number.isFinite(new Date(expires).getTime())) {
      return fail(context, 10, 'Invalid share expiration');
    }
    result.expires = expires;
  }
  return result;
}
export async function shareOf(
  request: HatRequest,
  context: HatContext,
  share: ShareRow,
) {
  const { albums, tracks } = await context.app.shares.contents(share);
  const personal = await loadPersonal(context, {
    albums: albums.map((a) => a.id),
    songs: tracks.map((s) => s.id),
  });
  const base = await context.app.shares.publicUrl();
  const path = `/share/${share.id}`;
  return {
    id: share.id,
    url: base
      ? `${base}${path}`
      : await context.app.publicAddress.full(request._raw, path),
    description: share.description,
    username: share.owner,
    created: new Date(share.createdAtMs).toISOString(),
    expires: share.expiresAtMs === null
      ? undefined
      : new Date(share.expiresAtMs).toISOString(),
    lastVisited: share.lastVisitedAtMs === null
      ? undefined
      : new Date(share.lastVisitedAtMs).toISOString(),
    visitCount: share.visitCount,
    entry: share.resourceType === 'album' || share.resourceType === 'artist'
      ? albums.map((a) => albumV1Of(a, personal))
      : tracks.map((s) => childOf(s, personal)),
  };
}
