import type { IAudioMetadata } from 'music-metadata';

export interface ArtistCredit {
  id: string;
  name: string;
}

export interface TrackCredit<A = ArtistCredit> {
  role: string;
  subRole?: string;
  artist: A;
}

export interface TrackTagDetails<A = ArtistCredit> {
  credits: TrackCredit<A>[];
  displayArtist: string | null;
  displayAlbumArtist: string | null;
  displayComposer: string | null;
  works: { name: string; musicBrainzId?: string }[];
  movements: { name: string; number?: number; count?: number }[];
  groupings: string[];
}

export interface AlbumArtistDetails {
  artists: ArtistCredit[];
  displayArtist: string | null;
}

const text = (value: string | undefined) => value?.trim() || null;
const clean = (values: string[]) => values.map((v) => v.trim()).filter(Boolean);

export function trackDetailsFromTags(
  { common, native }: IAudioMetadata,
): TrackTagDetails<string> {
  const tags = Object.values(native).flat();
  const values = (...ids: string[]) =>
    tags.flatMap(({ id, value }) =>
      ids.includes(id.toUpperCase()) &&
        (typeof value === 'string' || typeof value === 'number')
        ? [String(value)]
        : []
    );
  const freeform = (...keys: string[]) =>
    values(
      ...keys.flatMap((
        key,
      ) => [key, `TXXX:${key}`, `----:COM.APPLE.ITUNES:${key}`]),
    );
  const displayArtist = text(common.artist);
  const displayAlbumArtist = text(common.albumartist) ??
    text(freeform('ALBUMARTIST')[0]);
  const credits: TrackCredit<string>[] = [];
  const seen = new Set<string>();
  const add = (role: string, names: string[], subRole?: string) => {
    for (const artist of clean(names)) {
      const key = JSON.stringify([role, subRole, artist]);
      if (seen.has(key)) continue;
      seen.add(key);
      credits.push({ role, artist, ...(subRole ? { subRole } : {}) });
    }
  };
  // An explicit plural tag gives names; a singular display tag may contain
  // arbitrary joining text (e.g. "feat.") or punctuation in a band name.
  const artists = clean(freeform('ARTISTS'));
  const albumArtists = clean(freeform('ALBUMARTISTS'));
  add(
    'artist',
    artists.length ? artists : common.artists ?? clean([displayArtist ?? '']),
  );
  add(
    'albumartist',
    albumArtists.length
      ? albumArtists
      : common.albumartists ?? clean([displayAlbumArtist ?? '']),
  );

  const composers = clean(common.composer ?? freeform('COMPOSER'));
  add('composer', composers);
  for (
    const role of [
      'conductor',
      'lyricist',
      'writer',
      'arranger',
      'remixer',
      'producer',
      'engineer',
      'mixer',
      'djmixer',
    ] as const
  ) {
    add(role, [...common[role] ?? [], ...freeform(role.toUpperCase())]);
  }
  for (const raw of freeform('PERFORMER')) {
    // Picard's Vorbis/APE performer field uses "name (instrument)".
    const match = /^(.*?)\s+\(([^()]+)\)$/.exec(raw.trim());
    add('performer', [match?.[1] ?? raw], text(match?.[2]) ?? undefined);
  }
  for (const { id, value } of tags) {
    if (
      !['TMCL', 'TIPL', 'IPLS'].includes(id) || value === null ||
      typeof value !== 'object' || Array.isArray(value)
    ) continue;
    // music-metadata returns involved-people frames as { role: names[] }.
    for (const [tagRole, rawNames] of Object.entries(value)) {
      const subRole = text(tagRole);
      if (!subRole || !Array.isArray(rawNames)) continue;
      const names = rawNames.filter((v): v is string => typeof v === 'string');
      const role = subRole.toLowerCase();
      if (id === 'TMCL') {
        add('performer', names, subRole);
      } else {
        add(
          role === 'mix' ? 'mixer' : role === 'dj-mix' ? 'djmixer' : role,
          names,
        );
      }
    }
  }

  const workNames = clean([...freeform('WORK'), ...values('©WRK')]);
  if (!workNames.length && common.work?.trim()) {
    workNames.push(common.work.trim());
  }
  // Only attach IDs when the tags provide a matching, ordered list.
  const workIds = [
    ...freeform('MUSICBRAINZ_WORKID'),
    ...freeform('MUSICBRAINZ WORK ID'),
  ];
  if (!workIds.length && common.musicbrainz_workid) {
    workIds.push(common.musicbrainz_workid);
  }
  const works = workNames.map((name, index) => {
    const musicBrainzId = workNames.length === workIds.length
      ? text(workIds[index])
      : null;
    return { name, ...(musicBrainzId ? { musicBrainzId } : {}) };
  });
  const movementName = text(common.movement) ??
    text(freeform('MOVEMENTNAME')[0]);
  const movementIndex = freeform('MOVEMENT', 'MOVEMENTNUMBER')[0]?.split('/');
  const positiveInt = (value: string | number | null | undefined) => {
    if (typeof value === 'string' && !/^\d+$/.test(value.trim())) {
      return undefined;
    }
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  };
  const number = positiveInt(common.movementIndex.no ?? movementIndex?.[0]);
  const count = positiveInt(
    common.movementIndex.of ?? freeform('MOVEMENTTOTAL', 'MOVEMENTCOUNT')[0] ??
      movementIndex?.[1],
  );
  const groupings = clean([
    ...freeform('GROUPING'),
    ...values('GRP1', 'GP1', '©GRP'),
  ]);
  if (!groupings.length && common.grouping?.trim()) {
    groupings.push(common.grouping.trim());
  }
  return {
    credits,
    displayArtist,
    displayAlbumArtist,
    displayComposer: composers.join(', ') || null,
    works,
    movements: movementName ? [{ name: movementName, number, count }] : [],
    groupings: [...new Set(groupings)],
  };
}
