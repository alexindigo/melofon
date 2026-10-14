// layers/opensubsonic/rest/getBookmarks/get.ts — GET /rest/getBookmarks.
import { ok } from '#opensubsonic/envelope.ts';
import { childOf } from '#opensubsonic/id3.ts';
import { loadPersonal } from '#opensubsonic/personal.ts';
import type {
  BookmarkRow,
  HatContext,
  HatRequest,
  SongRow,
} from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const username = context.state.user!.username;
  const rows = await context.app.bookmarks.list(username);
  const resolved: { row: BookmarkRow; song: SongRow }[] = [];
  for (const row of rows) {
    const song = await context.app.library.getSong(row.trackId);
    if (song === null) continue; // bookmarked-then-removed track — skip
    resolved.push({ row, song });
  }
  const p = await loadPersonal(context, {
    songs: resolved.map(({ song }) => song.id),
  });
  const bookmarks = resolved.map(({ row, song }) => ({
    entry: childOf(song, p),
    position: row.positionMs,
    username,
    comment: row.comment ?? undefined,
    created: new Date(row.createdAtMs).toISOString(),
    changed: new Date(row.changedAtMs).toISOString(),
  }));
  return ok(context, { bookmarks: { bookmark: bookmarks } });
};
