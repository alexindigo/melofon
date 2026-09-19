// layers/owntone/api/player/get.ts — GET /api/player: the OwnTone player
// status from app.playback.playerView() — THE shared read (engine wins, else
// the newest client now-playing report mirrored as a synthetic current).
// The hat encodes; it does not merge stores. Stopped engine shows the queue
// head with progress 0 (their fallback); an empty both-planes reports zeros.
// No artwork_url — the hat serves no /artwork here.
import type { HatContext } from '#owntone/types.ts';

export default async (_request: unknown, context: HatContext) => {
  const view = await context.app.playback.playerView();
  return {
    state: view.state,
    repeat: view.repeat,
    consume: view.consume,
    shuffle: view.shuffle,
    volume: view.volume,
    item_id: view.current?.id ?? 0,
    item_length_ms: view.itemLengthMs,
    item_progress_ms: view.itemProgressMs,
  };
};
