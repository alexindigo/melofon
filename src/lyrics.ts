// One core source/parser owner for scan, both lyrics protocols and unifying.
import { Buffer } from 'node:buffer';
import { basename, dirname, extname } from 'node:path';
import type { IAudioMetadata, ILyricsTag } from 'music-metadata';
import type { Store } from './store/index.ts';
import { createState, type State } from './state.ts';
import { imageHash, libraryImagesWritable } from './images.ts';
import { lyricsMetadata } from './lyrics-metadata.ts';
import { parseLyricsValue } from './lookups/lyrics-values.ts';

export interface LyricsCue {
  start: number;
  end?: number;
  text: string;
  byteStart: number;
  byteEnd: number;
}
export interface LyricsLine {
  start?: number;
  text: string;
  cues?: LyricsCue[];
}
export interface LyricsEntry {
  language: string;
  synced: boolean;
  offset?: number;
  artist?: string;
  title?: string;
  lines: LyricsLine[];
}
export interface LyricsSource {
  origin: string;
  entry: LyricsEntry;
  /** Exact bytes/native facts are retained with backups, not just displayed text. */
  bytes?: string;
  native?: unknown;
}
export type Lyrics = ReturnType<typeof createLyrics>;
const timePattern = '(?:\\d{1,2}:)?\\d{1,2}:\\d{1,2}(?:\\.\\d{1,3})?';
const millis = (text: string) =>
  Math.round(
    text.split(':').reduce((sum, part) => sum * 60 + Number(part), 0) * 1000,
  );
const utf8 = (text: string) => new TextEncoder().encode(text).length;

function enhancedLine(text: string): Pick<LyricsLine, 'text' | 'cues'> | null {
  const markers = [...text.matchAll(new RegExp(`<(${timePattern})>`, 'g'))];
  if ([...text.matchAll(/<\d[^>]*(?:>|$)/g)].length !== markers.length) {
    return null;
  }
  if (!markers.length) return { text };
  let value = text.slice(0, markers[0].index);
  const cues: LyricsCue[] = [];
  let lastEnd: number | undefined;
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    const word = text.slice(
      marker.index! + marker[0].length,
      markers[i + 1]?.index ?? text.length,
    );
    const start = millis(marker[1]);
    if (word === '') {
      if (i === markers.length - 1) lastEnd = start;
      continue;
    }
    const byteStart = utf8(value);
    value += word;
    cues.push({ start, text: word, byteStart, byteEnd: utf8(value) - 1 });
  }
  // Only an explicit trailing word marker supplies an end. Line timing never
  // manufactures word durations. When present, complete all ends from cues.
  if (lastEnd !== undefined && cues.length) {
    for (let i = 0; i < cues.length; i++) {
      cues[i].end = Math.max(
        cues[i].start,
        Math.min(lastEnd, cues[i + 1]?.start ?? lastEnd),
      );
    }
  }
  return { text: value, ...(cues.length ? { cues } : {}) };
}

/** LRC ids/timing follow Navidrome model/lyrics_lrc.go; bad structured input is
 * missing rather than being displayed as literal broken markup (H6 row 3). */
export function parseLyrics(
  text: string,
  structured = false,
  language = 'xxx',
): LyricsEntry | null {
  text = text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
  if (!text.trim() || text.includes('\0')) return null;
  const result: LyricsEntry = { language, synced: false, lines: [] };
  const timestamp = new RegExp(`^\\[(${timePattern})\\]`);
  let sawTiming = false;
  for (let row of text.split('\n')) {
    const id = /^\[(ar|ti|lang|offset):([^\]]*)\]\s*$/i.exec(row);
    if (id) {
      if (id[1].toLowerCase() === 'lang') result.language = id[2] || language;
      if (id[1].toLowerCase() === 'ar') result.artist = id[2];
      if (id[1].toLowerCase() === 'ti') result.title = id[2];
      if (id[1].toLowerCase() === 'offset') {
        if (!/^[+-]?\d+$/.test(id[2]) || !Number.isSafeInteger(Number(id[2]))) {
          return null;
        }
        result.offset = Number(id[2]);
      }
      continue;
    }
    if (/^\[[A-Za-z][^:\]]*:[^\]]*\]\s*$/.test(row)) continue;
    const starts: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = timestamp.exec(row)) !== null) {
      starts.push(millis(match[1]));
      row = row.slice(match[0].length);
    }
    if (starts.length) {
      sawTiming = true;
      const line = enhancedLine(row);
      if (!line) return null;
      if (
        line.cues?.some((cue, i, cues) =>
          i > 0 && cue.start < cues[i - 1].start
        )
      ) return null;
      for (const start of starts) {
        const shift = start - starts[0];
        result.lines.push({
          start,
          text: line.text,
          ...(line.cues
            ? {
              cues: line.cues.map((cue) => ({
                ...cue,
                start: cue.start + shift,
                ...(cue.end !== undefined ? { end: cue.end + shift } : {}),
              })),
            }
            : {}),
        });
      }
    } else {
      if (/^\[\d|<\d/.test(row) || (structured && row.trim())) return null;
      result.lines.push({ text: row });
    }
  }
  if (sawTiming) {
    // Unstamped blank separators are not timed lines; explicit empty [time]
    // lines remain, including their exact timestamp.
    result.lines = result.lines.filter((line) => line.start !== undefined).sort(
      (a, b) => a.start! - b.start!,
    );
    result.synced = true;
  } else if (structured) return null;
  return result.lines.length ? result : null;
}

