// src/media.ts — app.media: in-process media probing via node-av (N-API
// bindings to FFmpeg's libraries — never the ffmpeg/ffprobe CLI, never Deno
// FFI to libav; see ~/Documents/melofon/todos/ffmpeg-deno-ffi.md for the
// long-term binding TODO). Hats and scan see only this interface; nothing
// else in the tree imports node-av. M4 adds extractAudio (the stream
// decision's ExtractAudio branch): decode the file's audio track and
// re-encode to the requested audio format, buffered in memory — music
// videos are minutes, so an mp3 fits in a few MB. M4.6 adds hlsRemux:
// stream-copy (H.264 + AAC, no re-encode) into 10s MPEG-TS HLS segments in
// a caller-chosen cache dir. M6 adds decodePcm for the boots: the engine's
// current track decoded to raw interleaved PCM (44100/16-bit/stereo, the
// RAOP default quality in raop.c), streamed frame by frame.
import {
  AV_CHANNEL_LAYOUT_STEREO,
  AV_CODEC_ID_AAC,
  AV_CODEC_ID_H264,
  AV_SAMPLE_FMT_S16,
  AVMEDIA_TYPE_AUDIO,
  AVMEDIA_TYPE_VIDEO,
  AVSEEK_FLAG_BACKWARD,
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
  /** Remux a video into HLS: 10s MPEG-TS segments (`seg<N>.ts`) plus FFmpeg's
   * own `index.m3u8` in `outDir`. Stream copy — H.264 video + AAC audio only
   * (a transcode profile for other codecs is not M4.6). Returns the segment
   * count, or null when the file is not remuxable or the mux fails.
   * Concurrent calls for the same target share one run. */
  hlsRemux(path: string, outDir: string): Promise<number | null>;
  /** Audio track of `path` decoded to raw interleaved PCM — 44100 Hz,
   * 16-bit, stereo, the RAOP default quality (raop.c). Boots stream the
   * chunks to their sink; each chunk is one decoded frame's bytes (a copy,
   * safe after the frame is freed). `startMs` seeks (keyframe granularity)
   * for a pause → resume. Null when the file has no audio or the decoder
   * cannot be created; mid-stream errors propagate to the consumer. Breaking
   * out of the iteration cancels the decode and frees everything. */
  decodePcm(
    path: string,
    opts?: { startMs?: number },
  ): Promise<AsyncIterable<Uint8Array> | null>;
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

// The PCM contract every boot decodes to (RAOP's default quality).
const PCM_RATE = 44100;
const PCM_CHANNELS = 2;
const PCM_BYTES_PER_SAMPLE = 2 * PCM_CHANNELS; // s16le interleaved

// HLS segment length in seconds (Airsonic's SEGMENT_DURATION, probed).
const HLS_SEGMENT_SECONDS = 10;

export function createMedia(): Media {
  // One remux per target at a time (two clients asking for the same video
  // share the run, and the loser of the race never sees a half-written dir).
  const inflight = new Map<string, Promise<number | null>>();

  async function remux(path: string, outDir: string): Promise<number | null> {
    let input: Demuxer | undefined;
    let output: Muxer | undefined;
    try {
      input = await Demuxer.open(path);
      const video = input.video();
      if (video === undefined || video.codecpar.codecId !== AV_CODEC_ID_H264) {
        return null; // not an H.264 video — no M4.6 transcode profile
      }
      const audio = input.audio();
      if (audio !== undefined && audio.codecpar.codecId !== AV_CODEC_ID_AAC) {
        return null;
      }
      await Deno.mkdir(outDir, { recursive: true });
      output = await Muxer.open(`${outDir}/index.m3u8`, {
        format: 'hls',
        // input carries the metadata over (tags, dispositions).
        input,
        options: {
          hls_time: HLS_SEGMENT_SECONDS,
          hls_segment_filename: `${outDir}/seg%d.ts`,
        },
      });
      const videoIdx = output.addStream(video);
      const audioIdx = audio === undefined ? -1 : output.addStream(audio);
      for await (const packet of input.packets()) {
        if (packet === null) continue; // flush signal, not media
        if (packet.streamIndex === video.index) {
          await output.writePacket(packet, videoIdx);
        } else if (audio !== undefined && packet.streamIndex === audio.index) {
          await output.writePacket(packet, audioIdx);
        }
        packet.free();
      }
      await output.close();
      let count = 0;
      for await (const entry of Deno.readDir(outDir)) {
        if (/^seg\d+\.ts$/.test(entry.name)) count++;
      }
      return count;
    } catch (err) {
      console.warn(`[melofon] media: hlsRemux failed for ${path}: ${err}`);
      return null;
    } finally {
      // close() is idempotent; the normal path closed the muxer already.
      await output?.close().catch(() => {});
      await input?.close().catch(() => {});
    }
  }

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

    hlsRemux(path, outDir) {
      const key = `${path}\n${outDir}`;
      let pending = inflight.get(key);
      if (pending === undefined) {
        pending = remux(path, outDir).finally(() => inflight.delete(key));
        inflight.set(key, pending);
      }
      return pending;
    },

    async decodePcm(path, opts = {}) {
      let input: Demuxer;
      try {
        input = await Demuxer.open(path);
      } catch {
        return null; // not a media file FFmpeg recognizes
      }
      let decoder: Decoder;
      try {
        const audio = input.audio();
        if (audio === undefined) {
          await input.close();
          return null; // no audio track to decode
        }
        decoder = await Decoder.create(audio, {
          resample: {
            sampleRate: PCM_RATE,
            sampleFormat: AV_SAMPLE_FMT_S16,
            channelLayout: AV_CHANNEL_LAYOUT_STEREO,
          },
        });
        if (opts.startMs !== undefined && opts.startMs > 0) {
          // Keyframe granularity (AVSEEK_FLAG_BACKWARD): resume is allowed a
          // small overlap. Failure still decodes — from the start.
          await input.seek(
            opts.startMs / 1000,
            audio.index,
            AVSEEK_FLAG_BACKWARD,
          )
            .catch(() => -1);
        }
      } catch (err) {
        console.warn(`[melofon] media: decodePcm failed for ${path}: ${err}`);
        await input.close().catch(() => {});
        return null;
      }
      const frames = decoder.frames(input.packets());
      return (async function* () {
        try {
          for await (const frame of frames) {
            if (frame === null) continue; // flush signal, not media
            const plane = frame.data?.[0];
            if (plane !== undefined && frame.nbSamples > 0) {
              // Packed s16 stereo: nbSamples * 4 bytes (the plane can be
              // linesize-padded); copy — frame.free() reuses native memory.
              const bytes = frame.nbSamples * PCM_BYTES_PER_SAMPLE;
              const chunk = new Uint8Array(Math.min(bytes, plane.length));
              chunk.set(plane.subarray(0, chunk.length));
              yield chunk;
            }
            frame.free();
          }
        } finally {
          decoder[Symbol.dispose]();
          await input.close().catch(() => {});
        }
      })();
    },
  };
}
