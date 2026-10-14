// Native diagnostic DTOs: explicit detached views of the owners' existing records.
import type { CommandSource, LastCommand, OutputCommand } from './player.ts';

export interface CommandSourceView {
  kind: CommandSource['kind'];
  via?: string;
  peer?: string;
  userAgent?: string;
  user?: string;
  client?: string;
}

export interface PlaybackCommandView {
  kind: string;
  detail?: string;
  source: CommandSourceView;
  atMs: number;
  intent: LastCommand['intent'];
  queueCleared: boolean;
}

export interface OutputCommandView {
  kind: OutputCommand['kind'];
  source: CommandSourceView;
  selection?: { id: string; selected: boolean }[];
}

export interface CommandProvenanceView {
  playback: PlaybackCommandView | null;
  outputs: OutputCommandView | null;
}

function projectSource(source: CommandSource): CommandSourceView {
  const view: CommandSourceView = { kind: source.kind };
  for (const key of ['via', 'peer', 'userAgent', 'user', 'client'] as const) {
    const value = source[key];
    if (typeof value === 'string') view[key] = value;
  }
  return view;
}

/** No recording, caching or inference; output records have no timestamp. */
export function projectCommandProvenance(
  playback: LastCommand | null,
  outputs: OutputCommand | null,
): CommandProvenanceView {
  return {
    playback: playback === null ? null : {
      kind: playback.kind,
      ...(typeof playback.detail === 'string'
        ? { detail: playback.detail }
        : {}),
      source: projectSource(playback.source),
      atMs: playback.atMs,
      intent: playback.intent,
      queueCleared: playback.queueCleared,
    },
    outputs: outputs === null ? null : {
      kind: outputs.kind,
      source: projectSource(outputs.source),
      ...(outputs.selection === undefined ? {} : {
        selection: outputs.selection.map((entry) => ({
          id: entry.id,
          selected: entry.selected,
        })),
      }),
    },
  };
}
