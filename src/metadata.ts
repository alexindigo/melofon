// Catalog facts, independent of either protocol, database or tag-parser runtime.
import type { IAudioMetadata } from 'music-metadata';

export interface SongMetadata {
  bitRate: number | null;
  bitDepth: number | null;
  sampleRate: number | null;
  channels: number | null;
  trackGain: number | null;
  trackPeak: number | null;
  albumGain: number | null;
  albumPeak: number | null;
  baseGain: number | null;
  recordingMbid: string | null;
  artistMbid: string | null;
  albumArtistMbid: string | null;
  isrc: string[];
  genres: string[];
  moods: string[];
  comment: string | null;
  sortTitle: string | null;
  artistSortName: string | null;
  albumArtistSortName: string | null;
  bpm: number | null;
  explicit: 'explicit' | 'clean' | null;
  discSubtitle: string | null;
  albumMbid: string | null;
  recordLabels: string[];
  releaseTypes: string[];
  releaseDate: string | null;
  originalReleaseDate: string | null;
  compilation: boolean;
  version: string | null;
  albumSortName: string | null;
}

export interface AlbumMetadata {
  musicBrainzId: string | null;
  recordLabels: string[];
  releaseTypes: string[];
  genres: string[];
  moods: string[];
  releaseDate: string | null;
  originalReleaseDate: string | null;
  compilation: boolean;
  version: string | null;
  sortName: string | null;
  explicit: 'explicit' | 'clean' | null;
  discTitles: { disc: number; title: string }[];
}

const text = (value: string | undefined) => value?.trim() || null;
const strings = (
  values: string[] = [],
) => [...new Set(values.map((value) => value.trim()).filter(Boolean))];
const finite = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) ? value : null;

// Use native tags where the common projection loses facts (multi-value moods,
// advisory status, R128 and album version). Delimiter policy follows Navidrome's
// resources/mappings.yaml:86-93,179-182, not format-specific guesses.
export function metadataFromTags(meta: IAudioMetadata): SongMetadata {
  const common = meta.common;
  const tags = Object.values(meta.native).flat();
  const native = (...ids: string[]) =>
    tags.filter((tag) => ids.includes(tag.id.toUpperCase())).flatMap((tag) =>
      (Array.isArray(tag.value) ? tag.value : [tag.value]).filter(
        (value): value is string | number =>
          typeof value === 'string' || typeof value === 'number',
      ).map(String)
    );
  const gain = (rg: number | undefined, id: string) => {
    const value = finite(rg);
    if (value !== null) return value;
    const raw = native(id, `TXXX:${id}`, `----:COM.APPLE.ITUNES:${id}`)[0];
    return raw !== undefined && /^[+-]?\d+$/.test(raw)
      ? finite(Number(raw) / 256 + 5)
      : null;
  };
  const peak = (value: number | undefined) =>
    value !== undefined && value > 0 ? finite(value) : null;
  const advisory = native(
    'ITUNESADVISORY',
    'TXXX:ITUNESADVISORY',
    'RTNG',
    '----:COM.APPLE.ITUNES:ITUNESADVISORY',
  )[0];
  const moods = native('MOOD', 'TMOO', '----:COM.APPLE.ITUNES:MOOD');
  // 11.15.0 types this as string[] but its GenericTagTypes map is singular.
  const subtitle: unknown = common.discsubtitle;
  return {
    bitRate: null,
    bitDepth: null,
    sampleRate: null,
    channels: null,
    trackGain: gain(common.replaygain_track_gain?.dB, 'R128_TRACK_GAIN'),
    trackPeak: peak(common.replaygain_track_peak?.ratio),
    albumGain: gain(common.replaygain_album_gain?.dB, 'R128_ALBUM_GAIN'),
    albumPeak: peak(common.replaygain_album_peak?.ratio),
    // music-metadata does not publish OpusHead.outputGain in its result.
    baseGain: null,
    recordingMbid: text(common.musicbrainz_recordingid),
    artistMbid: text(common.musicbrainz_artistid?.[0]),
    albumArtistMbid: text(common.musicbrainz_albumartistid?.[0]),
    isrc: strings(common.isrc),
    genres: strings(common.genre?.flatMap((value) => value.split(/[;,/]/))),
    moods: strings(
      (moods.length ? moods : common.mood ? [common.mood] : []).flatMap((
        value,
      ) => value.split(/[;,/]/)),
    ),
    comment: text(common.comment?.[0]?.text) ?? text(native('DESCRIPTION')[0]),
    sortTitle: text(common.titlesort),
    artistSortName: text(common.artistsort),
    albumArtistSortName: text(common.albumartistsort),
    bpm: common.bpm !== undefined && common.bpm > 0
      ? Math.round(common.bpm)
      : null,
    explicit: advisory === '1' || advisory === '4'
      ? 'explicit'
      : advisory === '2'
      ? 'clean'
      : null,
    discSubtitle: text(
      typeof subtitle === 'string'
        ? subtitle
        : Array.isArray(subtitle)
        ? subtitle[0]
        : undefined,
    ),
    albumMbid: text(common.musicbrainz_albumid),
    recordLabels: strings([
      ...(common.label ?? []),
      ...native('PUBLISHER', 'ORGANIZATION'),
    ]),
    releaseTypes: strings(
      common.releasetype?.flatMap((value) => value.split(',')),
    ),
    releaseDate: text(common.releasedate) ?? text(native('©DAY')[0]),
    originalReleaseDate: text(common.originaldate) ??
      (common.originalyear ? String(common.originalyear) : null),
    compilation: common.compilation ?? false,
    version: text(
      native(
        'ALBUMVERSION',
        'TXXX:ALBUMVERSION',
        '----:COM.APPLE.ITUNES:ALBUMVERSION',
        'MUSICBRAINZ_ALBUMCOMMENT',
        'MUSICBRAINZ ALBUM COMMENT',
        'TXXX:MUSICBRAINZ ALBUM COMMENT',
        '----:COM.APPLE.ITUNES:MUSICBRAINZ ALBUM COMMENT',
      )[0],
    ),
    albumSortName: text(common.albumsort),
  };
}

