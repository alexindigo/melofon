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
  AV_CODEC_FLAG_QSCALE,
  AV_CODEC_ID_AAC,
  AV_CODEC_ID_ALAC,
  AV_CODEC_ID_FLAC,
  AV_CODEC_ID_H264,
  AV_CODEC_ID_MP1,
  AV_CODEC_ID_MP2,
  AV_CODEC_ID_MP3,
  AV_CODEC_ID_OPUS,
  AV_CODEC_ID_VORBIS,
  AV_NOPTS_VALUE,
  AV_PIX_FMT_RGBA,
  AV_PIX_FMT_YUVJ420P,
  AV_SAMPLE_FMT_S16,
  AV_TIME_BASE,
  AV_TIME_BASE_Q,
  AVDISCARD_ALL,
  avGetCodecName,
  AVMEDIA_TYPE_AUDIO,
  AVMEDIA_TYPE_SUBTITLE,
  AVMEDIA_TYPE_VIDEO,
  type AVPixelFormat,
  avRescaleQ,
  AVSEEK_FLAG_BACKWARD,
  Codec,
  Decoder,
  Demuxer,
  Encoder,
  FF_ENCODER_AAC,
  FF_ENCODER_LIBMP3LAME,
  FF_ENCODER_LIBOPUS,
  FF_ENCODER_LIBVORBIS,
  FF_ENCODER_LIBWEBP_ANIM,
  FF_ENCODER_MJPEG,
  FF_ENCODER_PNG,
  FF_QP2LAMBDA,
  FFmpegError,
  FilterAPI,
  Frame,
  Log as FFmpegLog,
  Muxer,
  pipeline,
  SoftwareScaleContext,
  SWS_BICUBIC,
} from 'node-av';
import { Buffer } from 'node:buffer';
import { extname } from 'node:path';
import { createHash } from 'node:crypto';
import { type Log, scopedLog } from './logging.ts';
import type { State } from './state.ts';
import {
  type CaptionCue,
  type MediaTrack,
  renderCaptions,
  TEXT_SUBTITLES,
} from './video.ts';

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
  audioStreams?: MediaTrack[];
  subtitleStreams?: MediaTrack[];
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
  /** Settles only after all native resources have been released. */
  completion: Promise<void>;
}

export interface AudioDetails {
  protocol: string;
  container: string;
  codec: string;
  audioChannels?: number;
  audioBitrate?: number;
  audioProfile?: string;
  audioSamplerate?: number;
  audioBitdepth?: number;
}

export interface AudioProfile {
  format: string;
  container: string;
  codec: string;
  contentType: string;
  bitRateKbps: number;
  sampleRates: number[] | null;
  channelCounts: number[] | null;
}

export interface ExtractedAudio {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
}

