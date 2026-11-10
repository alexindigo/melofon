import type { HatContext, PlayerRow } from './types.ts';
import { fail } from './errors.ts';
import { nowPlayingPayload } from './now-playing.ts';

export function playerId(raw: string): number {
  const id = Number(raw);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(id)) {
    fail(404, 'not_found', 'Player not found');
  }
  return id;
}

export function playerSummary({ id, name, isDefault }: PlayerRow) {
  return { id, name, isDefault };
}

/** Encode only household-safe facts, never source paths or private provenance. */
export function playerPayload(context: HatContext, id: number) {
  const playback = context.app.players.get(id);
  const row = context.app.players.list().find((row) => row.id === id)!;
  const status = playback.playerView();
  const current = playback.serverNowPlayingView();
  return {
    ...playerSummary(row),
    state: status.state,
    repeat: status.repeat,
    consume: status.consume,
    shuffle: status.shuffle,
    volume: status.volume,
    positionMs: status.itemProgressMs,
    durationMs: status.itemLengthMs,
    capabilities: status.capabilities,
    current: current === null ? null : {
      entryId: current.entryId,
      ...nowPlayingPayload(current),
    },
    speakers: context.app.players.members(id).map(({ id, name, linked }) => ({
      id,
      name,
      linked: linked ?? true,
    })),
  };
}
