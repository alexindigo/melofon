// layers/owntone/api/config/get.ts — GET /api/config. websocket_port 0: the
// hat serves no websocket (3688 is claimed for later but has no /ws tree).
// buildoptions is the reduced OwnTone set — no Websockets/Spotify/ALSA.
import type { HatContext } from '#owntone/types.ts';

export default (_request: unknown, context: HatContext) => ({
  websocket_port: 0,
  version: context.app.cfg.version ?? '0.0.0',
  buildoptions: ['ffmpeg'],
});
