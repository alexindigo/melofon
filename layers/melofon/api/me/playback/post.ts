import type { HatContext, HatRequest } from '#melofon/types.ts';
import { fail } from '#melofon/errors.ts';
import { playbackReport } from '#melofon/playback-report.ts';

export default async function (_request: HatRequest, context: HatContext) {
  const report = playbackReport(context);
  if (!await context.app.library.getSong(report.trackId)) {
    fail(404, 'not_found', 'Song not found');
  }
  if (!await context.app.playback.reportSessionPlayback(report)) {
    fail(409, 'playback_conflict', 'Playback report is no longer current');
  }
  return { accepted: true };
}
