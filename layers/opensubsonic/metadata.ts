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
  };
}

export function albumMetadataFields(album: AlbumRow): Record<string, unknown> {
  const m = album.metadata;
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
  };
}
