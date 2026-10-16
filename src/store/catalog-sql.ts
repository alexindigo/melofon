import { esc } from './engine.ts';

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

// Artists limited to those with an album that has a file in this source.
export function artistFolderFilter(folderId?: string): string {
  return folderId === undefined
    ? ''
    : ` AND ${folderMembership.artist('ar.id', folderId)}`;
}
