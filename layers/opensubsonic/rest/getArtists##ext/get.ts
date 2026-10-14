// layers/opensubsonic/rest/getArtists/get.ts — GET /rest/getArtists: the ID3
// index of album artists.
import { ok } from '#opensubsonic/envelope.ts';
import { artistId3Of, IGNORED_ARTICLES, indexName } from '#opensubsonic/id3.ts';
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
    list.push(artistId3Of(artist, p));
    byIndex.set(name, list);
  }
  const names = [...byIndex.keys()].sort((a, b) =>
    a === '#' ? -1 : b === '#' ? 1 : a.localeCompare(b)
  );
  return ok(context, {
    artists: {
      ignoredArticles: IGNORED_ARTICLES,
      index: names.map((name) => ({ name, artist: byIndex.get(name)! })),
    },
  });
};
