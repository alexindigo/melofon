// layers/opensubsonic/rest/stream/get.ts — GET /rest/stream.
// app.stream prepares DirectPlay or a live audio transcode; unrequested
// music-video containers become audio-only. HEAD shares headers, never encoding.
// Every open reports the play to core (playback.reportPlaying, one id per
// open; completion/disconnect reports the stop — an older Range completing
// never clears a newer stream). Never a listens row — stream is not a
// scrobble. The hat only parses, calls, encodes.
import { fail, notFound } from '#opensubsonic/envelope.ts';
import { mediaReadRequest } from '#opensubsonic/media-request.ts';
import { intParam, requiredParam } from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const source = await context.app.stream.source(id);
  if (source === null) return notFound(context);
  const rawBitRate = context.state.params!.get('maxBitRate');
  const maxBitRateKbps = rawBitRate !== null && /^\d+$/.test(rawBitRate)
    ? Number(rawBitRate)
    : undefined;
  const res = await context.app.stream.play(
    mediaReadRequest(request),
    source,
    context.state.params!.get('format') ?? undefined,
    source.trackId
      ? {
        username: context.state.user!.username,
        client: context.state.params!.get('c') ?? 'opensubsonic',
        trackId: source.trackId,
        streamId: crypto.randomUUID(),
      }
      : undefined,
    maxBitRateKbps,
    {
      timeOffset: intParam(context.state.params!, 'timeOffset', 0),
      estimateContentLength:
        context.state.params!.get('estimateContentLength') === 'true',
    },
  );
  if (res === null) {
    return fail(context, 0, 'audio extraction failed');
  }
  return res;
};
