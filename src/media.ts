// src/media.ts — app.media: in-process media probing via node-av (N-API
// bindings to FFmpeg's libraries — never the ffmpeg/ffprobe CLI, never Deno
// FFI to libav; see ~/Documents/melofon/todos/ffmpeg-deno-ffi.md for the
// long-term binding TODO). Hats and scan see only this interface; nothing
// else in the tree imports node-av. M4.6 adds hlsRemux: stream-copy (H.264 +
// AAC, no re-encode) into 10s MPEG-TS HLS segments in a caller-chosen cache
// dir. M6 adds decodePcm for the boots: the engine's current track decoded
// to raw interleaved PCM (44100/16-bit/stereo, the RAOP default quality in
// raop.c), streamed frame by frame. The transcode slice adds transcodeAudio:
// decode → encode → mux, STREAMED through the muxer's write callback into a
// ReadableStream (chunked HTTP, never buffered whole, no ffmpeg CLI).
import {
  AV_CHANNEL_LAYOUT_STEREO,
  AV_CODEC_ID_AAC,
  AV_CODEC_ID_ALAC,
  AV_CODEC_ID_FLAC,
  AV_CODEC_ID_H264,
  AV_CODEC_ID_MP3,
  AV_CODEC_ID_OPUS,
  AV_CODEC_ID_VORBIS,
  AV_NOPTS_VALUE,
  AV_SAMPLE_FMT_S16,
  AV_TIME_BASE,
  AV_TIME_BASE_Q,
  AVMEDIA_TYPE_AUDIO,
  AVMEDIA_TYPE_VIDEO,
  avRescaleQ,
  AVSEEK_FLAG_BACKWARD,
  Decoder,
  Demuxer,
  Encoder,
  FF_ENCODER_AAC,
  FF_ENCODER_LIBMP3LAME,
  FF_ENCODER_LIBOPUS,
  FF_ENCODER_LIBVORBIS,
  FFmpegError,
  Log as FFmpegLog,
  Muxer,
  pipeline,
} from 'node-av';
import { type Log, scopedLog } from './logging.ts';

const ffmpegLevel = FFmpegLog.getLevel();
FFmpegLog.setCallback(
  (sourceLevel, payload) =>
    scopedLog('media-native').event('dependency_ffmpeg', {
      sourceLevel,
      payload,
    }),
  { maxLevel: ffmpegLevel },
);

/** The audio codec as a format token ('mp3', 'aac', 'ogg', …) when known. */
export type AudioCodecToken = string;

export interface Probe {
  durationMs: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  /** Container bitrate in kbps (0/unknown → null) — the maxBitRate ceiling. */
  bitrateKbps: number | null;
  /** The audio stream's codec as a format token, null when unknown/absent. */
  audioCodec: AudioCodecToken | null;
}

export interface TranscodedAudio {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
}

export interface ExtractedAudio {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
}

export interface Media {
  /** Never throws: unreadable/unsupported media probes as all-null/false. */
  probe(path: string): Promise<Probe>;
  /** Audio track of `path` re-encoded to `format`, STREAMED: the muxer write
   * callback feeds a ReadableStream (client-paced via desiredSize
   * backpressure; client disconnect aborts the pipeline). Null when the
   * format has no profile, the file has no audio stream, or the encoder
   * cannot be created — pre-flight happens before any byte leaves, so the
   * hat's error envelope stays reachable. `bitRateKbps` clamps the profile's
   * default (maxBitRate). */
  transcodeAudio(
    path: string,
    format: string,
    opts?: { bitRateKbps?: number },
  ): Promise<TranscodedAudio | null>;
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
   * for a pause → resume. Null when the file has no audio, seeking fails, or
   * the decoder cannot be created; mid-stream errors propagate. Breaking
   * out of the iteration cancels the decode and frees everything. */
  decodePcm(
    path: string,
    opts?: { startMs?: number },
  ): Promise<AsyncIterable<Uint8Array> | null>;
}

