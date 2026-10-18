import type { LyricsEntryRow } from '#opensubsonic/types.ts';

// SongLyrics v1 is a strict projection: no kind, cueLine or agents escape.
// Local sources have one default vocal agent; none is emitted without cues.
export function structuredLyrics(entry: LyricsEntryRow, enhanced: boolean) {
  const cueLine = enhanced && entry.synced
    ? entry.lines.flatMap((line, index) =>
      line.cues?.length
        ? [{
          index,
          agentId: 'main',
          ...(line.start !== undefined ? { start: line.start } : {}),
          value: line.text,
          cue: line.cues.map(({ text, ...cue }) => ({ ...cue, value: text })),
        }]
        : []
    )
    : [];
  return {
    lang: entry.language,
    synced: entry.synced,
    ...(entry.offset !== undefined ? { offset: entry.offset } : {}),
    ...(entry.artist !== undefined ? { displayArtist: entry.artist } : {}),
    ...(entry.title !== undefined ? { displayTitle: entry.title } : {}),
    line: entry.lines.map((line) => ({
      ...(entry.synced && line.start !== undefined
        ? { start: line.start }
        : {}),
      value: line.text,
    })),
    ...(enhanced ? { kind: 'main' } : {}),
    ...(cueLine.length
      ? { agents: [{ id: 'main', role: 'main' }], cueLine }
      : {}),
  };
}
