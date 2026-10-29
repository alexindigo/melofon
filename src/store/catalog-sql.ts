import { esc } from './engine.ts';

// Generic sorting policy: the caller supplies articles, core owns the key.
// Unoptioned callers retain binary ordering; [] folds without stripping.
export function sortKeySql(
  column: string,
  articles?: string[],
  tag?: string,
): string {
  if (tag !== undefined) {
    return `CASE WHEN nullif(trim(${tag}), '') IS NOT NULL THEN ${
      sortKeySql(tag, articles === undefined ? undefined : [])
    } ELSE ${sortKeySql(column, articles)} END`;
  }
  if (articles === undefined) return column;
  const folded = `trim(strip_accents(${column}))`;
  const branches = articles.map((article) =>
    `WHEN starts_with(${folded}, ${
      esc(article + ' ')
    }) THEN substring(${folded}, length(${esc(article)}) + 2)`
  );
  const stripped = branches.length === 0
    ? folded
    : `CASE ${branches.join(' ')} ELSE ${folded} END`;
  return `lower(trim(${stripped}))`;
}

// Source membership (musicFolderId) of a catalog id, one owner for every
// folder-scoped read: a song's file is in the source, an album has a file in
// it, an artist has an album with a file in it. `idSql` is the SQL
// expression holding the id. Core services outside this module (favourites)
// scope through the same predicates.
export const folderMembership = {
  song: (idSql: string, folderId: string): string =>
    `EXISTS (
       SELECT 1 FROM files ff
       WHERE ff.id = ${idSql} AND ff.library_id = ${esc(folderId)}
     )`,
  album: (idSql: string, folderId: string): string =>
    `EXISTS (
       SELECT 1 FROM files ff
       WHERE ff.album_id = ${idSql} AND ff.library_id = ${esc(folderId)}
     )`,
  artist: (idSql: string, folderId: string): string =>
    `EXISTS (
       SELECT 1 FROM albums af JOIN files ff ON ff.album_id = af.id
       WHERE af.album_artist_id = ${idSql}
         AND ff.library_id = ${esc(folderId)}
     )`,
};

// Artist rows joined to their albums (`al`), limited to albums with a file in
// this source: the artist appears when it has one, and its album count covers
// only that source's albums (Navidrome's per-library artist stats).
export function artistAlbumFolderFilter(folderId?: string): string {
  return folderId === undefined
    ? ''
    : ` AND ${folderMembership.album('al.id', folderId)}`;
}
