import type { FolderRow, HatContext, HatRequest } from '#melofon/types.ts';
import { folderPageQuery } from '#melofon/browse.ts';
import { songDetail } from '#melofon/browse-payloads.ts';
import { catalogResponse } from '#melofon/cache.ts';
import { core } from '#melofon/errors.ts';

function folderSummary(folder: FolderRow) {
  return { libraryId: folder.libraryId, path: folder.path, name: folder.name };
}

export default async function (request: HatRequest, context: HatContext) {
  const query = await folderPageQuery(request, context);
  const pages = await core(() => context.app.folders.browse(query));
  return catalogResponse(request, pages.revision, ['folders', 1, query], {
    folder: pages.folder === null ? null : folderSummary(pages.folder),
    folders: {
      folders: pages.folders.rows.map(folderSummary),
      total: pages.folders.total,
      ...query.folders,
    },
    songs: {
      songs: pages.songs.rows.map(songDetail),
      total: pages.songs.total,
      ...query.songs,
    },
  });
}
