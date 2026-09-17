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

export interface StreamFile {
  path: string;
  isVideo: boolean;
}

// Subsonic `format` values that name an audio codec (M4 plan §1). `raw` —
// Subsonic's "no transcode" — is deliberately absent: it DirectPlays.
const AUDIO_FORMATS = new Set(['mp3', 'opus', 'aac', 'ogg']);

export interface StreamService {
  /** Stream one file path to the client (200 full / 206 partial). */
  file(request: Request, path: string): Promise<Response>;
  /** Decide DirectPlay vs ExtractAudio for a catalog file, then serve it.
   * Null when the decision was ExtractAudio but the extraction failed (the
   * hat renders its own error envelope). */
  play(
    request: Request,
    file: StreamFile,
    format?: string,
  ): Promise<Response | null>;
}

export function createStream(media: Media): StreamService {
  return {
    file(request, path) {
      return serveFile(request, path);
    },
    async play(request, file, format) {
      if (
        file.isVideo && format !== undefined && AUDIO_FORMATS.has(format)
      ) {
        const audio = await media.extractAudio(file.path, format);
        if (audio === null) return null;
        return new Response(audio.bytes, {
          headers: {
            'content-type': audio.contentType,
            'content-length': String(audio.bytes.length),
          },
        });
      }
      return serveFile(request, file.path);
    },
  };
}