export interface Media {
  /** afp/1: compressed audio packets only, excluding tags and container data.
   * Throws on I/O/demux failure. No audio or packets yields a null fingerprint.
   * pcmMd5 is FLAC's nonzero STREAMINFO checksum, never a decoded-audio hash. */
  fingerprint(path: string): Promise<AudioFingerprint>;
  /** Never throws: unreadable/unsupported media probes as all-null/false. */
  probe(path: string): Promise<Probe>;
  /** Extract supported text subtitle packets, preserving their stream timing. */
  captions(
    path: string,
    index: number,
    format: 'srt' | 'vtt',
  ): Promise<string | null>;
  /** Actual selected audio stream facts, separate from the legacy probe shape. */
  describeAudio(path: string): Promise<AudioDetails | null>;
  /** Only installed, usable encoders; shared by negotiation and execution. */
  audioProfiles(): Promise<AudioProfile[]>;
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
    opts?: {
      bitRateKbps?: number;
      startSeconds?: number;
      sampleRate?: number;
      channels?: number;
      signal?: AbortSignal;
    },
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

export interface AudioFingerprint {
  fingerprint: string | null;
  pcmMd5: string | null;
}

// MPEG packets can include trailing tags or leading padding. Only the first
// complete MPEG frame belongs to afp/1, never the whole packet's tail.
function mpegFrame(data: Uint8Array, first: boolean): Uint8Array | null {
  const rates = [44100, 48000, 32000];
  const v1 = [
    [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  ];
  const v2 = [
    [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  ];
  for (let at = 0; at + 4 <= data.length; at++) {
    if (data[at] !== 0xff || (data[at + 1] & 0xe0) !== 0xe0) continue;
    const version = (data[at + 1] >> 3) & 3;
    const layerBits = (data[at + 1] >> 1) & 3;
    const bitrateIndex = data[at + 2] >> 4;
    const rateIndex = (data[at + 2] >> 2) & 3;
    if (
      version === 1 || layerBits === 0 || bitrateIndex === 0 ||
      bitrateIndex === 15 || rateIndex === 3
    ) continue;
    const layer = 4 - layerBits;
    const bitrate = (version === 3 ? v1[layer - 1] : v2[layer === 1 ? 0 : 1])[
      bitrateIndex - 1
    ] * 1000;
    const sampleRate = rates[rateIndex] /
      (version === 3 ? 1 : version === 2 ? 2 : 4);
    const padding = (data[at + 2] >> 1) & 1;
    const length = layer === 1
      ? (Math.floor(12 * bitrate / sampleRate) + padding) * 4
      : Math.floor(
        (layer === 3 && version !== 3 ? 72 : 144) * bitrate / sampleRate,
      ) + padding;
    if (at + length > data.length) continue;
    const frame = data.subarray(at, at + length);
    if (first) {
      const mono = (frame[3] >> 6) === 3;
      const crc = (frame[1] & 1) === 0 ? 2 : 0;
      const sideInfo = version === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17);
      const marker = (offset: number) =>
        String.fromCharCode(...frame.subarray(offset, offset + 4));
      const xing = marker(4 + crc + sideInfo);
      if (xing === 'Xing' || xing === 'Info' || marker(36) === 'VBRI') {
        return null;
      }
    }
    return frame;
  }
  return null;
}

// Transcode profiles: format → encoder + muxer + wire content type + default
// bitrate. The muxer names are FFmpeg's own ('adts' = raw AAC frames).
// Unsupported requested targets are resolved by the stream service to mp3.
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
    frameSamples?: number;
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
    // libvorbis' native frame_size is 64. node-av's FIFO drains only one
    // frame per receive() until a packet exists; feeding decoder-sized
    // chunks overfills that FIFO and its EOF send loop drops EAGAIN frames.
    // Enforce the codec's input framing before the encoder owns the frames.
    frameSamples: 64,
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

// Artwork's native boundary. Callers inspect image headers and admit work first.
// Fresh frames intentionally carry neither EXIF orientation nor ICC side data.
function imageFrame(
  width: number,
  height: number,
  format: AVPixelFormat,
): Frame {
  const frame = new Frame();
  frame.alloc();
  frame.width = width;
  frame.height = height;
  frame.format = format;
  frame.timeBase = { num: 1, den: 1000 };
  frame.pts = 0n;
  FFmpegError.throwIfError(frame.allocBuffer(), 'allocate artwork frame');
  return frame;
}

async function scaleImage(
  frame: Frame,
  width: number,
  height: number,
  format: AVPixelFormat,
): Promise<Frame> {
  const result = imageFrame(width, height, format);
  try {
    using scaler = new SoftwareScaleContext();
    scaler.getContext(
      frame.width,
      frame.height,
      frame.format as AVPixelFormat,
      width,
      height,
      format,
      SWS_BICUBIC,
    );
    FFmpegError.throwIfError(
      await scaler.scaleFrame(result, frame),
      'scale artwork',
    );
    return result;
  } catch (error) {
    result.free();
    throw error;
  }
}

async function encodeImage(
  frame: Frame,
  format: 'png' | 'jpeg',
  quality: number,
): Promise<Uint8Array> {
  // mjpeg uses qscale 2..31, inverse to the human-facing 1..100 quality.
  const qscale = Math.round(31 - quality * 29 / 100);
  await using encoder = await Encoder.create(
    Codec.findEncoderByName(
      format === 'png' ? FF_ENCODER_PNG : FF_ENCODER_MJPEG,
    )!,
    {
      context: format === 'jpeg'
        ? { flags: AV_CODEC_FLAG_QSCALE, globalQuality: qscale * FF_QP2LAMBDA }
        : {},
    },
  );
  const chunks: Buffer[] = [];
  for (const item of [frame, null]) {
    for (const packet of await encoder.encodeAll(item)) {
      try {
        if (packet.data) chunks.push(Buffer.from(packet.data));
      } finally {
        packet.free();
      }
    }
  }
  if (!chunks.length) throw new Error('Artwork encoder returned no bytes');
  return Buffer.concat(chunks);
}

export async function resizeImage(
  bytes: Uint8Array,
  width: number,
  height: number,
  format: 'png' | 'jpeg',
  quality: number,
): Promise<Uint8Array> {
  await using input = await Demuxer.open(Buffer.from(bytes));
  const stream = input.video();
  if (!stream) throw new Error('Image has no video stream');
  await using decoder = await Decoder.create(stream);
  for await (const frame of decoder.frames(input.packets(stream.index))) {
    if (!frame) continue;
    try {
      using scaled = await scaleImage(
        frame,
        width,
        height,
        format === 'png' ? AV_PIX_FMT_RGBA : AV_PIX_FMT_YUVJ420P,
      );
      return await encodeImage(scaled, format, quality);
    } finally {
      frame.free();
    }
  }
  throw new Error('Image has no decoded frame');
}

/** Navidrome resolve.go:415-421: ABBA for two, ABCA for three; one tile alone. */
export async function playlistImage(
  images: Uint8Array[],
  tileSize: number,
): Promise<Uint8Array> {
  const tiles: Frame[] = [];
  try {
    for (const bytes of images) {
      try {
        await using input = await Demuxer.open(Buffer.from(bytes));
        const stream = input.video();
        if (!stream) continue;
        await using decoder = await Decoder.create(stream);
        for await (const frame of decoder.frames(input.packets(stream.index))) {
          if (!frame) continue;
          try {
            using rgba = await scaleImage(
              frame,
              frame.width,
              frame.height,
              AV_PIX_FMT_RGBA,
            );
            // Center crop at the owning image boundary, not per-quadrant offsets.
            const side = Math.min(rgba.width, rgba.height);
            using cropped = imageFrame(side, side, AV_PIX_FMT_RGBA);
            const src = rgba.data![0], dst = cropped.data![0];
            const x = Math.floor((rgba.width - side) / 2),
              y = Math.floor((rgba.height - side) / 2);
            for (let row = 0; row < side; row++) {
              dst.set(
                src.subarray(
                  (y + row) * rgba.linesize[0] + x * 4,
                  (y + row) * rgba.linesize[0] + (x + side) * 4,
                ),
                row * cropped.linesize[0],
              );
            }
            tiles.push(
              await scaleImage(
                cropped,
                tileSize / 2,
                tileSize / 2,
                AV_PIX_FMT_RGBA,
              ),
            );
          } finally {
            frame.free();
          }
          break;
        }
      } catch { /* Navidrome resolve.go:399-403 skips an undecodable tile. */ }
    }
    if (!tiles.length) throw new Error('No playlist tiles');
    const order = tiles.length === 1
      ? [0]
      : tiles.length === 2
      ? [0, 1, 1, 0]
      : tiles.length === 3
      ? [0, 1, 2, 0]
      : [0, 1, 2, 3];
    const side = order.length === 1 ? tileSize / 2 : tileSize;
    using canvas = imageFrame(side, side, AV_PIX_FMT_RGBA);
    for (const [pos, index] of order.entries()) {
      const tile = tiles[index], dst = canvas.data![0], src = tile.data![0];
      const x = pos % 2 * tile.width, y = Math.floor(pos / 2) * tile.height;
      for (let row = 0; row < tile.height; row++) {
        dst.set(
          src.subarray(
            row * tile.linesize[0],
            row * tile.linesize[0] + tile.width * 4,
          ),
          (y + row) * canvas.linesize[0] + x * 4,
        );
      }
    }
    return await encodeImage(canvas, 'png', 75);
  } finally {
    for (const frame of tiles) frame.free();
  }
}

/** Best-effort animated GIF conversion; callers retain original on any failure. */
export async function animatedImage(
  bytes: Uint8Array,
  size: number,
  quality: number,
): Promise<Uint8Array> {
  const codec = Codec.findEncoderByName(FF_ENCODER_LIBWEBP_ANIM);
  if (!codec) throw new Error('No animated WebP encoder');
  await using input = await Demuxer.open(Buffer.from(bytes));
  const stream = input.video();
  if (!stream) throw new Error('No GIF stream');
  await using decoder = await Decoder.create(stream);
  await using encoder = await Encoder.create(codec, {
    options: { quality },
    autoFormat: true,
  });
  const chunks: Buffer[] = [];
  await using output = await Muxer.open({
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      return chunk.length;
    },
  }, { format: 'webp' });
  const index = output.addStream(encoder);
  async function* frames() {
    for await (const frame of decoder.frames(input.packets(stream!.index))) {
      // node-av encoders flush only on an explicit EOF, not iterator completion.
      if (!frame) {
        yield null;
        continue;
      }
      try {
        const ratio = Math.min(1, size / Math.max(frame.width, frame.height));
        using scaled = await scaleImage(
          frame,
          Math.max(1, Math.floor(frame.width * ratio)),
          Math.max(1, Math.floor(frame.height * ratio)),
          AV_PIX_FMT_RGBA,
        );
        scaled.pts = frame.pts;
        scaled.duration = frame.duration;
        scaled.timeBase = frame.timeBase;
        yield scaled;
      } finally {
        frame.free();
      }
    }
  }
  for await (const packet of encoder.packets(frames())) {
    if (!packet) continue;
    try {
      await output.writePacket(packet, index);
    } finally {
      packet.free();
    }
  }
  await output.close();
  return Buffer.concat(chunks);
}

export function createMedia(
  log: Log = scopedLog('media'),
  state?: Pick<State, 'declare' | 'getTyped'>,
): Media {
  for (const [format, profile] of Object.entries(TRANSCODE_PROFILES)) {
    state?.declare(`media.transcode.${format}.bitRateKbps`, {
      type: 'integer',
      minimum: 1,
      default: profile.bitRateKbps,
    });
  }
  const bitrate = async (format: string) =>
    Number(
      await state?.getTyped(`media.transcode.${format}.bitRateKbps`) ??
        TRANSCODE_PROFILES[format].bitRateKbps,
    );
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
    async captions(path, index, format) {
      try {
        await using input = await Demuxer.open(path);
        const stream = input.streams.find((s) => s.index === index);
        if (!stream || stream.codecpar.codecType !== AVMEDIA_TYPE_SUBTITLE) {
          return null;
        }
        const codec = avGetCodecName(stream.codecpar.codecId);
        if (!codec || !TEXT_SUBTITLES.has(codec)) return null;
        const cues: CaptionCue[] = [];
        for await (const packet of input.packets(index)) {
          if (!packet) continue;
          try {
            const data = packet.data;
            if (!data || packet.pts === AV_NOPTS_VALUE) continue;
            let text = codec === 'mov_text'
              ? data.subarray(2, 2 + data.readUInt16BE(0)).toString('utf8')
              : data.toString('utf8');
            if (codec === 'ass' || codec === 'ssa') {
              // FFmpeg's ASS packet: ReadOrder,Layer,Style,Name,MarginL,R,V,Effect,Text.
              text = text.split(',').slice(8).join(',')
                .replace(/\{[^}]*\}/g, '').replaceAll('\\N', '\n').replaceAll(
                  '\\n',
                  '\n',
                ).replaceAll('\\h', ' ');
            }
            const unit = stream.timeBase.num / stream.timeBase.den * 1000;
            if (text) {
              cues.push({
                start: Number(packet.pts) * unit,
                end: Number(packet.pts + packet.duration) * unit,
                text,
              });
            }
          } finally {
            packet.free();
          }
        }
        return renderCaptions(cues, format);
      } catch {
        return null;
      }
    },
    async describeAudio(path) {
      try {
        await using input = await Demuxer.open(path);
        const audio = input.audio();
        if (!audio) return null;
        const p = audio.codecpar;
        const codecName = avGetCodecName(p.codecId);
        if (!codecName) return null;
        const codec = Codec.findDecoder(p.codecId);
        const profile = codec?.profiles?.find((entry) =>
          entry.profile === p.profile
        )?.name;
        const container = input.formatName.split(',');
        const suffix = extname(path).slice(1).toLowerCase();
        return {
          protocol: 'http',
          container: container.includes('mov')
            ? (suffix === 'm4a' ? 'm4a' : 'mp4')
            : container.includes(suffix)
            ? suffix
            : container[0],
          codec: codecName,
          ...(p.channelLayout.nbChannels > 0
            ? { audioChannels: p.channelLayout.nbChannels }
            : {}),
          ...(p.bitRate > 0n ? { audioBitrate: Number(p.bitRate) } : {}),
          ...(profile ? { audioProfile: profile } : {}),
          ...(p.sampleRate > 0 ? { audioSamplerate: p.sampleRate } : {}),
          ...((p.bitsPerRawSample || p.bitsPerCodedSample) > 0
            ? { audioBitdepth: p.bitsPerRawSample || p.bitsPerCodedSample }
            : {}),
        };
      } catch {
        return null;
      }
    },

