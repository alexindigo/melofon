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

async function browsePaging(params: URLSearchParams, context: HatContext) {
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
    offset: browseInteger(params, 'offset', 0, 0),
    limit: browseInteger(params, 'limit', Math.min(defaultLimit, max), 1, max),
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
    'fromYear',
    'toYear',
  ]);
  const sort = params.get('sort') ?? 'name';
  if (!['name', 'artist', 'year', 'newest', 'genre'].includes(sort)) {
    fail(400, 'invalid_field', 'Invalid sort');
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
