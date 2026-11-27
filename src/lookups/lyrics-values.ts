import type {
  LyricsAgent,
  LyricsCue,
  LyricsEntry,
  LyricsLine,
  LyricsVocal,
} from '../lyrics.ts';
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
function endTime(value: Record<string, unknown>, start: number) {
  const end = 'end' in value ? time(value.end) : undefined;
  if (end !== undefined && end < start) throw new Error('Invalid lyrics end');
  return end;
}

function cueList(raw: unknown, body: string, start: number): LyricsCue[] {
  if (!Array.isArray(raw) || !raw.length) {
    throw new Error('Invalid lyrics cues');
  }
  const bytes = new TextEncoder().encode(body);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let previousEnd = -1;
  let previousStart = start;
  return Array.from(raw, (raw) => {
    const cue = object(raw, ['start', 'end', 'text', 'byteStart', 'byteEnd']);
    const cueStart = time(cue.start);
    const end = endTime(cue, cueStart);
    if (cueStart < previousStart) {
      throw new Error('Unordered lyrics cue timing');
    }
    const byteStart = time(cue.byteStart);
    const byteEnd = time(cue.byteEnd);
    const cueText = text(cue.text);
    if (
      !cueText || byteStart <= previousEnd || byteEnd < byteStart ||
      byteEnd >= bytes.length ||
      decoder.decode(bytes.subarray(byteStart, byteEnd + 1)) !== cueText
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

function vocalList(raw: unknown, lineStart: number, agents: Set<string>) {
  if (!Array.isArray(raw) || !raw.length || !agents.size) {
    throw new Error('Invalid lyrics vocal layers');
  }
  const seen = new Set<string>();
  return Array.from(raw, (item): LyricsVocal => {
    const value = object(item, ['agentId', 'text', 'start', 'end', 'cues']);
    const agentId = text(value.agentId);
    if (!agents.has(agentId) || seen.has(agentId)) {
      throw new Error('Invalid lyrics vocal agent reference');
    }
    seen.add(agentId);
    const body = text(value.text);
    const start = 'start' in value ? time(value.start) : undefined;
    const end = endTime(value, start ?? lineStart);
    return {
      agentId,
      text: body,
      ...(start === undefined ? {} : { start }),
      ...(end === undefined ? {} : { end }),
      cues: cueList(value.cues, body, start ?? lineStart),
    };
  });
}

function line(raw: unknown, synced: boolean, agents: Set<string>): LyricsLine {
  const value = object(raw, ['text', 'start', 'end', 'cues', 'vocals']);
  const body = text(value.text);
  if (!synced) {
    if (Object.keys(value).length !== 1) {
      throw new Error('Plain lyrics cannot contain timing');
    }
    return { text: body };
  }
  const start = time(value.start);
  const end = endTime(value, start);
  if ('cues' in value && 'vocals' in value) {
    throw new Error('Use either simple cues or vocal layers');
  }
  return {
    text: body,
    start,
    ...(end === undefined ? {} : { end }),
    ...('cues' in value ? { cues: cueList(value.cues, body, start) } : {}),
    ...('vocals' in value
      ? { vocals: vocalList(value.vocals, start, agents) }
      : {}),
  };
}

function agentList(raw: unknown): LyricsAgent[] {
  if (!Array.isArray(raw) || !raw.length) {
    throw new Error('Missing lyrics agents');
  }
  const ids = new Set<string>();
  const agents = Array.from(raw, (item): LyricsAgent => {
    const value = object(item, ['id', 'role', 'name']);
    const id = text(value.id);
    const role = value.role;
    if (!id.trim() || ids.has(id)) throw new Error('Invalid lyrics agent ID');
    if (
      role !== 'main' && role !== 'voice' && role !== 'bg' && role !== 'group'
    ) {
      throw new Error('Invalid lyrics agent role');
    }
    ids.add(id);
    return { id, role, ...('name' in value ? { name: text(value.name) } : {}) };
  });
  if (agents.filter((agent) => agent.role === 'main').length !== 1) {
    throw new Error('Expected exactly one main lyrics agent');
  }
  return agents;
}

function entry(raw: unknown): LyricsEntry {
  const value = object(raw, [
    'language',
    'synced',
    'kind',
    'agents',
    'offset',
    'artist',
    'title',
    'lines',
  ]);
  const language = text(value.language);
  if (!language.trim() || typeof value.synced !== 'boolean') {
    throw new Error('Invalid lyrics entry');
  }
  const kind = value.kind;
  if (
    'kind' in value && kind !== 'main' && kind !== 'translation' &&
    kind !== 'pronunciation'
  ) {
    throw new Error('Invalid lyrics kind');
  }
  const agents = 'agents' in value ? agentList(value.agents) : undefined;
  const agentIds = new Set(agents?.map((agent) => agent.id));
  if ('offset' in value && !Number.isSafeInteger(value.offset)) {
    throw new Error('Invalid lyrics offset');
  }
  if (!Array.isArray(value.lines) || !value.lines.length) {
    throw new Error('Missing lyrics lines');
  }
  const lines = Array.from(
    value.lines,
    (raw) => line(raw, value.synced as boolean, agentIds),
  );
  if (agents && !lines.some((line) => line.cues || line.vocals)) {
    throw new Error('Lyrics agents require cues');
  }
  if (!lines.some((line) => line.text.trim())) {
    throw new Error('Empty lyrics entry');
  }
  if (lines.some((line, i) => i > 0 && line.start! < lines[i - 1].start!)) {
    throw new Error('Unordered lyrics line timing');
  }
  return {
    language,
    synced: value.synced,
    ...(kind === 'main' || kind === 'translation' || kind === 'pronunciation'
      ? { kind }
      : {}),
    ...(agents ? { agents } : {}),
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
