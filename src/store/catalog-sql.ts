import { esc } from './engine.ts';

// Generic sorting policy: the caller supplies articles, core owns the key.
// Unoptioned callers retain binary ordering; [] folds without stripping.
export function sortKeySql(
  column: string,
  articles?: string[],
  tag?: string,
  natural = false,
): string {
  if (natural) {
    return naturalKeySql(sortKeySql(column, articles ?? [], tag));
  }
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

/** Locale-independent lexicographic token list, compared by DuckDB before LIMIT.
 * ASCII digit runs sort before text tokens. Numbers compare by significant
 * digit count then digits, never a bounded numeric cast or a padded string.
 * Leading zeros are insignificant; callers append the entity identity for ties.
 * Text must already have passed through the shared folding/article/tag policy.
 * NULL stays NULL, the empty string is an empty list, and punctuation/non-ASCII
 * digits are ordinary text (no signed-number or decimal interpretation).
 */
export function naturalKeySql(text: string): string {
  return `list_transform(regexp_extract_all(${text}, '[0-9]+|[^0-9]+'),
    token -> CASE WHEN regexp_full_match(token, '[0-9]+')
      THEN struct_pack(kind := 0, digits := length(ltrim(token, '0')), value := ltrim(token, '0'))
      ELSE struct_pack(kind := 1, digits := 0::BIGINT, value := token) END)`;
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