interface ArtistFile {
  trackArtist: string | null;
  albumArtistTag: string | null;
  metadata?: SongMetadata;
}

// Count files, not credits: the same value in both roles is one vote per file.
// Only actual tag names own a value, never an inferred album-artist fallback.
// Most frequent non-empty value wins, with lexical ties independent of traversal.
function artistTagValues(
  files: ArtistFile[],
  trackKey: 'artistMbid' | 'artistSortName',
  albumKey: 'albumArtistMbid' | 'albumArtistSortName',
): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const file of files) {
    const credits = [
      [file.trackArtist, file.metadata?.[trackKey]],
      [file.albumArtistTag, file.metadata?.[albumKey]],
    ] as const;
    const seen = new Set<string>();
    for (const [name, id] of credits) {
      if (!name || !id) continue;
      const key = JSON.stringify([name, id]);
      if (seen.has(key)) continue;
      seen.add(key);
      const votes = counts.get(name) ?? new Map<string, number>();
      votes.set(id, (votes.get(id) ?? 0) + 1);
      counts.set(name, votes);
    }
  }
  return new Map([...counts].map(([name, votes]) => {
    const [id] = [...votes].sort(([a, n], [b, m]) =>
      m - n || (a < b ? -1 : a > b ? 1 : 0)
    )[0];
    return [name, id];
  }));
}

export function artistMusicBrainzIds(files: ArtistFile[]): Map<string, string> {
  return artistTagValues(files, 'artistMbid', 'albumArtistMbid');
}

export function artistSortNames(files: ArtistFile[]): Map<string, string> {
  return artistTagValues(files, 'artistSortName', 'albumArtistSortName');
}

export function albumMetadata(
  files: { path: string; disc: number | null; metadata?: SongMetadata }[],
): AlbumMetadata {
  const ordered = [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );
  const rows = ordered.flatMap((file) => file.metadata ? [file.metadata] : []);
  const merge = (key: 'genres' | 'moods' | 'recordLabels' | 'releaseTypes') =>
    strings(rows.flatMap((row) => row[key]));
  const agree = (key: 'releaseDate' | 'originalReleaseDate') =>
    rows.length && rows.every((row) => row[key] === rows[0][key])
      ? rows[0][key]
      : null;
  const counts = new Map<string, number>();
  let mbid: string | null = null, count = 0;
  for (const row of rows) {
    if (!row.albumMbid) continue;
    const n = (counts.get(row.albumMbid) ?? 0) + 1;
    counts.set(row.albumMbid, n);
    if (n > count) {
      mbid = row.albumMbid;
      count = n;
    }
  }
  const discs = new Map<number, string>();
  for (const file of ordered) {
    if (file.disc !== null && file.disc > 0) {
      const subtitle = file.metadata?.discSubtitle;
      if (!discs.has(file.disc) || !discs.get(file.disc)) {
        discs.set(file.disc, subtitle ?? '');
      }
    }
  }
  const discTitles = [...discs].sort(([a], [b]) => a - b).map((
    [disc, title],
  ) => ({ disc, title }));
  return {
    musicBrainzId: mbid,
    recordLabels: merge('recordLabels'),
    releaseTypes: merge('releaseTypes'),
    genres: merge('genres'),
    moods: merge('moods'),
    releaseDate: agree('releaseDate'),
    originalReleaseDate: agree('originalReleaseDate'),
    compilation: rows.some((row) => row.compilation),
    version: rows.find((row) => row.version)?.version ?? null,
    sortName: rows.find((row) => row.albumSortName)?.albumSortName ?? null,
    explicit: rows.some((row) => row.explicit === 'explicit')
      ? 'explicit'
      : rows.some((row) => row.explicit === 'clean')
      ? 'clean'
      : null,
    discTitles: discTitles.length === 1 && !discTitles[0].title
      ? []
      : discTitles,
  };
}
