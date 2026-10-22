import { parse, type XmlElement } from '@std/xml';
import type { PodcastFeed } from './store/podcasts.ts';

const children = (element: XmlElement | undefined, name: string) =>
  element?.children.filter((node): node is XmlElement =>
    node.type === 'element' && node.name.raw === name
  ) ?? [];
const child = (element: XmlElement | undefined, name: string) =>
  children(element, name)[0];
const value = (element: XmlElement | undefined): string | undefined =>
  element?.children.filter((node) =>
    node.type === 'text' || node.type === 'cdata'
  )
    .map((node) => node.text).join('');
const text = (value: unknown): string | null => {
  const raw = value;
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
  let rss: XmlElement;
  try {
    rss = parse(xml).root;
  } catch (error) {
    throw new Error(
      `Bad XML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const channel = child(rss, 'channel');
  if (rss.name.raw !== 'rss' || rss.attributes.version !== '2.0' || !channel) {
    throw new Error('Unsupported feed (RSS 2.0 required)');
  }
  const episodes: PodcastFeed['episodes'] = [];
  for (const item of children(channel, 'item')) {
    const enclosure = child(item, 'enclosure');
    const enclosureUrl = httpUrl(enclosure?.attributes.url, base);
    if (!enclosureUrl) continue;
    const date = text(value(child(item, 'pubDate')));
    const ms = date === null ? NaN : Date.parse(date);
    episodes.push({
      guid: text(value(child(item, 'guid'))) ?? enclosureUrl,
      title: plain(value(child(item, 'title'))),
      description: plain(
        value(
          child(item, 'description') ?? child(item, 'itunes:summary') ??
            child(item, 'content:encoded'),
        ),
      ),
      publishDate: Number.isFinite(ms) ? new Date(ms).toISOString() : null,
      enclosureUrl,
      contentType: text(enclosure?.attributes.type),
      enclosureLength: number(enclosure?.attributes.length),
      duration: duration(value(child(item, 'itunes:duration'))),
    });
  }
  return {
    title: plain(value(child(channel, 'title'))),
    description: plain(value(child(channel, 'description'))),
    imageUrl: httpUrl(child(channel, 'itunes:image')?.attributes.href, base) ??
      httpUrl(value(child(child(channel, 'image'), 'url')), base),
    episodes,
  };
}