    async audioProfiles() {
      const profiles: AudioProfile[] = [];
      for (const [format, profile] of Object.entries(TRANSCODE_PROFILES)) {
        const codec = Codec.findEncoderByName(profile.encoder);
        if (!codec) continue;
        profiles.push({
          format,
          container: profile.muxer === 'adts' ? 'aac' : profile.muxer,
          codec: format === 'ogg' ? 'vorbis' : format,
          contentType: profile.contentType,
          bitRateKbps: await bitrate(format),
          sampleRates: codec.supportedSamplerates,
          channelCounts: codec.channelLayouts?.map((layout) =>
            layout.nbChannels
          ) ?? null,
        });
      }
      return profiles;
    },

    async fingerprint(path) {
      const input = await Demuxer.open(path);
      try {
        const audio = input.audio(0);
        if (audio === undefined) return { fingerprint: null, pcmMd5: null };
        for (const stream of input.streams) {
          if (stream.index !== audio.index) stream.discard = AVDISCARD_ALL;
        }
        const params = audio.codecpar;
        const hash = createHash('sha256');
        hash.update(`melofon-afp/1\0${avGetCodecName(params.codecId)}\0`);
        const format = new Uint8Array(8);
        const view = new DataView(format.buffer);
        view.setUint32(0, params.sampleRate, true);
        view.setUint32(4, params.channelLayout.nbChannels, true);
        hash.update(format);
        let pcmMd5: string | null = null;
        if (params.codecId === AV_CODEC_ID_FLAC) {
          const md5 = params.extradata?.subarray(18, 34);
          if (md5?.length === 16 && md5.some((b) => b !== 0)) {
            pcmMd5 = md5.toString('hex');
          }
        }
        const mpeg = [AV_CODEC_ID_MP1, AV_CODEC_ID_MP2, AV_CODEC_ID_MP3]
          .includes(params.codecId);
        let first = true;
        let bytes = 0;
        for await (const packet of input.packets(audio.index)) {
          if (packet === null) continue;
          try {
            const data = packet.data;
            if (data === null || data.length === 0) continue;
            const payload = mpeg ? mpegFrame(data, first) : data;
            first = false;
            if (payload !== null) {
              hash.update(payload);
              bytes += payload.length;
            }
          } finally {
            packet.free();
          }
        }
        return {
          fingerprint: bytes === 0 ? null : hash.digest('hex').slice(0, 32),
          pcmMd5,
        };
      } finally {
        await input.close();
      }
    },

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
        const tracks = (type: number): MediaTrack[] =>
          input.streams
            .filter((s) => s.codecpar.codecType === type)
            .map((s) => {
              using metadata = s.metadata;
              return {
                index: s.index,
                codec: avGetCodecName(s.codecpar.codecId),
                language: metadata?.get('language') || null,
                title: metadata?.get('title') || null,
                ...(type === AVMEDIA_TYPE_AUDIO
                  ? { channels: s.codecpar.channelLayout.nbChannels }
                  : {}),
              };
            });
        return {
          ...(types.includes(AVMEDIA_TYPE_VIDEO)
            ? {
              audioStreams: tracks(AVMEDIA_TYPE_AUDIO),
              subtitleStreams: tracks(AVMEDIA_TYPE_SUBTITLE),
            }
            : {}),
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
        await bitrate(format),
        opts.bitRateKbps !== undefined && opts.bitRateKbps > 0
          ? opts.bitRateKbps
          : Infinity,
      );

