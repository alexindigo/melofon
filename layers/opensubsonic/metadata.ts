// Wire projection only; facts and album aggregation belong to core.
import type { AlbumRow, SongRow } from '#opensubsonic/types.ts';
import { integerParam } from '#opensubsonic/params.ts';

function itemDate(value: string | null | undefined): Record<string, number> {
  if (!value) return {};
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:T.*)?$/.exec(value);
  if (!match) return {};
  const year = integerParam(match[1]);
  const month = integerParam(match[2] ?? null);
  const day = integerParam(match[3] ?? null);
  if (year === null || year <= 0) return {};
  const result: Record<string, number> = {};
  result.year = year;
  if (month !== null && month >= 1 && month <= 12) {
    result.month = month;
  }
  if (
    day !== null && result.month && day >= 1 &&
    day <=
      new Date(Date.UTC(result.year, result.month, 0)).getUTCDate()
  ) result.day = day;
  return result;
}

export function songMetadataFields(song: SongRow): Record<string, unknown> {
  const m = song.metadata;
  const details = m?.tagDetails;
  const credits = details?.credits ?? [];
  const artists = credits.filter(({ role }) => role === 'artist').map((
    { artist },
  ) => artist);
  const albumArtists = credits.filter(({ role }) => role === 'albumartist').map(
    ({ artist }) => artist,
  );
  const replayGain = Object.fromEntries(
    (['trackGain', 'albumGain', 'trackPeak', 'albumPeak', 'baseGain'] as const)
      .flatMap((key) => m?.[key] == null ? [] : [[key, m[key]]]),
  );
  return {
    bitRate: Math.round(m?.bitRate ?? 0),
    bitDepth: m?.bitDepth ?? 0,
    samplingRate: m?.sampleRate ?? 0,
    channelCount: m?.channels ?? 0,
    discNumber: song.disc ?? 0,
    mediaType: 'song',
    musicBrainzId: m?.recordingMbid ?? '',
    isrc: m?.isrc ?? [],
    genres: (m?.genres ?? (song.genre ? [song.genre] : [])).map((name) => ({
      name,
    })),
    moods: m?.moods ?? [],
    comment: m?.comment ?? '',
    sortName: m?.sortTitle ?? '',
    bpm: m?.bpm ?? 0,
    explicitStatus: m?.explicit ?? '',
    replayGain,
    artists: artists.length
      ? artists
      : song.artistId && song.artistName
      ? [{ id: song.artistId, name: song.artistName }]
      : [],
    displayArtist: details?.displayArtist ?? song.artistName ?? '',
    albumArtists,
    displayAlbumArtist: details?.displayAlbumArtist ??
      albumArtists.map(({ name }) => name).join(', '),
    contributors: credits.filter(({ role }) =>
      role !== 'artist' && role !== 'albumartist'
    ),
    displayComposer: details?.displayComposer ?? '',
    works: details?.works ?? [],
    movements: details?.movements ?? [],
    groupings: details?.groupings ?? [],
    originalWidth: song.isVideo ? m?.videoWidth ?? undefined : undefined,
    originalHeight: song.isVideo ? m?.videoHeight ?? undefined : undefined,
  };
}

export function albumMetadataFields(album: AlbumRow): Record<string, unknown> {
  const m = album.metadata;
  const details = m?.artistDetails;
  const artists = details?.artists.length
    ? details.artists
    : album.artistId && album.artistName
    ? [{ id: album.artistId, name: album.artistName }]
    : [];
  return {
    musicBrainzId: m?.musicBrainzId ?? '',
    genre: m?.genres?.[0] ?? undefined,
    recordLabels: (m?.recordLabels ?? []).map((name) => ({ name })),
    releaseTypes: m?.releaseTypes ?? [],
    genres: (m?.genres ?? []).map((name) => ({ name })),
    moods: m?.moods ?? [],
    releaseDate: itemDate(m?.releaseDate),
    originalReleaseDate: itemDate(m?.originalReleaseDate),
    isCompilation: m?.compilation ?? false,
    version: m?.version ?? '',
    sortName: m?.sortName ?? '',
    explicitStatus: m?.explicit ?? '',
    discTitles: m?.discTitles ?? [],
    artists,
    displayArtist: details?.displayArtist ?? album.artistName ??
      artists.map(({ name }) => name).join(', '),
  };
}
