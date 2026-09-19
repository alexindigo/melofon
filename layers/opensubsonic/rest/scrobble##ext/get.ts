// layers/opensubsonic/rest/scrobble/get.ts — GET /rest/scrobble.
// submission=true (or omitted — Navidrome defaults to true) is append-only:
// one listens row per id (never a play_count update; never from stream).
// submission=false is a now-playing notification: one core command —
// playback.reportPlaying replaces the (user, client) session row; never
// appends listens; the hat never touches the session table itself.
// Navidrome takes only the first id on this path; `position` is seconds.
import { fail, ok } from '#opensubsonic/envelope.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const params = context.state.params!;
  const ids = params.getAll('id');
  if (ids.length === 0) {
    return fail(context, 10, 'Required parameter is missing');
  }
  if (params.get('submission') === 'false') {
    const rawPosition = Number(params.get('position') ?? '0');
    await context.app.playback.reportPlaying({
      username: context.state.user!.username,
      client: params.get('c')!,
      trackId: ids[0],
      streamId: crypto.randomUUID(),
      positionMs: Number.isFinite(rawPosition) && rawPosition >= 0
        ? rawPosition * 1000
        : undefined,
    });
    return ok(context, {});
  }
  const times = params.getAll('time').map((t) => Number(t));
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
