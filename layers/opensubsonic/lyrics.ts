import type { LyricsEntryRow } from '#opensubsonic/types.ts';

type Cues = NonNullable<LyricsEntryRow['lines'][number]['cues']>;

/** Navidrome 18205366 model/lyrics_normalize.go:129–170, called by
 * server/subsonic/lyrics.go:236–245 with line.End. Core lines have no end,
 * so that fallback is absent here too. Never mutate the shared source facts. */
function normalizedCues(cues: Cues) {
  if (!cues.some((cue) => cue.end !== undefined)) return cues;
  const ends = cues.map((cue, i) => {
    const nextStart = cues[i + 1]?.start;
    const end = cue.end ?? nextStart;
    return end === undefined
      ? undefined
      : Math.max(cue.start, Math.min(end, nextStart ?? end));
  });
  const complete = ends.every((end) => end !== undefined);
  return cues.map(({ end: _end, ...cue }, i) => ({
    ...cue,
    ...(complete ? { end: ends[i] } : {}),
  }));
}

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
          cue: normalizedCues(line.cues).map(({ text, ...cue }) => ({
            ...cue,
            value: text,
          })),
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
