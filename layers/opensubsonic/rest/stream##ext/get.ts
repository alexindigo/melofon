// layers/opensubsonic/rest/stream/get.ts — GET /rest/stream.
// app.stream decides (M4): DirectPlay = original bytes, Range-aware;
// ExtractAudio = a video id + an audio `format` → in-process audio track.
// Every open reports the play to core (playback.reportPlaying, one id per
// open; completion/disconnect reports the stop — an older Range completing
// never clears a newer stream). Never a listens row — stream is not a
// scrobble. The hat only parses, calls, encodes.
import { fail, notFound } from '#opensubsonic/envelope.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const song = await context.app.library.getSong(id);
  if (song === null) return notFound(context);
  const rawBitRate = context.state.params!.get('maxBitRate');
  const maxBitRateKbps = rawBitRate !== null && /^\d+$/.test(rawBitRate)
    ? Number(rawBitRate)
    : undefined;
  const res = await context.app.stream.play(
    request._raw,
    { path: song.path, isVideo: song.isVideo },
    context.state.params!.get('format') ?? undefined,
    {
      username: context.state.user!.username,
      client: context.state.params!.get('c') ?? 'opensubsonic',
      trackId: song.id,
      streamId: crypto.randomUUID(),
    },
    maxBitRateKbps,
  );
  if (res === null) {
    return fail(context, 0, 'audio extraction failed');
  }
  return res;
};
