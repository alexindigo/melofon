// layers/owntone/api/player/get.ts — GET /api/player: the OwnTone player
// status. Stopped shows the queue head with progress 0 (their fallback);
// an empty queue reports zeros. No artwork_url — the hat serves no /artwork.
import type { HatContext } from '#owntone/types.ts';

export default (_request: unknown, context: HatContext) => {
  const status = context.app.player.status();
  return {
    state: status.state,
    repeat: status.repeat,
    consume: status.consume,
    shuffle: status.shuffle,
    volume: status.volume,
    item_id: status.current?.id ?? 0,
    item_length_ms: status.itemLengthMs,
    item_progress_ms: status.itemProgressMs,
  };
};