// Transcode profiles: format → encoder + muxer + wire content type + default
// bitrate. The muxer names are FFmpeg's own ('adts' = raw AAC frames).
// No flac target: streaming flac needs the STREAMINFO patch Navidrome
// carries; lossless clients DirectPlay.
const TRANSCODE_PROFILES: Record<
  string,
  {
    encoder:
      | typeof FF_ENCODER_LIBMP3LAME
      | typeof FF_ENCODER_AAC
      | typeof FF_ENCODER_LIBOPUS
      | typeof FF_ENCODER_LIBVORBIS;
    muxer: string;
    contentType: string;
    bitRateKbps: number;
  }
> = {
  mp3: {
    encoder: FF_ENCODER_LIBMP3LAME,
    muxer: 'mp3',
    contentType: 'audio/mpeg',
    bitRateKbps: 192,
  },
  aac: {
    encoder: FF_ENCODER_AAC,
    muxer: 'adts',
    contentType: 'audio/aac',
    bitRateKbps: 160,
  },
  opus: {
    encoder: FF_ENCODER_LIBOPUS,
    muxer: 'ogg',
    contentType: 'audio/ogg',
    bitRateKbps: 128,
  },
  ogg: {
    encoder: FF_ENCODER_LIBVORBIS,
    muxer: 'ogg',
    contentType: 'audio/ogg',
    bitRateKbps: 192,
  },
};

// Demuxer codec id → the format token the stream decision compares against.
function audioCodecToken(codecId: number): string | null {
  switch (codecId) {
    case AV_CODEC_ID_MP3:
      return 'mp3';
    case AV_CODEC_ID_AAC:
      return 'aac';
    case AV_CODEC_ID_OPUS:
      return 'opus';
    case AV_CODEC_ID_VORBIS:
      return 'ogg';
    case AV_CODEC_ID_FLAC:
      return 'flac';
    case AV_CODEC_ID_ALAC:
      return 'alac';
    default:
      return null;
  }
}

const EMPTY: Probe = {
  durationMs: null,
  hasVideo: false,
  hasAudio: false,
  bitrateKbps: null,
  audioCodec: null,
};

// The PCM contract every boot decodes to (RAOP's default quality).
const PCM_RATE = 44100;
const PCM_CHANNELS = 2;
const PCM_BYTES_PER_SAMPLE = 2 * PCM_CHANNELS; // s16le interleaved

// HLS segment length in seconds (Airsonic's SEGMENT_DURATION, probed).
const HLS_SEGMENT_SECONDS = 10;

