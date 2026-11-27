import type { LyricsCueRow, LyricsEntryRow } from '#opensubsonic/types.ts';

/** Navidrome 18205366 model/lyrics_normalize.go:129–170, called by
 * server/subsonic/lyrics.go:236–245 with line.End. For separate vocal groups
 * use the group's end when known. Never mutate the shared source facts. */
function normalizedCues(cues: LyricsCueRow[], fallbackEnd?: number) {
  if (!cues.some((cue) => cue.end !== undefined)) return cues;
  const ends = cues.map((cue, i) => {
    const nextStart = cues[i + 1]?.start;
    const end = cue.end ?? nextStart ?? fallbackEnd;
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

function cueLines(entry: LyricsEntryRow) {
  // Preserve the existing default agent for unattributed word cues.
  const agents = entry.agents ?? [{ id: 'main', role: 'main' }];
  const mainId = agents.find((agent) => agent.role === 'main')!.id;
  const cueLine = entry.lines.flatMap((line, index) => {
    const vocals = line.vocals ??
      (line.cues?.length
        ? [{ ...line, agentId: mainId, cues: line.cues }]
        : []);
    return vocals.toSorted((a, b) => {
      if (a.agentId === b.agentId) return 0;
      if (a.agentId === mainId) return -1;
      return b.agentId === mainId ? 1 : 0;
    }).map((layer) => {
      const start = layer.start ?? line.start;
      const end = layer.end ?? (line.end !== undefined &&
          (start === undefined || line.end >= start)
        ? line.end
        : undefined);
      return {
        index,
        agentId: layer.agentId,
        ...(start !== undefined ? { start } : {}),
        ...(end !== undefined ? { end } : {}),
        value: layer.text,
        cue: normalizedCues(layer.cues, end).map(({ text, ...cue }) => ({
          ...cue,
          value: text,
        })),
      };
    });
  });
  return cueLine.length ? { agents, cueLine } : {};
}

// SongLyrics v1 is a strict projection: no kind, cueLine, agents or ends.
export function structuredLyrics(entry: LyricsEntryRow, enhanced: boolean) {
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
      ...(enhanced && entry.synced && line.end !== undefined
        ? { end: line.end }
        : {}),
      value: line.text,
    })),
    ...(enhanced ? { kind: entry.kind ?? 'main' } : {}),
    ...(enhanced && entry.synced ? cueLines(entry) : {}),
  };
}
