// src/media.ts — app.media: in-process media probing via node-av (N-API
// bindings to FFmpeg's libraries — never the ffmpeg/ffprobe CLI, never Deno
// FFI to libav; see ~/Documents/melofon/todos/ffmpeg-deno-ffi.md for the
// long-term binding TODO). Hats and scan see only this interface; nothing
// else in the tree imports node-av. M4 adds extractAudio (the stream
// decision's ExtractAudio branch): decode the file's audio track and
// re-encode to the requested audio format, buffered in memory — music
// videos are minutes, so an mp3 fits in a few MB.
import {
  AVMEDIA_TYPE_AUDIO,
  AVMEDIA_TYPE_VIDEO,
  Decoder,
  Demuxer,
  Encoder,
  FF_ENCODER_LIBMP3LAME,
  Muxer,
  pipeline,
} from 'node-av';

export interface Probe {
  durationMs: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface ExtractedAudio {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
}

export interface Media {
  /** Never throws: unreadable/unsupported media probes as all-null/false. */
  probe(path: string): Promise<Probe>;
  /** Audio track of `path` re-encoded to `format` (M4: 'mp3' only; more
   * profiles land with their milestones — M7 AAC). Null when the format has
   * no profile, the file has no audio stream, or the transcode fails. */
  extractAudio(path: string, format: string): Promise<ExtractedAudio | null>;
}

// ExtractAudio profiles: format → encoder + muxer + wire content type.
// The muxer names are FFmpeg's own ('mp3' = ID3-tagged MPEG audio).
const EXTRACT_PROFILES: Record<
  string,
  { encoder: typeof FF_ENCODER_LIBMP3LAME; muxer: string; contentType: string }
> = {
  mp3: {
    encoder: FF_ENCODER_LIBMP3LAME,
    muxer: 'mp3',
    contentType: 'audio/mpeg',
  },
};

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

    async extractAudio(path, format) {
      const profile = EXTRACT_PROFILES[format];
      if (profile === undefined) return null;
      let input: Demuxer | undefined;
      let decoder: Decoder | undefined;
      let encoder: Encoder | undefined;
      let output: Muxer | undefined;
      try {
        input = await Demuxer.open(path);
        const audio = input.audio();
        if (audio === undefined) return null; // no audio track to extract
        decoder = await Decoder.create(audio);
        // autoResample: decoded frames arrive in whatever rate/format/layout
        // the source carries; the encoder converts to what the codec accepts
        // (ffmpeg's implicit aresample).
        encoder = await Encoder.create(profile.encoder, { autoResample: true });
        const chunks: Uint8Array[] = [];
        output = await Muxer.open(
          {
            // FFmpeg may reuse the buffer after the callback — copy.
            write: (chunk: Uint8Array) => {
              chunks.push(new Uint8Array(chunk));
            },
          },
          // input carries the tags over (title/artist land in the ID3).
          { format: profile.muxer, input },
        );
        // NB: pipeline owns addStream on the muxer — adding one ourselves
        // makes two streams and the mp3 muxer rejects the header.
        await pipeline(input, decoder, encoder, output).completion;
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        return { bytes, contentType: profile.contentType };
      } catch (err) {
        console.warn(
          `[melofon] media: extractAudio(${format}) failed for ${path}: ${err}`,
        );
        return null;
      } finally {
        // pipeline closes the muxer on completion; close() is idempotent.
        await output?.close().catch(() => {});
        encoder?.[Symbol.dispose]();
        decoder?.[Symbol.dispose]();
        await input?.close().catch(() => {});
      }
    },
  };
}
