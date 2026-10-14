// layers/opensubsonic/rest/getIndexes/get.ts — GET /rest/getIndexes.
// Simulated browse-by-folder (Navidrome: "no plans to support
// browse-by-folder… returns a simulated directory tree, using the format
// /Artist/Album/01 - Song.mp3"). There is no folders table: top-level
// directories are the album artists (same set as getArtists), directory
// ids borrow the real artist/album ids. Songs with no album tag are not
// in the tree (no Album dir to hang them under) — they stay reachable via
// search3/getSong/stream. No shortcuts, no top-level child elements.
import { ok } from '#opensubsonic/envelope.ts';
import { artistOf, IGNORED_ARTICLES, indexName } from '#opensubsonic/id3.ts';
import { folderIdParam } from '#opensubsonic/params.ts';
import { loadPersonal } from '#opensubsonic/personal.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const folderId = await folderIdParam(context);
  const artists = await context.app.library.listArtists(folderId);
  const p = await loadPersonal(context, {
    artists: artists.map((artist) => artist.id),
  });
  const byIndex = new Map<string, Record<string, unknown>[]>();
  for (const artist of artists) {
    const name = indexName(artist.name);
    const list = byIndex.get(name) ?? [];
    list.push(artistOf(artist, p));
    byIndex.set(name, list);
  }
  const names = [...byIndex.keys()].sort((a, b) =>
    a === '#' ? -1 : b === '#' ? 1 : a.localeCompare(b)
  );
  // Required by the OpenSubsonic schema: last time the index was modified,
  // epoch milliseconds (Navidrome answers the last scan time too).
  const scan = await context.app.scan.status();
  return ok(context, {
    indexes: {
      ignoredArticles: IGNORED_ARTICLES,
      lastModified: scan.lastScanMs ?? 0,
      index: names.map((name) => ({ name, artist: byIndex.get(name)! })),
    },
  });
};
