// layers/owntone/api/player/get.ts — GET /api/player: the OwnTone player
// status from app.playback.playerView() — ENGINE ONLY (the HA media_player
// is plane A). Stopped means no current (no queue-head fallback): item_id 0
// and zeroed length/progress. The hat encodes; it does not merge stores.
// No artwork_url — the hat serves no /artwork here.
import type { HatContext, LastCommandRow } from '#owntone/types.ts';

/** The wire shape of the engine's last-mutation record (plan
 * command-provenance): additive — clients that don't know it ignore it. */
function lastCommandPayload(cmd: LastCommandRow | null) {
  if (cmd === null) return null;
  return {
    kind: cmd.kind,
    ...(cmd.detail !== undefined ? { detail: cmd.detail } : {}),
    source: cmd.source,
    atMs: cmd.atMs,
  };
}

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
    last_command: lastCommandPayload(context.app.playback.lastCommand()),
  };
};
