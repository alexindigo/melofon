// layers/opensubsonic/rest/hls/segment.ts/get.ts — GET /rest/hls/segment.ts:
// one 10s MPEG-TS slice of a video. app.media remuxes (stream copy) into the
// dataDir cache ({dataDir}/hls/<id>/<bitRate>/); the muxer writes
// index.m3u8 last, so its presence marks a complete cache dir. A remux
// failure is 503 (never a stack); a segment index past the last slice is
// 404. `duration` is the playlist's declared seconds — the wire contract,
// unused for serving. `size` (WxH from bitRate=1000@480x360) is accepted and
// ignored (no rescale in M4.6).
import { fail, notFound } from '#opensubsonic/envelope.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const params = context.state.params!;
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const song = await context.app.library.getSong(id);
  if (song === null) return notFound(context);

  const rawIndex = params.get('segmentIndex');
  const segmentIndex = rawIndex === null ? NaN : Number(rawIndex);
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0) {
    return fail(context, 10, 'segmentIndex must be a non-negative integer');
  }
  // bitRate becomes a cache path component — digits only, never raw input.
  const rawBitRate = params.get('bitRate') ?? params.get('maxBitRate');
  if (rawBitRate !== null && !/^\d+$/.test(rawBitRate)) {
    return fail(context, 10, 'bitRate must be an integer');
  }
  const dataDir = context.app.cfg.dataDir;
  if (dataDir === undefined) {
    return new Response(null, { status: 503 });
  }

  const dir = `${dataDir}/hls/${id}/${rawBitRate ?? 'source'}`;
  const cached = await Deno.stat(`${dir}/index.m3u8`).then(
    (stat) => stat.isFile,
    () => false,
  );
  if (!cached) {
    const count = await context.app.media.hlsRemux(song.path, dir);
    if (count === null) return new Response(null, { status: 503 });
  }

  try {
    const bytes = await Deno.readFile(`${dir}/seg${segmentIndex}.ts`);
    return new Response(bytes, {
      headers: { 'content-type': 'video/MP2T' },
    });
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return new Response(null, { status: 404 });
    }
    throw err;
  }
};
