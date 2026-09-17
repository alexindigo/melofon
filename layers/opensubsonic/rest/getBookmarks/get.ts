// layers/opensubsonic/rest/getBookmarks/get.ts — GET /rest/getBookmarks.
import { ok } from '#opensubsonic/envelope.ts';
import { childOf } from '#opensubsonic/id3.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const username = context.state.user!.username;
  const rows = await context.app.bookmarks.list(username);
  const bookmarks: Record<string, unknown>[] = [];
  for (const row of rows) {
    const song = await context.app.library.getSong(row.trackId);
    if (song === null) continue; // starred-then-removed track — skip
    bookmarks.push({
      entry: childOf(song),
      position: row.positionMs,
      username,
      comment: row.comment ?? undefined,
      created: new Date(row.createdAtMs).toISOString(),
      changed: new Date(row.changedAtMs).toISOString(),
    });
  }
  return ok(context, { bookmarks: { bookmark: bookmarks } });
};
