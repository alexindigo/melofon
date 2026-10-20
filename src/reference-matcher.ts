import type { State } from './state.ts';
import type { Store } from './store/index.ts';
import type { MatchArtist, MatchTrack } from './store/reference-matcher.ts';
import type { ExternalArtist, ExternalTrack } from './reference-types.ts';

export type MatchedArtist =
  | { present: true; id: string }
  | ({ present: false } & ExternalArtist);

function normalize(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}
/** Jaro-Winkler on Unicode code points, boost above 0.7 with at most four
 * prefix characters (Navidrome matcher.go:633–641). */
export function referenceSimilarity(left: string, right: string): number {
  const a = [...normalize(left)], b = [...normalize(right)];
  if (a.join('') === b.join('')) return 1;
  if (!a.length || !b.length) return 0;
  const radius = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Set<number>(), bm = new Set<number>();
  for (let i = 0; i < a.length; i++) {
    for (
      let j = Math.max(0, i - radius);
      j < Math.min(b.length, i + radius + 1);
      j++
    ) {
      if (!bm.has(j) && a[i] === b[j]) {
        am.add(i);
        bm.add(j);
        break;
      }
    }
  }
  const matches = am.size;
  if (!matches) return 0;
  const aa = a.filter((_, i) => am.has(i)), bb = b.filter((_, i) => bm.has(i));
  const transpositions = aa.filter((v, i) => v !== bb[i]).length / 2;
  const jaro = (matches / a.length + matches / b.length +
    (matches - transpositions) / matches) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) {
    prefix++;
  }
  return jaro > 0.7 ? jaro + prefix * 0.1 * (1 - jaro) : jaro;
}
export function createReferenceMatcher(store: Store, state: State) {
  state.declare('reference.matchThreshold', {
    type: 'number',
    minimum: 0,
    maximum: 1,
    default: 0.85,
  });
  state.declare('reference.ignoredArticles', {
    type: 'array',
    items: { type: 'string' },
    default: [
      'The',
      'El',
      'La',
      'Los',
      'Las',
      'Le',
      'Les',
      'Os',
      'As',
      'O',
      'A',
    ],
  });
  const resolver = async () => {
    const artists = await store.referenceMatcher.artists();
    const articles =
      (await state.getTyped('reference.ignoredArticles') as string[]).map(
        normalize,
      );
    const nameKey = (name: string) => {
      const key = normalize(name);
      const article = articles.find((a) => a && key.startsWith(a + ' '));
      return article ? key.slice(article.length + 1) : key;
    };
    return (artist: ExternalArtist): MatchArtist[] => {
      const byId = artist.mbid
        ? artists.filter((a) =>
          a.mbid?.toLowerCase() === artist.mbid!.toLowerCase()
        )
        : [];
      if (byId.length) return byId;
      const key = nameKey(artist.name);
      return key ? artists.filter((a) => nameKey(a.name) === key) : [];
    };
  };
  return {
    async artists(input: ExternalArtist[]): Promise<MatchedArtist[]> {
      const resolve = await resolver();
      return input.map((artist) => {
        const local = resolve(artist)[0];
        return local
          ? { present: true, id: local.id }
          : { present: false, ...artist };
      });
    },
    async tracks(
      input: ExternalTrack[],
      count: number,
      user: string,
      exclude?: string,
    ): Promise<string[]> {
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new RangeError('Invalid reference count');
      }
      if (!count || !input.length) return [];
      const resolve = await resolver();
      const threshold = await state.getTyped(
        'reference.matchThreshold',
      ) as number;
      const output = new Set<string>();
      for (const external of input) {
        let candidates: MatchTrack[] = [];
        if (external.mbid) {
          candidates = await store.referenceMatcher.tracks({
            recordingMbid: external.mbid,
          });
        }
        if (!candidates.length && external.isrc) {
          candidates = await store.referenceMatcher.tracks({
            isrc: external.isrc,
          });
        }
        const exact = candidates.length > 0;
        if (!exact) {
          const artists = resolve({
            name: external.artist ?? '',
            mbid: external.artistMbid,
          });
          candidates = await store.referenceMatcher.tracks({
            artistIds: artists.map((a) => a.id),
          });
          candidates = candidates.filter((c) =>
            c.title !== null &&
            referenceSimilarity(external.title, c.title) >= threshold
          );
        }
        const facts = await store.annotations.facts(
          user,
          candidates.map((c) => c.id),
        );
        const score = (c: MatchTrack): number[] => [
          exact ? 1 : referenceSimilarity(external.title, c.title!),
          external.durationMs
            ? c.durationMs === null
              ? -Infinity
              : -Math.abs(external.durationMs - c.durationMs)
            : 0,
          facts[c.id].starred || (facts[c.id].userRating ?? 0) >= 4 ? 1 : 0,
          external.album && c.album
            ? referenceSimilarity(external.album, c.album)
            : 0,
        ];
        candidates.sort((a, b) => {
          const aa = score(a), bb = score(b);
          for (let i = 0; i < aa.length; i++) {
            if (aa[i] !== bb[i]) return bb[i] - aa[i];
          }
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
        const match = candidates[0];
        if (match && match.id !== exclude) output.add(match.id);
        if (output.size === count) break;
      }
      return [...output];
    },
  };
}