function sylt(tag: ILyricsTag): LyricsEntry | null {
  if (!tag.syncText?.length) return null;
  const synced = tag.timeStampFormat === 2;
  const lines: LyricsLine[] = [];
  for (const part of tag.syncText) {
    if (
      synced &&
      (part.timestamp === undefined || !Number.isSafeInteger(part.timestamp))
    ) return null;
    if (!lines.length || part.text.startsWith('\n')) {
      lines.push({
        ...(synced ? { start: part.timestamp, cues: [] } : {}),
        text: '',
      });
    }
    const line = lines.at(-1)!;
    const text = part.text.replace(/^\n/, '');
    const byteStart = utf8(line.text);
    line.text += text;
    if (text && synced) {
      line.cues!.push({
        start: part.timestamp!,
        text,
        byteStart,
        byteEnd: utf8(line.text) - 1,
      });
    }
  }
  for (const line of lines) if (!line.cues?.length) delete line.cues;
  return {
    language: tag.language || 'xxx',
    synced,
    lines: synced ? lines.sort((a, b) => a.start! - b.start!) : lines,
  };
}

/** Native tags retain raw LRC, all languages and SYLT timestamp format 1. The
 * common lyrics projection discards enhanced markers and cannot be the owner. */
export function embeddedLyrics(metadata: IAudioMetadata): LyricsSource[] {
  const sources: LyricsSource[] = [];
  for (const tag of Object.values(metadata.native).flat()) {
    if (!/^(USLT|ULT|SYLT|LYRICS|©lyr)$/i.test(tag.id)) continue;
    const value = tag.value as ILyricsTag | string;
    const entry = typeof value === 'string'
      ? parseLyrics(value)
      : tag.id === 'SYLT'
      ? sylt(value)
      : parseLyrics(value.text ?? '', false, value.language || 'xxx');
    if (entry) sources.push({ origin: 'embedded', entry, native: tag });
  }
  return sources;
}

export async function lyricsHash(entry: LyricsEntry) {
  // Text identity deliberately excludes container, language spelling and timing;
  // a synced and unsynced copy of the same words is not a local text conflict.
  return await imageHash(
    new TextEncoder().encode(
      entry.lines.map((line) => line.text.normalize('NFC').trimEnd()).join('\n')
        .trim(),
    ),
  );
}

export async function lyricsSidecars(path: string): Promise<string[]> {
  const stem = basename(path, extname(path));
  const rank = ['elrc', 'lrc', 'txt'];
  const paths: string[] = [];
  for await (const entry of Deno.readDir(dirname(path))) {
    if (
      entry.isFile && basename(entry.name, extname(entry.name)) === stem &&
      rank.includes(extname(entry.name).slice(1).toLowerCase())
    ) paths.push(`${dirname(path)}/${entry.name}`);
  }
  return paths.sort((a, b) =>
    rank.indexOf(extname(a).slice(1).toLowerCase()) -
      rank.indexOf(extname(b).slice(1).toLowerCase()) || a.localeCompare(b)
  );
}

function decode(bytes: Uint8Array) {
  const utf16 = bytes[0] === 255 && bytes[1] === 254
    ? 'utf-16le'
    : bytes[0] === 254 && bytes[1] === 255
    ? 'utf-16be'
    : undefined;
  return new TextDecoder(utf16 ?? 'utf-8', { fatal: true }).decode(bytes)
    .replace(/^\ufeff/, '');
}

/** A source snapshot owns its pre-read cap and parses exactly the bytes that
 * will be archived. Malformed text is still available to the backup owner. */
export async function readLyricsSidecar(path: string, limit: number) {
  using file = await Deno.open(path, { read: true });
  const stat = await file.stat();
  if (stat.size > limit) throw new Error('Sidecar exceeds lyrics.maxBytes');
  const bytes = new Uint8Array(stat.size);
  let at = 0;
  while (at < bytes.length) {
    const n = await file.read(bytes.subarray(at));
    if (n === null) throw new Error('Truncated lyrics');
    at += n;
  }
  const after = await file.stat();
  if (
    after.size !== stat.size ||
    after.mtime?.getTime() !== stat.mtime?.getTime() ||
    after.ino !== stat.ino || after.dev !== stat.dev
  ) throw new Error('Lyrics changed during read');
  let entry: LyricsEntry | null = null;
  try {
    entry = parseLyrics(decode(bytes), !/\.txt$/i.test(path));
  } catch { /* Preserve raw invalid bytes, but never display them. */ }
  return { bytes, entry, stat };
}

