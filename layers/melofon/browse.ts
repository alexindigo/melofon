import type {
  ArtistPageOptions,
  BrowsePageOptions,
  HatContext,
  HatRequest,
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
  return {
    // a20 replaces [] with the shared core article setting; fold without stripping.
    ignoredArticles: [],
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
  ]);
  const { folderId, ignoredArticles, ...artists } = await browsePaging(
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
    artists,
    albums: { offset: albumPage.offset, limit: albumPage.limit },
    songs: { offset: songPage.offset, limit: songPage.limit },
  };
}

export async function namePageQuery(
  request: HatRequest,
  context: HatContext,
): Promise<ArtistPageOptions> {
  const params = browseQuery(request, ['library', 'offset', 'limit', 'sort']);
  if ((params.get('sort') ?? 'name') !== 'name') {
    fail(400, 'invalid_field', 'Invalid sort');
  }
  return await browsePaging(params, context);
}

export async function browsePageQuery(
  request: HatRequest,
  context: HatContext,
): Promise<BrowsePageOptions> {
  const params = browseQuery(request, [
    'library',
    'offset',
    'limit',
    'sort',
    'genre',
    'seed',
    'fromYear',
    'toYear',
  ]);
  const sort = params.get('sort') ?? 'name';
  if (!['name', 'artist', 'year', 'newest', 'genre', 'random'].includes(sort)) {
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
    sort: sort as BrowsePageOptions['sort'],
    seed,
    ...await browsePaging(params, context),
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
