import type {
  AlbumPageOptions,
  ArtistPageOptions,
  BrowsePageOptions,
  HatContext,
  HatRequest,
  PlaylistPageOptions,
  SongRow,
} from './types.ts';
import { fail } from './errors.ts';

/** Each browse route opts into its query vocabulary; duplicates never win. */
export function browseQuery(request: HatRequest, allowed: string[] = []) {
  const params = new URL(request._raw.url).searchParams;
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) {
      fail(400, 'invalid_field', 'Unknown or repeated browse parameter');
    }
  }
  return params;
}

export function browseInteger(
  params: URLSearchParams,
  key: string,
  fallback: number,
  min: number,
  max = 9007199254740991,
): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (
    !/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min ||
    value > max
  ) {
    fail(400, 'invalid_field', `Invalid ${key}`);
  }
  return value;
}

export function browseLibrary(params: URLSearchParams): string | undefined {
  const library = params.get('library');
  if (library === '') fail(400, 'invalid_field', 'Invalid library');
  return library ?? undefined;
}

function naturalOption(params: URLSearchParams): { natural?: boolean } {
  const raw = params.get('natural');
  if (raw === null) return {};
  if (raw !== 'true' && raw !== 'false') {
    fail(400, 'invalid_field', 'Invalid natural');
  }
  return { natural: raw === 'true' };
}

async function browsePaging(
  params: URLSearchParams,
  context: HatContext,
  category = '',
) {
  const max = Number(
    await context.app.state.getTyped('melofon.browseMaxPageRecords'),
  );
  const defaultLimit = Number(
    await context.app.state.getTyped('melofon.browsePageRecords'),
  );
  const order = await context.app.library.order();
  return {
    ignoredArticles: order.ignoredArticles,
    articleRevision: order.revision,
    folderId: browseLibrary(params),
    offset: browseInteger(
      params,
      category ? `${category}Offset` : 'offset',
      0,
      0,
    ),
    limit: browseInteger(
      params,
      category ? `${category}Limit` : 'limit',
      Math.min(defaultLimit, max),
      1,
      max,
    ),
  };
}

export async function searchPageQuery(
  request: HatRequest,
  context: HatContext,
) {
  const params = browseQuery(request, [
    'query',
    'library',
    'artistOffset',
    'artistLimit',
    'albumOffset',
    'albumLimit',
    'songOffset',
    'songLimit',
    'natural',
  ]);
  const { folderId, ignoredArticles, articleRevision, ...artists } =
    await browsePaging(
      params,
      context,
      'artist',
    );
  const albumPage = await browsePaging(params, context, 'album');
  const songPage = await browsePaging(params, context, 'song');
  return {
    query: params.get('query') ?? '',
    folderId,
    ignoredArticles,
    articleRevision,
    ...naturalOption(params),
    artists,
    albums: { offset: albumPage.offset, limit: albumPage.limit },
    songs: { offset: songPage.offset, limit: songPage.limit },
  };
}

export async function folderPageQuery(
  request: HatRequest,
  context: HatContext,
) {
  const params = browseQuery(request, [
    'library',
    'path',
    'folderOffset',
    'folderLimit',
    'songOffset',
    'songLimit',
  ]);
  const { folderId, ignoredArticles, articleRevision, offset, limit } =
    await browsePaging(
      params,
      context,
      'folder',
    );
  const songPage = await browsePaging(params, context, 'song');
  return {
    libraryId: folderId,
    path: params.get('path') ?? '',
    ignoredArticles,
    articleRevision,
    folders: { offset, limit },
    songs: { offset: songPage.offset, limit: songPage.limit },
  };
}

export async function namePageQuery(
  request: HatRequest,
  context: HatContext,
): Promise<ArtistPageOptions> {
  const params = browseQuery(request, [
    'library',
    'offset',
    'limit',
    'sort',
    'natural',
  ]);
  if ((params.get('sort') ?? 'name') !== 'name') {
    fail(400, 'invalid_field', 'Invalid sort');
  }
  return { ...await browsePaging(params, context), ...naturalOption(params) };
}

export async function playlistPageQuery(
  request: HatRequest,
  context: HatContext,
): Promise<PlaylistPageOptions> {
  const params = browseQuery(request, ['offset', 'limit', 'sort']);
  if ((params.get('sort') ?? 'name') !== 'name') {
    fail(400, 'invalid_field', 'Invalid sort');
  }
  const { offset, limit, ignoredArticles, articleRevision } =
    await browsePaging(
      params,
      context,
    );
  return { offset, limit, ignoredArticles, articleRevision };
}

export function personalAlbumSort(sort: string): boolean {
  return ['starred', 'highest', 'frequent', 'recent'].includes(sort);
}

export function browsePageQuery(
  request: HatRequest,
  context: HatContext,
  collection: 'albums',
): Promise<AlbumPageOptions>;
export function browsePageQuery(
  request: HatRequest,
  context: HatContext,
): Promise<BrowsePageOptions>;
export async function browsePageQuery(
  request: HatRequest,
  context: HatContext,
  collection?: 'albums',
): Promise<AlbumPageOptions> {
  const params = browseQuery(request, [
    'library',
    'offset',
    'limit',
    'sort',
    'genre',
    'seed',
    'fromYear',
    'toYear',
    'natural',
  ]);
  const sort = params.get('sort') ?? 'name';
  const personal = collection === 'albums' && personalAlbumSort(sort);
  if (
    !personal &&
    !['name', 'artist', 'year', 'newest', 'genre', 'random'].includes(sort)
  ) {
    fail(400, 'invalid_field', 'Invalid sort');
  }
  const seed = params.get('seed') ?? undefined;
  if (
    sort === 'random' ? seed === undefined || seed === '' : seed !== undefined
  ) {
    fail(400, 'invalid_field', 'Seed is required only for random sort');
  }
  const genre = params.get('genre') ?? undefined;
  if (genre === '' || (sort === 'genre' && genre === undefined)) {
    fail(400, 'invalid_field', 'Genre is required');
  }
  const fromYear = params.has('fromYear')
    ? browseInteger(params, 'fromYear', 0, 0)
    : undefined;
  const toYear = params.has('toYear')
    ? browseInteger(params, 'toYear', 0, 0)
    : undefined;
  if (fromYear !== undefined && toYear !== undefined && fromYear > toYear) {
    fail(400, 'invalid_field', 'Invalid year range');
  }
  return {
    sort: sort as AlbumPageOptions['sort'],
    ...(personal ? { username: context.state.user.username } : {}),
    seed,
    ...await browsePaging(params, context),
    ...naturalOption(params),
    genre,
    fromYear,
    toYear,
  };
}

export async function requireSong(
  context: HatContext,
  id: string,
): Promise<SongRow> {
  const song = await context.app.library.getSong(id);
  if (song === null) fail(404, 'not_found', 'Song not found');
  return song;
}