      // Pre-flight: open, require an audio stream, create the encoder. A
      // failure here is a clean null for the hat's envelope — no byte has
      // been sent. Mid-stream failures truncate the body (Navidrome's rule).
      let input: Demuxer | undefined;
      let decoder: Decoder | undefined;
      let encoder: Encoder;
      let trimStart = 0;
      try {
        input = await Demuxer.open(path, { signal: opts.signal });
        const audio = input.audio();
        if (audio === undefined) {
          await input.close();
          return null;
        }
        const start = opts.startSeconds ?? 0;
        if (Number.isSafeInteger(start) && start > 0) {
          const origin = audio.startTime === AV_NOPTS_VALUE
            ? 0n
            : audio.startTime;
          const target = avRescaleQ(
            BigInt(start) * BigInt(AV_TIME_BASE),
            AV_TIME_BASE_Q,
            audio.timeBase,
          ) + origin;
          FFmpegError.throwIfError(
            await input.getFormatContext().seekFrame(
              audio.index,
              target,
              AVSEEK_FLAG_BACKWARD,
            ),
            'Transcode seek',
          );
          trimStart = Number(target) * audio.timeBase.num / audio.timeBase.den;
        }
        decoder = await Decoder.create(audio);
        // autoResample: decoded frames arrive in whatever rate/format/layout
        // the source carries; the encoder converts to what the codec accepts
        // (ffmpeg's implicit aresample). context.bitRate = the clamped value.
        encoder = await Encoder.create(profile.encoder, {
          autoResample: true,
          context: { bitRate: `${bitRateKbps}k` },
        });
      } catch (err) {
        decoder?.[Symbol.dispose]();
        await input?.close().catch(() => {});
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
      const cancel = () => {
        done = true;
        const wake = waiting;
        waiting = null;
        wake?.();
        abort.abort();
      };
      opts.signal?.addEventListener('abort', cancel, { once: true });
      if (opts.signal?.aborted) cancel();
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
          cancel();
          return completion;
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
        opts.signal?.removeEventListener('abort', cancel);
        return null;
      }

      const run = async () => {
        const filters = [
          ...(trimStart > 0
            ? [`atrim=start=${trimStart}`, 'asetpts=PTS-STARTPTS']
            : []),
          ...(opts.sampleRate ? [`aresample=${opts.sampleRate}`] : []),
          ...(opts.channels
            ? [`aformat=channel_layouts=${opts.channels}c`]
            : []),
          ...(profile.frameSamples
            ? [`asetnsamples=n=${profile.frameSamples}`]
            : []),
        ];
        const filter = filters.length
          ? FilterAPI.create(filters.join(','))
          : undefined;
        try {
          // NB: pipeline owns addStream on the muxer — adding one ourselves
          // makes two streams and the muxer rejects the header.
          await (filter
            ? pipeline(input!, decoder!, filter, encoder, output, {
              signal: abort.signal,
            })
            : pipeline(input!, decoder!, encoder, output, {
              signal: abort.signal,
            })).completion;
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
          filter?.[Symbol.dispose]();
          encoder[Symbol.dispose]();
          decoder![Symbol.dispose]();
          await input!.close().catch(() => {});
          opts.signal?.removeEventListener('abort', cancel);
        }
      };
      const completion = run();

      return { stream, contentType: profile.contentType, completion };
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
