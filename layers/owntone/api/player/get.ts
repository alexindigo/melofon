// layers/owntone/api/player/get.ts — GET /api/player: the OwnTone player
// status from app.playback.playerView() — ENGINE ONLY (the HA media_player
// is plane A). Stopped means no current (no queue-head fallback): item_id 0
// and zeroed length/progress. The hat encodes; it does not merge stores.
// No artwork_url — the hat serves no /artwork here.
//
// The wire is OwnTone: no fields OwnTone does not have (plan
// command-provenance-wire-fix). Provenance lives in core's lastCommand()
// and the [cmd] log line — never in this payload.
import type { HatContext } from '#owntone/types.ts';

export default (_request: unknown, context: HatContext) => {
  const view = context.app.playback.playerView();
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
