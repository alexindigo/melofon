// src/stream.ts — app.stream: a decision, then bytes. The decision is
// DirectPlay | TranscodeAudio (audio and video alike — one path):
//   format=raw                DirectPlay (protocol's explicit no-transcode)
//   format absent             DirectPlay, unless MELOFON_STREAM_ABSENT_TO_MP3
//                             (dumb clients) or the maxBitRate ceiling kicks in
//   format == source codec    DirectPlay (probed codec, not the suffix)
//   format set, differs       TranscodeAudio, streaming (chunked, no
//                             content-length, no Range)
//   maxBitRate < source bitrate  transcode even when format is absent or
//                             matching (Navidrome's rule); value clamps the
//                             encoder. Keep the source codec when it has a
//                             profile, else mp3.
// No flac target (lossless clients DirectPlay). TranscodeVideo stays a named
// path only — not implemented. No listens here — stream is not a scrobble.
import { serveFile } from '@std/http/file-server';
import type { Media } from './media.ts';
import type { Playback } from './playback.ts';

export interface StreamFile {
  path: string;
  isVideo: boolean;
}

/** Who is listening, from the hat: one id per stream OPEN (each Range hit
 * mints its own). Start → playback.reportPlaying; request completion or
 * disconnect → playback.reportStopped (stale ids no-op there). */
export interface StreamIdentity {
  username: string;
  client: string;
  trackId: string;
  streamId: string;
}

type Decision =
  | { kind: 'direct' }
  | { kind: 'transcode'; format: string; bitRateKbps: number };

export interface StreamService {
  /** Stream one file path to the client (200 full / 206 partial). */
  file(
    request: Request,
    path: string,
    identity?: StreamIdentity,
  ): Promise<Response>;
  /** Decide DirectPlay vs TranscodeAudio for a catalog file, then serve it.
   * Null when the decision needed a transcode that failed pre-flight (no
   * audio / no such target / encoder missing) — the hat renders its error
   * envelope. `maxBitRateKbps` is the Subsonic maxBitRate (kbps). */
  play(
    request: Request,
    file: StreamFile,
    format?: string,
    identity?: StreamIdentity,
    maxBitRateKbps?: number,
  ): Promise<Response | null>;
}

// Transcode targets (the plan's no-flac-target rule lives in app.media).
const TRANSCODE_TARGETS = new Set(['mp3', 'aac', 'opus', 'ogg']);
const PROFILE_DEFAULT_KBPS: Record<string, number> = {
  mp3: 192,
  aac: 160,
  opus: 128,
  ogg: 192,
};

export function createStream(
  media: Media,
  playback?: Playback,
  cfg?: { absentToMp3?: boolean },
): StreamService {
  // reportPlaying at open; reportStopped when the response is done (either
  // way — delivered or disconnected; request.signal aborts on both under
  // Deno's current legacy behavior). Stale streamIds no-op downstream.
  const hook = (request: Request, identity?: StreamIdentity) => {
    if (playback === undefined || identity === undefined) return;
    void playback.reportPlaying(identity);
    request.signal.addEventListener(
      'abort',
      () => void playback.reportStopped({ streamId: identity.streamId }),
      { once: true },
    );
  };

  const decide = async (
    file: StreamFile,
    format: string | undefined,
    maxBitRateKbps: number | undefined,
  ): Promise<Decision> => {
    if (format === 'raw') return { kind: 'direct' };

    // The probe is needed only when a format or a ceiling is in play.
    const probed = (format !== undefined || maxBitRateKbps !== undefined)
      ? await media.probe(file.path)
      : null;
    const sourceCodec = probed?.audioCodec ?? null;
    const sourceBitrateKbps = probed?.bitrateKbps ?? null;

    // Navidrome's ceiling rule: transcode when the source is over maxBitRate,
    // even when the format is absent or already matches. 0 = "no limit".
    const ceiling = maxBitRateKbps !== undefined && maxBitRateKbps > 0 &&
      sourceBitrateKbps !== null && sourceBitrateKbps > maxBitRateKbps;
    const clamp = (profileDefault: number) =>
      maxBitRateKbps === undefined
        ? profileDefault
        : Math.min(profileDefault, maxBitRateKbps);

    if (format === undefined) {
      if (cfg?.absentToMp3 === true) {
        return {
          kind: 'transcode',
          format: 'mp3',
          bitRateKbps: clamp(PROFILE_DEFAULT_KBPS.mp3),
        };
      }
      if (ceiling) {
        const target =
          sourceCodec !== null && TRANSCODE_TARGETS.has(sourceCodec)
            ? sourceCodec
            : 'mp3';
        return {
          kind: 'transcode',
          format: target,
          bitRateKbps: clamp(PROFILE_DEFAULT_KBPS[target]),
        };
      }
      return { kind: 'direct' };
    }

    // No such target (flac, mkv, wav): DirectPlay — the no-flac-target rule
    // is "lossless clients get DirectPlay", not an error envelope.
    if (!TRANSCODE_TARGETS.has(format)) return { kind: 'direct' };
    if (format === sourceCodec && !ceiling) return { kind: 'direct' };
    return {
      kind: 'transcode',
      format,
      bitRateKbps: clamp(PROFILE_DEFAULT_KBPS[format]),
    };
  };

  return {
    file(request, path, identity) {
      hook(request, identity);
      return serveFile(request, path);
    },
    async play(request, file, format, identity, maxBitRateKbps) {
      const decision = await decide(file, format, maxBitRateKbps);
      if (decision.kind === 'transcode') {
        const audio = await media.transcodeAudio(file.path, decision.format, {
          bitRateKbps: decision.bitRateKbps,
        });
        if (audio === null) return null;
        hook(request, identity);
        // Chunked: no content-length, no accept-ranges. Subsonic `size`
        // fields stay the SOURCE size — never an estimate.
        return new Response(audio.stream, {
          headers: { 'content-type': audio.contentType },
        });
      }
      hook(request, identity);
      return serveFile(request, file.path);
    },
  };
}
