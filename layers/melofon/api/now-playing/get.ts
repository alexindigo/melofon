import type { HatContext, HatRequest } from '#melofon/types.ts';
import { nowPlayingPayload } from '#melofon/now-playing.ts';

export default async function (_request: HatRequest, context: HatContext) {
  // Positions are already extrapolated by core. Keep their observation clock
  // separate from the retained start/report anchors; clients must not advance
  // a returned position from the original report time a second time.
  const rows = await context.app.playback.nowPlayingView();
  return Response.json({
    nowPlaying: rows.map(nowPlayingPayload),
    observedAtMs: Date.now(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
