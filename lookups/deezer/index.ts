// Contract v1. No native I/O: the host owns grants, rate, deadlines and retries.
interface ArtistFacts {
  id: string;
  name: string | null;
}
interface Context {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  settings: {
    language: string;
    searchLimit: number;
    topTrackLimit: number;
    retrySeconds: number;
  };
  signal: AbortSignal;
}
interface Artist {
  id: number;
  name: string;
  nb_fan?: number;
  picture_xl?: string;
  link?: string;
}
interface Track {
  title: string;
  artist?: string;
  album?: string;
  durationMs?: number;
  isrc?: string;
}
interface Values {
  'artist.url'?: { url: string };
  'artist.similar'?: { name: string }[];
  'artist.topTracks'?: Track[];
  'artist.biography'?: { text: string; language: string };
}
interface Candidate {
  target: { type: 'artist'; id: string };
  confidence: 'strong' | 'medium';
  values: { 'artist.image.primary': { url: string } };
  evidence: {
    deezerId: number;
    name: string;
    fans: number;
    exactMatches: number;
  };
}
type Result = { candidates: Candidate[] } | { values: Values } | {
  retryAfter: number;
  reason: string;
};
class RetryLater extends Error {
  constructor(readonly seconds: number, reason: string) {
    super(reason);
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Deezer object');
  }
  return value as Record<string, unknown>;
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function link(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (
      ['http:', 'https:'].includes(url.protocol) && !url.username &&
      !url.password
    ) return url.href;
  } catch { /* An absent/invalid optional field is not a fact. */ }
}
function retryDelay(header: string | null, fallback: number): number {
  if (header !== null) {
    if (/^\d+$/.test(header.trim()) && Number.isFinite(Number(header))) {
      return Number(header);
    }
    const date = Date.parse(header);
    if (Number.isFinite(date)) {
      return Math.max(0, Math.ceil((date - Date.now()) / 1000));
    }
  }
  return fallback;
}
async function request(
  ctx: Context,
  url: string | URL,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await ctx.fetch(url, { ...init, signal: ctx.signal });
  if (response.status === 429 || response.status === 503) {
    await response.body?.cancel();
    throw new RetryLater(
      retryDelay(
        response.headers.get('retry-after'),
        ctx.settings.retrySeconds,
      ),
      `Deezer HTTP ${response.status}`,
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Deezer HTTP ${response.status}`);
  }
  const body = record(await response.json());
  if (body.error) {
    const error = record(body.error);
    // Quota is HTTP 200, code 4: Navidrome adapters/deezer/client.go:23-25,100-112.
    if (error.code === 4) {
      throw new RetryLater(ctx.settings.retrySeconds, 'Deezer quota exceeded');
    }
    throw new Error('Deezer API error');
  }
  return body;
}
function list(body: Record<string, unknown>): unknown[] {
  if (!Array.isArray(body.data)) throw new Error('Invalid Deezer list');
  return body.data;
}
async function findArtist(item: ArtistFacts, ctx: Context) {
  if (!item.name?.trim()) return;
  const name = item.name;
  const url = new URL('https://api.deezer.com/search/artist');
  url.search = new URLSearchParams({
    q: name,
    limit: String(ctx.settings.searchLimit),
    order: 'RANKING',
  }).toString();
  const artists = list(await request(ctx, url)).map((value): Artist => {
    const a = record(value);
    if (!Number.isSafeInteger(a.id) || Number(a.id) <= 0 || !text(a.name)) {
      throw new Error('Invalid Deezer artist');
    }
    return {
      id: Number(a.id),
      name: String(a.name),
      nb_fan: typeof a.nb_fan === 'number' && Number.isFinite(a.nb_fan)
        ? a.nb_fan
        : 0,
      picture_xl: link(a.picture_xl),
      link: link(a.link),
    };
  });
  // Exact case first, then folded case, fans and stable id (deezer.go:106-129).
  const rank = (a: Artist) =>
    a.name === name ? 2 : a.name.toLowerCase() === name.toLowerCase() ? 1 : 0;
  artists.sort((a, b) =>
    rank(b) - rank(a) || (b.nb_fan ?? 0) - (a.nb_fan ?? 0) || a.id - b.id
  );
  const artist = artists[0];
  if (!artist || rank(artist) === 0) return;
  return {
    artist,
    exactMatches: artists.filter((a) => a.name === name).length,
  };
}
// Biography is plain text already when it crosses the plugin boundary. Core
// independently validates/normalizes it, as for all reference providers.
function plainText(html: string): string {
  const entities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(
    /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    '',
  )
    .replace(/<\/(?:p|div)>|<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(
      /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (whole, entity: string) => {
        if (!entity.startsWith('#')) {
          return entities[entity.toLowerCase()] ??
            whole;
        }
        const n = entity[1].toLowerCase() === 'x'
          ? parseInt(entity.slice(2), 16)
          : Number(entity.slice(1));
        return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
          ? String.fromCodePoint(n)
          : whole;
      },
    ).trim();
}
async function biography(id: number, ctx: Context) {
  const auth = await request(
    ctx,
    'https://auth.deezer.com/login/anonymous?jo=p&rto=c',
    { headers: { accept: 'application/json' } },
  );
  if (!text(auth.jwt)) throw new Error('Deezer anonymous token missing');
  const body = await request(ctx, 'https://pipe.deezer.com/api', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept-language': ctx.settings.language,
      authorization: `Bearer ${auth.jwt}`,
    },
    body: JSON.stringify({
      operationName: 'ArtistBio',
      variables: { artistId: String(id) },
      query:
        'query ArtistBio($artistId: String!) { artist(artistId: $artistId) { bio { full } } }',
    }),
  });
  if (Array.isArray(body.errors) && body.errors.length) {
    throw new Error('Deezer biography GraphQL error');
  }
  const full = record(record(record(body.data).artist).bio).full;
  return typeof full === 'string' ? plainText(full) : '';
}
function retry(error: unknown): Result {
  if (error instanceof RetryLater) {
    return { retryAfter: error.seconds, reason: error.message };
  }
  throw error;
}
export default {
  async 'artist-photo'(item: ArtistFacts, ctx: Context): Promise<Result> {
    try {
      const found = await findArtist(item, ctx);
      if (
        !found?.artist.picture_xl ||
        found.artist.picture_xl.includes('/images/artist//')
      ) return { candidates: [] };
      const { artist, exactMatches } = found;
      return {
        candidates: [{
          target: { type: 'artist', id: item.id },
          confidence: exactMatches === 1 ? 'strong' : 'medium',
          values: { 'artist.image.primary': { url: artist.picture_xl! } },
          evidence: {
            deezerId: artist.id,
            name: artist.name,
            fans: artist.nb_fan ?? 0,
            exactMatches,
          },
        }],
      };
    } catch (error) {
      return retry(error);
    }
  },
  async 'artist-reference'(item: ArtistFacts, ctx: Context): Promise<Result> {
    try {
      const found = await findArtist(item, ctx);
      if (!found) return { values: {} };
      const { artist } = found;
      const values: Values = {};
      if (artist.link) values['artist.url'] = { url: artist.link };
      const outcomes = await Promise.allSettled([
        (async () => {
          const body = await request(
            ctx,
            `https://api.deezer.com/artist/${artist.id}/related`,
          );
          const names = list(body).map((a) => {
            const name = text(record(a).name);
            if (!name) throw new Error('Invalid related artist');
            return { name };
          });
          if (names.length) values['artist.similar'] = names;
        })(),
        (async () => {
          const body = await request(
            ctx,
            `https://api.deezer.com/artist/${artist.id}/top?limit=${ctx.settings.topTrackLimit}`,
          );
          const tracks = list(body).map((value): Track => {
            const t = record(value), title = text(t.title);
            if (!title) throw new Error('Invalid Deezer track');
            const performer = t.artist
              ? text(record(t.artist).name)
              : undefined;
            const album = t.album ? text(record(t.album).title) : undefined;
            const duration =
              typeof t.duration === 'number' && Number.isFinite(t.duration) &&
                t.duration >= 0
                ? t.duration * 1000
                : undefined;
            return {
              title,
              ...(performer ? { artist: performer } : {}),
              ...(album ? { album } : {}),
              ...(duration !== undefined ? { durationMs: duration } : {}),
              ...(text(t.isrc) ? { isrc: text(t.isrc) } : {}),
            };
          });
          if (tracks.length) values['artist.topTracks'] = tracks;
        })(),
        (async () => {
          const bio = await biography(artist.id, ctx);
          if (bio) {
            values['artist.biography'] = {
              text: bio,
              language: ctx.settings.language,
            };
          }
        })(),
      ]);
      // A quota is not a fresh negative answer. Preserve the previous bundle
      // and let core cool down; ordinary per-fact failures omit only that fact.
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          ctx.signal.throwIfAborted();
          if (outcome.reason instanceof RetryLater) throw outcome.reason;
        }
      }
      return { values };
    } catch (error) {
      return retry(error);
    }
  },
};