export function createMedia(log: Log = scopedLog('media')): Media {
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
      log.event('media_failed', { operation: 'hlsRemux', path, error: err });
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
        // 0 means unknown. bitRate is the container bitrate in kbps.
        const seconds = input.duration;
        const types = input.streams.map((s) => s.codecpar.codecType);
        const audio = input.audio();
        const bitrateKbps = input.bitRate;
        return {
          durationMs: seconds > 0 ? Math.round(seconds * 1000) : null,
          hasVideo: types.includes(AVMEDIA_TYPE_VIDEO),
          hasAudio: types.includes(AVMEDIA_TYPE_AUDIO),
          bitrateKbps: bitrateKbps > 0 ? bitrateKbps : null,
          audioCodec: audio === undefined
            ? null
            : audioCodecToken(audio.codecpar.codecId),
        };
      } finally {
        await input.close();
      }
    },

    async transcodeAudio(path, format, opts = {}) {
      const profile = TRANSCODE_PROFILES[format];
      if (profile === undefined) return null; // no such target (e.g. flac)
      const bitRateKbps = Math.min(
        profile.bitRateKbps,
        opts.bitRateKbps ?? Infinity,
      );

      // Pre-flight: open, require an audio stream, create the encoder. A
      // failure here is a clean null for the hat's envelope — no byte has
      // been sent. Mid-stream failures truncate the body (Navidrome's rule).
      let input: Demuxer;
      let decoder: Decoder;
      let encoder: Encoder;
      try {
        input = await Demuxer.open(path);
        const audio = input.audio();
        if (audio === undefined) {
          await input.close();
          return null;
        }
        decoder = await Decoder.create(audio);
        // autoResample: decoded frames arrive in whatever rate/format/layout
        // the source carries; the encoder converts to what the codec accepts
        // (ffmpeg's implicit aresample). context.bitRate = the clamped value.
        encoder = await Encoder.create(profile.encoder, {
          autoResample: true,
          context: { bitRate: `${bitRateKbps}k` } as never,
        });
      } catch (err) {
        log.event('media_failed', {
          operation: 'transcodeAudio',
          phase: 'preflight',
          format,
          path,
          error: err,
        });
        return null;
      }

      const abort = new AbortController();
      let done = false;
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      let waiting: (() => void) | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
        // The consumer drained a chunk: unblock the muxer's write callback
        // (backpressure is desiredSize-driven, client-paced).
        pull() {
          const wake = waiting;
          waiting = null;
          wake?.();
        },
        cancel() {
          done = true;
          const wake = waiting;
          waiting = null;
          wake?.();
          abort.abort();
        },
      });

      let output: Muxer;
      try {
        output = await Muxer.open(
          {
            write: async (chunk: Uint8Array) => {
              if (done) return;
              // FFmpeg may reuse the buffer after the callback — copy.
              controller.enqueue(new Uint8Array(chunk));
              while (
                !done && controller.desiredSize !== null &&
                controller.desiredSize <= 0
              ) {
                await new Promise<void>((resolve) => {
                  waiting = resolve;
                });
              }
            },
          },
          // input carries the tags over (title/artist land in the ID3).
          { format: profile.muxer, input },
        );
      } catch (err) {
        log.event('media_failed', {
          operation: 'transcodeAudio',
          phase: 'muxer',
          format,
          path,
          error: err,
        });
        encoder[Symbol.dispose]();
        decoder[Symbol.dispose]();
        await input.close().catch(() => {});
        return null;
      }

      const run = async () => {
        try {
          // NB: pipeline owns addStream on the muxer — adding one ourselves
          // makes two streams and the muxer rejects the header.
          await pipeline(input, decoder, encoder, output, {
            signal: abort.signal,
          }).completion;
          if (!done) controller.close();
        } catch (err) {
          if (!done) {
            log.event('media_failed', {
              operation: 'transcodeAudio',
              phase: 'stream',
              format,
              path,
              error: err,
            });
            try {
              controller.error(err);
            } catch { /* stream already closed */ }
          }
        } finally {
          // pipeline closes the muxer on completion; close() is idempotent.
          await output.close().catch(() => {});
          encoder[Symbol.dispose]();
          decoder[Symbol.dispose]();
          await input.close().catch(() => {});
        }
      };
      void run();

      return { stream, contentType: profile.contentType };
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
        if (opts.startMs !== undefined && opts.startMs > 0) {
          // OwnTone-style audio seek: the native API expects this stream's
          // time base, not the convenience seek's global microseconds.
          // Preserve fractional engine milliseconds at microsecond precision.
          const microseconds = BigInt(
            Math.round(opts.startMs * AV_TIME_BASE / 1000),
          );
          let targetPts = avRescaleQ(
            microseconds,
            AV_TIME_BASE_Q,
            audio.timeBase,
          );
          const startTime = audio.startTime;
          if (startTime !== AV_NOPTS_VALUE && startTime > 0n) {
            targetPts += startTime;
          }
          // Backward/keyframe seeking can overlap the requested position.
          const ret = await input.getFormatContext().seekFrame(
            audio.index,
            targetPts,
            AVSEEK_FLAG_BACKWARD,
          );
          FFmpegError.throwIfError(ret, 'PCM seek');
        }
        // Allocate only after successful seeking; a failed preflight owns
        // just the input, which the existing failure handler closes.
        decoder = await Decoder.create(audio, {
          resample: {
            sampleRate: PCM_RATE,
            sampleFormat: AV_SAMPLE_FMT_S16,
            channelLayout: AV_CHANNEL_LAYOUT_STEREO,
          },
        });
      } catch (err) {
        log.event('media_failed', { operation: 'decodePcm', path, error: err });
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
