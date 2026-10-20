import { object } from './manifest.ts';
import type {
  ExternalArtist,
  ExternalTrack,
  ReferenceName,
  ReferenceValues,
} from '../reference-types.ts';

function text(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('Expected reference text');
  return raw.trim();
}
function mbid(raw: unknown): string {
  const value = text(raw);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('Invalid reference MBID');
  }
  return value.toLowerCase();
}
/** Text, never executable markup. Drop non-content elements before decoding
 * entities so encoded angle brackets remain literal text, not new tags. */
function plainText(raw: string): string {
  const entities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return raw.replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
    .replace(/<\/?[a-z][^>]*>|<![^>]*>|<\?[^>]*\?>/gi, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (!name.startsWith('#')) return entities[name.toLowerCase()] ?? whole;
      const code = name[1].toLowerCase() === 'x'
        ? parseInt(name.slice(2), 16)
        : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : '\ufffd';
    }).replace(/\s+/g, ' ').trim();
}
function artist(raw: unknown): ExternalArtist {
  const r = object(raw, ['name', 'mbid']);
  const name = text(r.name);
  if (!name) throw new Error('Missing reference artist name');
  return { name, ...(r.mbid === undefined ? {} : { mbid: mbid(r.mbid) }) };
}
function track(raw: unknown): ExternalTrack {
  const r = object(raw, [
    'title',
    'artist',
    'album',
    'durationMs',
    'mbid',
    'isrc',
  ]);
  const title = text(r.title);
  if (!title) throw new Error('Missing reference track title');
  if (
    r.durationMs !== undefined &&
    (typeof r.durationMs !== 'number' || !Number.isFinite(r.durationMs) ||
      r.durationMs < 0)
  ) throw new Error('Invalid reference duration');
  return {
    title,
    ...(r.artist === undefined ? {} : { artist: text(r.artist) }),
    ...(r.album === undefined ? {} : { album: text(r.album) }),
    ...(r.durationMs === undefined
      ? {}
      : { durationMs: r.durationMs as number }),
    ...(r.mbid === undefined ? {} : { mbid: mbid(r.mbid) }),
    ...(r.isrc === undefined ? {} : { isrc: text(r.isrc) }),
  };
}
export function parseReferenceValues(
  raw: unknown,
  names: readonly ReferenceName[],
): ReferenceValues {
  const input = object(raw, [...names]);
  const values: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(input)) {
    // Explicit empty values and omitted names both mean a successful negative lookup.
    if (value == null || value === '') continue;
    if (name === 'artist.biography') {
      const r = object(value, ['text', 'language']);
      const body = plainText(text(r.text));
      if (r.language !== undefined) text(r.language);
      if (body) {
        values[name] = {
          text: body,
          ...(r.language === undefined ? {} : { language: text(r.language) }),
        };
      }
    } else if (name === 'artist.url') {
      const r = object(value, ['url']);
      const url = text(r.url);
      if (!url) continue;
      if (!['http:', 'https:'].includes(new URL(url).protocol)) {
        throw new Error('Invalid reference URL');
      }
      values[name] = { url };
    } else if (name === 'artist.id.mbid') {
      values[name] = mbid(value);
    } else {
      if (!Array.isArray(value)) throw new Error('Expected reference list');
      const list = name === 'artist.similar'
        ? value.map(artist)
        : value.map(track);
      if (list.length) values[name] = list;
    }
  }
  return values as ReferenceValues;
}
