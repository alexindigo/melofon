import type { HatContext, HatRequest, SongRow } from './types.ts';
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

export async function requireSong(
  context: HatContext,
  id: string,
): Promise<SongRow> {
  const song = await context.app.library.getSong(id);
  if (song === null) fail(404, 'not_found', 'Song not found');
  return song;
}
