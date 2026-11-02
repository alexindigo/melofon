// layers/opensubsonic/rest/scrobble/get.ts — GET /rest/scrobble.
// `submission` is true when missing or empty, else exactly when it is
// `true`, `on` or `1` in any case (Navidrome's req.Bool); every other value
// is a now-playing notification.
// A submission is append-only: one listens row per known id (never a
// play_count update; never from stream); ids outside the catalog are skipped
// and the answer is still ok. When `time` values are sent, there must be one
// per id (Navidrome: code 0 otherwise).
// A now-playing notification is one core command — playback.reportPlayback
// updates the (user, client) playing session; it never appends listens and the
// hat never touches the session table itself. Navidrome takes only the first
// id on this path; `position` is seconds.
import { fail, ok } from '#opensubsonic/envelope.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

const TRUE = new Set(['true', 'on', '1']);

export default async (_request: HatRequest, context: HatContext) => {
  const params = context.state.params!;
  const ids = params.getAll('id');
  if (ids.length === 0) {
    return fail(context, 10, 'Required parameter is missing');
  }
  const flag = params.get('submission');
  const submission = flag === null || flag === '' ||
    TRUE.has(flag.toLowerCase());
  if (!submission) {
    const rawPosition = Number(params.get('position') ?? '0');
    await context.app.playback.reportPlayback({
      source: 'opensubsonic',
      username: context.state.user!.username,
      client: params.get('c')!,
      trackId: ids[0],
      state: 'playing',
      playbackRate: 1,
      ignoreScrobble: false,
      positionMs: Number.isFinite(rawPosition) && rawPosition >= 0
        ? rawPosition * 1000
        : 0,
    });
    return ok(context, {});
  }
  const rawTimes = params.getAll('time');
  if (rawTimes.length > 0 && rawTimes.length !== ids.length) {
    return fail(
      context,
      0,
      `Wrong number of timestamps: ${rawTimes.length}, should be ${ids.length}`,
    );
  }
  const times = rawTimes.map((t) => Number(t));
  for (let i = 0; i < ids.length; i++) {
    const playedAtMs = Number.isFinite(times[i]) && times[i] > 0
      ? times[i]
      : undefined;
    await context.app.listens.record(context.state.user!.username, ids[i], {
      source: 'opensubsonic',
      playedAtMs,
    });
  }
  return ok(context, {});
};
