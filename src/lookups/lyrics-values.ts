import type { LyricsCue, LyricsEntry, LyricsLine } from '../lyrics.ts';
import { object } from './manifest.ts';

/** A candidate owns the whole set of language/sync variants from this source.
 * The plugin identity comes from the host, never from a submitted value. */
export interface LookupLyricsValue {
  url: string;
  entries: LyricsEntry[];
}

function text(raw: unknown): string {
  if (typeof raw !== 'string' || raw.includes('\0') || !raw.isWellFormed()) {
    throw new Error('Invalid lyrics text');
  }
  return raw;
}
function time(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw new Error('Invalid lyrics timing');
  }
  return raw;
}
function line(raw: unknown, synced: boolean): LyricsLine {
  const value = object(raw, ['text', 'start', 'cues']);
  const body = text(value.text);
  if (!synced && ('start' in value || 'cues' in value)) {
    throw new Error('Plain lyrics cannot contain timing');
  }
  const start = synced ? time(value.start) : undefined;
  let cues: LyricsCue[] | undefined;
  if ('cues' in value) {
    if (!Array.isArray(value.cues) || !value.cues.length) {
      throw new Error('Invalid lyrics cues');
    }
    const bytes = new TextEncoder().encode(body);
    let previousEnd = -1;
    let previousStart = start!;
    cues = Array.from(value.cues, (raw): LyricsCue => {
      const cue = object(raw, ['start', 'end', 'text', 'byteStart', 'byteEnd']);
      const cueStart = time(cue.start);
      const end = 'end' in cue ? time(cue.end) : undefined;
      if (cueStart < previousStart || (end !== undefined && end < cueStart)) {
        throw new Error('Unordered lyrics cue timing');
      }
      const byteStart = time(cue.byteStart);
      const byteEnd = time(cue.byteEnd);
      const cueText = text(cue.text);
      if (
        !cueText || byteStart <= previousEnd || byteEnd < byteStart ||
        byteEnd >= bytes.length ||
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
            bytes.subarray(byteStart, byteEnd + 1),
          ) !== cueText
      ) throw new Error('Invalid lyrics cue byte range');
      previousEnd = byteEnd;
      previousStart = cueStart;
      return {
        start: cueStart,
        ...(end === undefined ? {} : { end }),
        text: cueText,
        byteStart,
        byteEnd,
      };
    });
  }
  return {
    text: body,
    ...(start === undefined ? {} : { start }),
    ...(cues === undefined ? {} : { cues }),
  };
}
function entry(raw: unknown): LyricsEntry {
  const value = object(raw, [
    'language',
    'synced',
    'offset',
    'artist',
    'title',
    'lines',
  ]);
  const language = text(value.language);
  if (!language.trim() || typeof value.synced !== 'boolean') {
    throw new Error('Invalid lyrics entry');
  }
  if ('offset' in value && !Number.isSafeInteger(value.offset)) {
    throw new Error('Invalid lyrics offset');
  }
  if (!Array.isArray(value.lines) || !value.lines.length) {
    throw new Error('Missing lyrics lines');
  }
  const lines = Array.from(
    value.lines,
    (raw) => line(raw, value.synced as boolean),
  );
  if (!lines.some((line) => line.text.trim())) {
    throw new Error('Empty lyrics entry');
  }
  if (lines.some((line, i) => i > 0 && line.start! < lines[i - 1].start!)) {
    throw new Error('Unordered lyrics line timing');
  }
  return {
    language,
    synced: value.synced,
    ...(value.offset === undefined ? {} : { offset: value.offset as number }),
    ...(value.artist === undefined ? {} : { artist: text(value.artist) }),
    ...(value.title === undefined ? {} : { title: text(value.title) }),
    lines,
  };
}

export function parseLyricsValue(raw: unknown): LookupLyricsValue {
  const value = object(raw, ['url', 'entries']);
  const url = text(value.url);
  if (!['http:', 'https:'].includes(new URL(url).protocol)) {
    throw new Error('Invalid lyrics source URL');
  }
  if (!Array.isArray(value.entries) || !value.entries.length) {
    throw new Error('Missing lyrics entries');
  }
  return { url, entries: Array.from(value.entries, entry) };
}
