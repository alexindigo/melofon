import type { HatContext, SessionPlaybackReport } from './types.ts';
import { fail } from './errors.ts';
import { fields, text } from './input.ts';

/** Wire values only. Identity, device label, ordering and listens belong to core. */
export function playbackReport(context: HatContext): SessionPlaybackReport {
  const body = fields(context, [
    'songId',
    'run',
    'sequence',
    'state',
    'positionMs',
    'playbackRate',
    'ignoreScrobble',
  ]);
  const trackId = text(body, 'songId');
  if (!trackId.trim()) fail(400, 'invalid_field', 'songId must not be empty');
  for (const key of ['run', 'sequence', 'positionMs']) {
    if (
      !Number.isSafeInteger(body[key]) ||
      (body[key] as number) < (key === 'run' ? 1 : 0)
    ) {
      fail(
        400,
        'invalid_field',
        `${key} must be a ${
          key === 'run' ? 'positive' : 'non-negative'
        } safe integer`,
      );
    }
  }
  const state = body.state;
  if (
    state !== 'starting' && state !== 'playing' && state !== 'paused' &&
    state !== 'stopped'
  ) {
    fail(
      400,
      'invalid_field',
      'state must be starting, playing, paused or stopped',
    );
  }
  const playbackRate = body.playbackRate === undefined ? 1 : body.playbackRate;
  if (
    typeof playbackRate !== 'number' || !Number.isFinite(playbackRate) ||
    playbackRate <= 0
  ) {
    fail(400, 'invalid_field', 'playbackRate must be a finite positive number');
  }
  const ignoreScrobble = body.ignoreScrobble === undefined
    ? false
    : body.ignoreScrobble;
  if (typeof ignoreScrobble !== 'boolean') {
    fail(400, 'invalid_field', 'ignoreScrobble must be a boolean');
  }
  return {
    userId: context.state.user.id,
    sessionId: context.state.sessionId,
    trackId,
    run: body.run as number,
    sequence: body.sequence as number,
    state,
    positionMs: body.positionMs as number,
    playbackRate,
    ignoreScrobble,
  };
}
