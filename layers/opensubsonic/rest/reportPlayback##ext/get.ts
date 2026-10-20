// Wire contract: pinned Endpoints/reportplayback.md; validation error split:
// Navidrome server/subsonic/media_annotation.go:237-296.
import { fail, ok } from '#opensubsonic/envelope.ts';
import {
  decimalParam,
  optionalBool,
  requiredParam,
  safeIntegerParam,
} from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const mediaId = requiredParam(context, 'mediaId');
  if (mediaId instanceof Response) return mediaId;
  const mediaType = requiredParam(context, 'mediaType');
  if (mediaType instanceof Response) return mediaType;
  const position = requiredParam(context, 'positionMs');
  if (position instanceof Response) return position;
  const positionMs = safeIntegerParam(position);
  if (position.trim() === '' || positionMs === null) {
    return fail(context, 10, 'Invalid positionMs');
  }
  if (positionMs < 0) {
    return fail(context, 0, 'positionMs must be non-negative');
  }
  const state = requiredParam(context, 'state');
  if (state instanceof Response) return state;
  if (
    state !== 'starting' && state !== 'playing' && state !== 'paused' &&
    state !== 'stopped'
  ) {
    return fail(context, 0, `Invalid state: ${state}`);
  }
  const params = context.state.params!;
  const rawRate = params.get('playbackRate');
  const playbackRate = rawRate === null ? 1 : decimalParam(rawRate);
  if (playbackRate === null) return fail(context, 10, 'Invalid playbackRate');
  if (!Number.isFinite(playbackRate) || playbackRate <= 0) {
    return fail(context, 0, 'playbackRate must be a finite positive number');
  }
  if (mediaType !== 'song') return fail(context, 70, 'Media not found');
  const found = await context.app.playback.reportPlayback({
    username: context.state.user!.username,
    client: params.get('c')!,
    trackId: mediaId,
    positionMs,
    state,
    playbackRate,
    ignoreScrobble: optionalBool(params.get('ignoreScrobble')) ?? false,
  });
  return found ? ok(context, {}) : fail(context, 70, 'Media not found');
};
