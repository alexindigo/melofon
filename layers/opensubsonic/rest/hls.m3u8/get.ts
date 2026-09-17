// layers/opensubsonic/rest/hls.m3u8/get.ts — GET /rest/hls.m3u8: the HLS
// playlist for a video (iSub's video path — it never calls stream.view).
// Success is NOT the Subsonic envelope: application/vnd.apple.mpegurl.
// Errors are the usual envelope (code 10 missing id, 70 unknown id — XML
// unless f=json, per the endpoint doc).
//
// Airsonic HLSController shape (probed, copied): several bitRate → a variant
// playlist (#EXT-X-STREAM-INF rungs pointing back at this endpoint with one
// bitRate each); zero or one → a media playlist of 10s segments plus the
// remainder, ending in #EXT-X-ENDLIST (VOD). Segment URLs live under /rest/
// (the claimed prefix) and carry this request's credential query — AVPlayer
// sends no cookies. OpenSubsonic says `bitRate` (repeatable, 1000@WxH);
// Airsonic's segment URLs say `maxBitRate` — both are accepted (iSub's
// source is not public and no captured log exists; plan §3).
import { fail, notFound } from '#opensubsonic/envelope.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

const SEGMENT_SECONDS = 10;

// The credential query params AVPlayer needs echoed onto every URL.
const AUTH_KEYS = ['u', 'p', 't', 's', 'v', 'c'];

function authQuery(params: URLSearchParams): string {
  const q = new URLSearchParams();
  for (const key of AUTH_KEYS) {
    const value = params.get(key);
    if (value !== null) q.set(key, value);
  }
  const s = q.toString();
  return s === '' ? '' : `&${s}`;
}

interface Rung {
  kbps: number;
  size?: string; // WxH from bitRate=1000@480x360
}

function segmentUrl(
  id: string,
  index: number,
  duration: number,
  rung: Rung | undefined,
  auth: string,
): string {
  let url = `/rest/hls/segment.ts?id=${encodeURIComponent(id)}` +
    `&segmentIndex=${index}&duration=${duration}`;
  if (rung !== undefined) {
    url += `&bitRate=${rung.kbps}`;
    if (rung.size !== undefined) url += `&size=${rung.size}`;
  }
  return url + auth;
}

export default async (_request: HatRequest, context: HatContext) => {
  const params = context.state.params!;
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const song = await context.app.library.getSong(id);
  if (song === null) return notFound(context);
  if (song.durationMs === null || song.durationMs <= 0) {
    return fail(context, 0, 'unknown duration');
  }

  const rungs: Rung[] = [];
  for (
    const raw of [
      ...params.getAll('bitRate'),
      ...params.getAll('maxBitRate'),
    ]
  ) {
    const m = /^(\d+)(?:@(\d+x\d+))?$/.exec(raw);
    if (m === null) return fail(context, 10, `invalid bitRate: ${raw}`);
    rungs.push({ kbps: Number(m[1]), size: m[2] });
  }

  const auth = authQuery(params);
  const lines: string[] = ['#EXTM3U', '#EXT-X-VERSION:1'];
  if (rungs.length > 1) {
    // Variant playlist: one rung per requested bitrate, each pointing back
    // at this endpoint with that single bitRate (Airsonic's shape).
    for (const rung of rungs) {
      lines.push(
        `#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=${rung.kbps * 1000}`,
      );
      lines.push(
        `/rest/hls.m3u8?id=${encodeURIComponent(id)}&bitRate=${rung.kbps}` +
          (rung.size === undefined ? '' : `@${rung.size}`) + auth,
      );
    }
  } else {
    // Media playlist: 10s segments plus the remainder (VOD, ENDLIST).
    const rung = rungs[0];
    const total = Math.round(song.durationMs / 1000);
    lines.push(`#EXT-X-TARGETDURATION:${SEGMENT_SECONDS}`);
    const full = Math.floor(total / SEGMENT_SECONDS);
    for (let i = 0; i < full; i++) {
      lines.push(`#EXTINF:${SEGMENT_SECONDS},`);
      lines.push(segmentUrl(id, i, SEGMENT_SECONDS, rung, auth));
    }
    const remainder = total % SEGMENT_SECONDS;
    if (remainder > 0) {
      lines.push(`#EXTINF:${remainder},`);
      lines.push(segmentUrl(id, full, remainder, rung, auth));
    }
    lines.push('#EXT-X-ENDLIST');
  }
  return new Response(lines.join('\n') + '\n', {
    headers: { 'content-type': 'application/vnd.apple.mpegurl' },
  });
};
