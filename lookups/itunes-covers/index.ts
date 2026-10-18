// Standalone contract-v1 plugin: all I/O goes through the host context.
interface AlbumFacts {
  id: string;
  name: string | null;
  albumArtist: string | null;
}
interface LookupContext {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  settings: { countries: string[] };
  signal: AbortSignal;
}
interface Candidate {
  target: { type: 'album'; id: string };
  confidence: 'strong' | 'medium';
  values: { 'album.image.front': { url: string } };
  evidence: {
    collectionId: number;
    collectionName: string;
    artistName: string;
    country: string;
    albumSimilarity: number;
    artistSimilarity: number | null;
    /** Album names equal only once edition notes are removed from both. */
    editionNotesIgnored: boolean;
  };
}
type LookupResult = { candidates: Candidate[] } | {
  retryAfter: number;
  reason: string;
};

// Matching keeps every word, leading articles included: "A Night at the
// Opera" and "The Night at the Opera" are different titles. Dropping articles
// is for sorting and indexing, never for deciding two names are the same.
function normalize(name: string): string {
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// A bracketed part made only of edition words (with years, ordinals, `&`) is
// an edition note: "(Remastered 2009)", "[2019 Remix & Remaster]",
// "(50th Anniversary Edition)". Brackets with any other word ("(Live)",
// "(Vol. 2)") are part of the name.
const EDITION_WORDS = new Set([
  'remaster',
  'remastered',
  'remastering',
  'deluxe',
  'edition',
  'expanded',
  'anniversary',
  'bonus',
  'track',
  'tracks',
  'version',
  'mix',
  'remix',
  'mono',
  'stereo',
  'super',
  'special',
  'legacy',
  "collector's",
  'collectors',
  'reissue',
]);
function withoutEditionNotes(name: string): string {
  return name.replace(/[([]([^()[\]]*)[)\]]/g, (whole, inner: string) => {
    const words = inner.toLowerCase().split(/[\s,&+/-]+/).filter(Boolean);
    const edition = words.length > 0 && words.every((w) =>
      EDITION_WORDS.has(w) || /^\d+(st|nd|rd|th)?$/.test(w)
    ) && words.some((w) =>
      EDITION_WORDS.has(w)
    );
    return edition ? ' ' : whole;
  });
}

/** Normalized Levenshtein similarity, over Unicode code points. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const left = [...a], right = [...b];
  const length = Math.max(left.length, right.length);
  if (!left.length || !right.length) return 0;
  let row = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 0; i < left.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < right.length; j++) {
      next.push(Math.min(
        next[j] + 1,
        row[j + 1] + 1,
        row[j] + (left[i] === right[j] ? 0 : 1),
      ));
    }
    row = next;
  }
  return 1 - row[right.length] / length;
}

function retryDelay(value: string | null): number {
  if (value !== null) {
    if (/^\d+$/.test(value.trim())) {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) return seconds;
    } else {
      const date = Date.parse(value);
      if (Number.isFinite(date)) {
        return Math.max(0, Math.ceil((date - Date.now()) / 1000));
      }
    }
  }
  return 600;
}

export default {
  async 'album-cover'(
    item: AlbumFacts,
    ctx: LookupContext,
  ): Promise<LookupResult> {
    if (item.name === null) return { candidates: [] };
    const albumName = normalize(item.name);
    const albumBase = normalize(withoutEditionNotes(item.name));
    // Empty normalized names carry no evidence to compare either.
    if (!albumName) return { candidates: [] };
    const countries = ctx.settings.countries;
    const preferred = /\p{Script=Cyrillic}/u.test(item.name) ? 'ru' : 'us';
    const country = countries.includes(preferred) ? preferred : countries[0];
    if (!country) return { candidates: [] };
    const url = new URL('https://itunes.apple.com/search');
    url.search = new URLSearchParams({
      entity: 'album',
      limit: '8',
      term: [item.name, item.albumArtist].filter(Boolean).join(' '),
      country,
    }).toString();
    const response = await ctx.fetch(url, { signal: ctx.signal });
    if (response.status === 429 || response.status === 503) {
      return {
        retryAfter: retryDelay(response.headers.get('retry-after')),
        reason: `iTunes search HTTP ${response.status}`,
      };
    }
    if (!response.ok) {
      throw new Error(`iTunes search HTTP ${response.status}`);
    }
    const data = await response.json();
    if (!data || !Array.isArray(data.results)) {
      throw new Error('Invalid iTunes search response');
    }
    const artistName = item.albumArtist ? normalize(item.albumArtist) : null;
    const candidates: Candidate[] = [];
    for (const result of data.results) {
      if (
        !result || !Number.isSafeInteger(result.collectionId) ||
        typeof result.collectionName !== 'string' ||
        typeof result.artistName !== 'string' ||
        typeof result.artworkUrl100 !== 'string'
      ) throw new Error('Invalid iTunes album result');
      const exactAlbum = albumName === normalize(result.collectionName);
      // Medium matching compares names with edition notes removed.
      const albumSimilarity = similarity(
        albumBase,
        normalize(withoutEditionNotes(result.collectionName)),
      );
      const artistSimilarity = artistName
        ? similarity(artistName, normalize(result.artistName))
        : null;
      // Strong only when the names are equal as they are (edition notes
      // included); equal only without edition notes stays medium (user
      // decision 2026-10-18).
      const confidence = exactAlbum && artistSimilarity === 1
        ? 'strong'
        : (artistSimilarity === null
            ? albumSimilarity === 1
            : albumSimilarity >= 0.86 && artistSimilarity >= 0.75)
        ? 'medium'
        : null;
      if (!confidence) continue;
      candidates.push({
        target: { type: 'album', id: item.id },
        confidence,
        values: {
          'album.image.front': {
            url: result.artworkUrl100.replace(
              /\/\d+x\d+([^/]*)$/,
              '/1200x1200$1',
            ),
          },
        },
        evidence: {
          collectionId: result.collectionId,
          collectionName: result.collectionName,
          artistName: result.artistName,
          country,
          albumSimilarity,
          artistSimilarity,
          editionNotesIgnored: !exactAlbum && albumSimilarity === 1,
        },
      });
    }
    return { candidates };
  },
};
