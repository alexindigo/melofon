// layers/owntone/api/config/get.ts — GET /api/config. websocket_port tells
// the truth: the actual bind of this hat's claimed 3688 (after env remaps),
// where GET / upgrades to the notify socket. library_name: HA's
// test_connection KeyErrors without it. buildoptions gains Websockets.
import type { HatContext } from '#owntone/types.ts';

export default (_request: unknown, context: HatContext) => ({
  websocket_port: context.app.binds.actual('owntone', 3688),
  library_name: 'Melofon',
  version: context.app.cfg.version ?? '0.0.0',
  buildoptions: ['ffmpeg', 'Websockets'],
});
