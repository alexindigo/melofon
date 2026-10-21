// Reference wire projection only: core owns matching, history and radio mixing.
import { notFound, ok } from '#opensubsonic/envelope.ts';
import {
  artistId3Of,
  artistOf,
  entriesFor,
  resolveArtist,
} from '#opensubsonic/id3.ts';
import {
  optionalBool,
  requiredParam,
  safeIntegerParam,
} from '#opensubsonic/params.ts';
import { loadPersonal } from '#opensubsonic/personal.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

const countParam = (context: HatContext, fallback: number) =>
  Math.max(0, safeIntegerParam(context.state.params!.get('count')) ?? fallback);

// Navidrome browsing.go:351-383; spec getsimilarsongs*.md:19-21.
export async function similarSongs(context: HatContext, key: string) {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const max = safeIntegerParam(
    await context.app.state.get('opensubsonic.similarSongsMax'),
  ) ?? 500;
  const ids = await context.app.reference.radio(
    id,
    Math.min(max, countParam(context, 50)),
    context.state.user!.username,
  );
  return ids === null
    ? notFound(context)
    : ok(context, { [key]: { song: await entriesFor(context, ids) } });
}

export async function topSongs(context: HatContext) {
  const params = context.state.params!;
  const id = params.get('id') || undefined;
  const name = id ? undefined : requiredParam(context, 'artist');
  if (name instanceof Response) return name;
  const artistId = id ?? await context.app.reference.artistByName(name!);
  const ids = artistId
    ? await context.app.reference.topTracks(
      artistId,
      countParam(context, 50),
      context.state.user!.username,
    )
    : [];
  return ok(context, { topSongs: { song: await entriesFor(context, ids) } });
}

// Keep only authentication/protocol arguments, including merged POST credentials.
function imageUrl(
  request: HatRequest,
  context: HatContext,
  id: string,
  size: number,
) {
  const url = new URL('/rest/getCoverArt', request._raw.url);
  for (const key of ['u', 'p', 't', 's', 'v', 'c']) {
    const value = context.state.params!.get(key);
    if (value !== null) url.searchParams.set(key, value);
  }
  url.searchParams.set('id', id);
  url.searchParams.set('size', String(size));
  return url.href;
}

export async function artistInfo(
  request: HatRequest,
  context: HatContext,
  id3: boolean,
) {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const key = id3 ? 'artistInfo2' : 'artistInfo';
  const album = await context.app.library.getAlbum(id);
  const song = album ? null : await context.app.library.getSong(id);
  const artistId = album ? album.album.artistId : song ? song.artistId : id;
  if (artistId === null) return ok(context, { [key]: {} });
  const resolved = await resolveArtist(context, artistId);
  if (!resolved) return notFound(context);
  const artist = await context.app.library.artistById(artistId);
  // Protocol-only placeholders have no stored artist and never trigger lookups.
  if (!artist) return ok(context, { [key]: {} });
  const values = await context.app.reference.get('artist', artistId, [
    'artist.biography',
    'artist.url',
    'artist.id.mbid',
  ]);
  const count = countParam(context, 20);
  const include =
    optionalBool(context.state.params!.get('includeNotPresent')) ?? false;
  const related = await context.app.reference.similarArtists(
    artistId,
    include ? Number.MAX_SAFE_INTEGER : count,
    !include,
  );
  const present = [];
  for (const a of related) {
    if (!a.present) continue;
    const row = await context.app.library.artistById(a.id);
    if (row) present.push(row);
  }
  const personal = await loadPersonal(context, {
    artists: present.map((a) => a.id),
  });
  const build = id3 ? artistId3Of : artistOf;
  const similar = present.map((a) => build(a, personal));
  if (include) {
    for (const a of related) {
      if (!a.present) {
        similar.push({
          id: '-1',
          name: a.name,
          ...(id3 ? { albumCount: 0, musicBrainzId: a.mbid ?? '' } : {}),
        });
      }
    }
  }
  // Navidrome browsing.go:298-306,321-345. No external image URLs or album stand-ins.
  const hasPhoto = await context.app.artwork.hasArtistPhoto(artistId);
  return ok(context, {
    [key]: {
      biography: values['artist.biography']?.text,
      musicBrainzId: artist.musicBrainzId ?? values['artist.id.mbid'],
      lastFmUrl: values['artist.url']?.url,
      ...(hasPhoto
        ? {
          smallImageUrl: imageUrl(request, context, artistId, 300),
          mediumImageUrl: imageUrl(request, context, artistId, 600),
          largeImageUrl: imageUrl(request, context, artistId, 1200),
        }
        : {}),
      ...(similar.length && count
        ? { similarArtist: similar.slice(0, count) }
        : {}),
    },
  });
}
