import type { Output, Outputs } from './player.ts';

/** Physical identity/lifecycle stays household-owned. Only target selection is
 * projected for an engine; a boot keeps this fixed scope for its whole life. */
export function outputPlayerId(row: Output): number | null {
  return row.playerId === undefined ? (row.selected ? 1 : null) : row.playerId;
}

export function playerOutputs(outputs: Outputs, playerId: number): Outputs {
  const project = (row: Output): Output => ({
    ...row,
    selected: outputPlayerId(row) === playerId,
  });
  return {
    ...outputs,
    list: (options) => outputs.list(options).map(project),
    get(id, options) {
      const row = outputs.get(id, options);
      return row ? project(row) : null;
    },
  };
}
