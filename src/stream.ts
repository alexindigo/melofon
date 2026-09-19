// src/stream.ts — app.stream: a decision, then bytes (M4). The decision is
// DirectPlay | ExtractAudio | TranscodeVideo:
//   DirectPlay      original file with HTTP Range (std serveFile)
//   ExtractAudio    video file + `format` naming an audio codec → app.media
//                   (in-process node-av), served as one full response
//   TranscodeVideo  a named path only — not implemented (Jellyfin-style
//                   encode later; never the ffmpeg CLI)
// No listens are recorded here — stream is not a scrobble (that is M2's
// scrobble endpoint).
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

// Subsonic `format` values that name an audio codec (M4 plan §1). `raw` —
// Subsonic's "no transcode" — is deliberately absent: it DirectPlays.
const AUDIO_FORMATS = new Set(['mp3', 'opus', 'aac', 'ogg']);

export interface StreamService {
  /** Stream one file path to the client (200 full / 206 partial). */
  file(
    request: Request,
    path: string,
    identity?: StreamIdentity,
  ): Promise<Response>;
  /** Decide DirectPlay vs ExtractAudio for a catalog file, then serve it.
   * Null when the decision was ExtractAudio but the extraction failed (the
   * hat renders its own error envelope). */
  play(
    request: Request,
    file: StreamFile,
    format?: string,
    identity?: StreamIdentity,
  ): Promise<Response | null>;
}

export function createStream(
  media: Media,
  playback?: Playback,
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
  return {
    file(request, path, identity) {
      hook(request, identity);
      return serveFile(request, path);
    },
    async play(request, file, format, identity) {
      if (
        file.isVideo && format !== undefined && AUDIO_FORMATS.has(format)
      ) {
        const audio = await media.extractAudio(file.path, format);
        if (audio === null) return null;
        hook(request, identity);
        return new Response(audio.bytes, {
          headers: {
            'content-type': audio.contentType,
            'content-length': String(audio.bytes.length),
          },
        });
      }
      hook(request, identity);
      return serveFile(request, file.path);
    },
  };
}
