import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { PodcastFeed } from './store/podcasts.ts';

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
const text = (value: unknown): string | null => {
  const raw = typeof value === 'string' ? value : record(value)['#text'];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
};
function plain(value: unknown): string | null {
  return text(value)?.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#(?:39|x27);/gi, "'")
    .replace(/&#(x[\da-f]+|\d+);/gi, (_match, code: string) => {
      const n = code[0].toLowerCase() === 'x'
        ? parseInt(code.slice(1), 16)
        : Number(code);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
        ? String.fromCodePoint(n)
        : '';
    }).replace(/\s+/g, ' ').trim() || null;
}
const number = (value: unknown): number | null => {
  const raw = text(value);
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};
function duration(value: unknown): number | null {
  const raw = text(value);
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return number(raw);
  if (!/^\d+:\d{2}(?::\d{2})?$/.test(raw)) return null;
  const parts = raw.split(':').map(Number);
  if (parts.slice(1).some((part) => part > 59)) return null;
  return parts.reduce((sum, part) => sum * 60 + part, 0);
}
function httpUrl(value: unknown, base: string): string | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw, base);
    return ['http:', 'https:'].includes(url.protocol) && !url.username &&
        !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** RSS only. DTDs/entities are not part of podcast metadata: never expand them. */
export function parsePodcastFeed(xml: string, base: string): PodcastFeed {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new Error('Unsupported feed declaration');
  }
  const valid = XMLValidator.validate(xml);
  if (valid !== true) throw new Error(`Bad XML: ${valid.err.msg}`);
  const parsed = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    parseAttributeValue: false,
    isArray: (_name, path) => path === 'rss.channel.item',
  }).parse(xml);
  const rss = record(record(parsed).rss);
  const channel = record(rss.channel);
  if (rss['@_version'] !== '2.0' || !Object.keys(channel).length) {
    throw new Error('Unsupported feed (RSS 2.0 required)');
  }
  const episodes: PodcastFeed['episodes'] = [];
  for (const value of Array.isArray(channel.item) ? channel.item : []) {
    const item = record(value);
    const enclosure = record(
      Array.isArray(item.enclosure) ? item.enclosure[0] : item.enclosure,
    );
    const enclosureUrl = httpUrl(enclosure['@_url'], base);
    if (!enclosureUrl) continue;
    const date = text(item.pubDate);
    const ms = date === null ? NaN : Date.parse(date);
    episodes.push({
      guid: text(item.guid) ?? enclosureUrl,
      title: plain(item.title),
      description: plain(
        item.description ?? item['itunes:summary'] ?? item['content:encoded'],
      ),
      publishDate: Number.isFinite(ms) ? new Date(ms).toISOString() : null,
      enclosureUrl,
      contentType: text(enclosure['@_type']),
      enclosureLength: number(enclosure['@_length']),
      duration: duration(item['itunes:duration']),
    });
  }
  return {
    title: plain(channel.title),
    description: plain(channel.description),
    imageUrl: httpUrl(record(channel['itunes:image'])['@_href'], base) ??
      httpUrl(record(channel.image).url, base),
    episodes,
  };
}
