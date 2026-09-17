// src/media.ts — app.media: in-process media probing via node-av (N-API
// bindings to FFmpeg's libraries — never the ffmpeg/ffprobe CLI, never Deno
// FFI to libav; see ~/Documents/melofon/todos/ffmpeg-deno-ffi.md for the
// long-term binding TODO). Hats and scan see only this interface; nothing
// else in the tree imports node-av.
import { AVMEDIA_TYPE_AUDIO, AVMEDIA_TYPE_VIDEO, Demuxer } from 'node-av';

export interface Probe {
  durationMs: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface Media {
  /** Never throws: unreadable/unsupported media probes as all-null/false. */
  probe(path: string): Promise<Probe>;
}

const EMPTY: Probe = { durationMs: null, hasVideo: false, hasAudio: false };

export function createMedia(): Media {
  return {
    async probe(path) {
      let input;
      try {
        input = await Demuxer.open(path);
      } catch {
        return EMPTY; // not a media file FFmpeg recognizes
      }
      try {
        // node-av's duration is fractional seconds (avformat microseconds);
        // 0 means unknown.
        const seconds = input.duration;
        const types = input.streams.map((s) => s.codecpar.codecType);
        return {
          durationMs: seconds > 0 ? Math.round(seconds * 1000) : null,
          hasVideo: types.includes(AVMEDIA_TYPE_VIDEO),
          hasAudio: types.includes(AVMEDIA_TYPE_AUDIO),
        };
      } finally {
        await input.close();
      }
    },
  };
}
