import type { Output, Outputs } from './player.ts';

/** Physical identity/lifecycle stays household-owned. Only target selection is
 * projected for an engine; a boot keeps this fixed scope for its whole life. */
export function outputPlayerId(row: Output): number | null {
  return row.playerId === undefined ? (row.selected ? 1 : null) : row.playerId;
}

/** A move never alters physical identity or credentials, but ends all work
 * issued by that membership, even if it moves back before the await returns. */
export function outputAuthority(
  outputs: Pick<Outputs, 'get' | 'revision' | 'membershipRevision'>,
  id: string,
  options: { endpoint?: boolean } = {},
): () => boolean {
  const row = outputs.get(id);
  const revision = outputs.revision(id);
  const membership = outputs.membershipRevision(id);
  const key = (value: Output | null) =>
    value && JSON.stringify([
      outputPlayerId(value),
      value.type,
      value.host,
      value.port,
    ]);
  const endpoint = key(row);
  return () =>
    row !== null && outputs.revision(id) === revision &&
    outputs.membershipRevision(id) === membership &&
    (options.endpoint === false || key(outputs.get(id)) === endpoint &&
        (row.receiverIdentity === undefined ||
          outputs.get(id)?.receiverIdentity === row.receiverIdentity));
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