/** Lossless domain serialization for the native text-tag containers and sidecar. */
export function serializeLyrics(entry: LyricsEntry): string {
  const stamp = (time: number) =>
    `${Math.floor(time / 60000).toString().padStart(2, '0')}:${
      (time % 60000 / 1000).toFixed(3).padStart(6, '0')
    }`;
  const ids = [
    entry.language !== 'xxx' ? `[lang:${entry.language}]` : '',
    entry.offset !== undefined ? `[offset:${entry.offset}]` : '',
    entry.artist !== undefined ? `[ar:${entry.artist}]` : '',
    entry.title !== undefined ? `[ti:${entry.title}]` : '',
  ].filter(Boolean);
  return [
    ...ids,
    ...entry.lines.map((line) => {
      if (!entry.synced) return line.text;
      const bytes = Buffer.from(line.text);
      let value = '';
      let at = 0;
      for (const cue of line.cues ?? []) {
        value += bytes.subarray(at, cue.byteStart).toString() +
          `<${stamp(cue.start)}>` +
          bytes.subarray(cue.byteStart, cue.byteEnd + 1).toString();
        at = cue.byteEnd + 1;
      }
      value += bytes.subarray(at).toString();
      const end = line.cues?.at(-1)?.end;
      if (end !== undefined) value += `<${stamp(end)}>`;
      return `[${stamp(line.start!)}]${value}`;
    }),
  ].join('\n');
}

export function createLyrics(
  store: Store,
  state: Pick<State, 'declare' | 'getTyped'> = createState(store),
) {
  state.declare('lyrics.maxBytes', {
    type: 'integer',
    minimum: 1,
    default: 1048576,
  });
  state.declare('lyrics.legacyCandidates', {
    type: 'integer',
    minimum: 1,
    maximum: 10,
    default: 10,
  });
  const maxBytes = async () => Number(await state.getTyped('lyrics.maxBytes'));
  const sources = async (
    path: string,
    cachedEmbedded?: LyricsSource[],
  ): Promise<LyricsSource[]> => {
    const limit = await maxBytes();
    let embedded: LyricsSource[] = cachedEmbedded ?? [];
    try {
      if (cachedEmbedded === undefined) {
        embedded = embeddedLyrics(await lyricsMetadata(path, limit));
      }
    } catch { /* Unreadable/oversized tag is missing. */ }
    const sides: LyricsSource[] = [];
    for (const sidecar of await lyricsSidecars(path).catch(() => [])) {
      try {
        const { bytes, entry } = await readLyricsSidecar(sidecar, limit);
        if (entry) {
          sides.push({
            origin: sidecar,
            entry,
            bytes: Buffer.from(bytes).toString('base64'),
          });
        }
      } catch {
        /* Malformed, missing or unreadable: the next source can win. */
      }
    }
    return [...embedded, ...sides];
  };
  const shown = (all: LyricsSource[]) => {
    const embedded = all.filter((source) => source.origin === 'embedded');
    return (embedded.length ? embedded : all.slice(0, 1)).map((source) =>
      source.entry
    );
  };
  const selected = async (id: string, path: string): Promise<LyricsEntry[]> => {
    const local = shown(await sources(path));
    if (local.length) return local;
    const candidate = await store.candidates.strongestOpen(
      'song',
      id,
      'lyrics',
    );
    if (!candidate) return [];
    const value = candidate.details.lyrics as { entries?: unknown } | undefined;
    // Online proposals own a complete entry set, unlike local conflict backups.
    // Reuse admission validation and the live reader budget for kept values too.
    if (utf8(JSON.stringify(value) ?? '') > await maxBytes()) return [];
    try {
      return parseLyricsValue({
        url: candidate.origin,
        entries: value?.entries,
      })
        .entries;
    } catch {
      return []; // A legacy/unusable proposal cannot become display data.
    }
  };
  return {
    maxBytes,
    sources,
    shown,
    async bySongId(id: string): Promise<LyricsEntry[]> {
      const path = await store.catalog.songPath(id);
      return path === null ? [] : await selected(id, path);
    },
    async legacy(query: { artist?: string; title?: string }) {
      const limit = Number(await state.getTyped('lyrics.legacyCandidates'));
      for (const song of await store.catalog.songsForLyrics(query, limit)) {
        const entry = (await selected(song.id, song.path))[0];
        if (entry) {
          return {
            artist: query.artist ?? null,
            title: query.title ?? null,
            text: entry.lines.map((line) => line.text).join('\n'),
          };
        }
      }
      return null;
    },
    async reconcile(
      songId: string,
      library: { id: string; path: string },
      all: LyricsSource[],
    ) {
      const versions = new Map<string, LyricsSource>();
      for (const source of all) {
        versions.set(await lyricsHash(source.entry), source);
      }
      const local = versions.size > 1 && await libraryImagesWritable(library)
        ? [...versions].map(([imageHash, source]) => ({
          imageHash,
          imageExt: 'lyrics',
          libraryId: library.id,
          origin: source.origin === 'embedded'
            ? songId
            : source.origin.slice(library.path.length + 1),
          details: { lyrics: source },
        }))
        : [];
      await store.candidates.replaceLocal(songId, local, 'lyrics');
    },
  };
}
