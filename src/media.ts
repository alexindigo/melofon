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
  AV_CODEC_ID_MP1,
  AV_CODEC_ID_MP2,
  AV_CODEC_ID_MP3,
  AV_CODEC_ID_OPUS,
  AV_CODEC_ID_VORBIS,
  AV_DICT_MULTIKEY,
  AV_DISPOSITION_ATTACHED_PIC,
  AV_NOPTS_VALUE,
  AV_SAMPLE_FMT_S16,
  AV_TIME_BASE,
  AV_TIME_BASE_Q,
  AVDISCARD_ALL,
  avGetCodecName,
  AVMEDIA_TYPE_AUDIO,
  AVMEDIA_TYPE_VIDEO,
  avRescaleQ,
  AVSEEK_FLAG_BACKWARD,
  Codec,
  Decoder,
  Demuxer,
  Dictionary,
  Encoder,
  FF_ENCODER_AAC,
  FF_ENCODER_LIBMP3LAME,
  FF_ENCODER_LIBOPUS,
  FF_ENCODER_LIBVORBIS,
  FFmpegError,
  FilterAPI,
  Log as FFmpegLog,
  Muxer,
  pipeline,
} from 'node-av';
import { Buffer } from 'node:buffer';
import { extname } from 'node:path';
import { createHash } from 'node:crypto';
import { type IAudioMetadata, parseFile } from 'music-metadata';
import { type Log, scopedLog } from './logging.ts';
import type { State } from './state.ts';

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

/** Keep the existing native PICTURE-comment representation shared by picture
 * replacement and metadata-only stream copies. No image is synthesized. */
function pictureComment(picture: {
  type: number;
  format: string;
  description?: string;
  width: number;
  height: number;
  depth: number;
  colors?: number;
  data: Uint8Array;
}): string {
  const mime = Buffer.from(picture.format);
  const description = Buffer.from(picture.description ?? '');
  const bytes = Buffer.alloc(
    32 + mime.length + description.length + picture.data.length,
  );
  let offset = 0;
  const uint = (n: number) => {
    bytes.writeUInt32BE(n, offset);
    offset += 4;
  };
  const text = (value: Buffer) => {
    uint(value.length);
    bytes.set(value, offset);
    offset += value.length;
  };
  uint(picture.type);
  text(mime);
  text(description);
  uint(picture.width);
  uint(picture.height);
  uint(picture.depth);
  uint(picture.colors ?? 0);
  uint(picture.data.length);
  bytes.set(picture.data, offset);
  return bytes.toString('base64');
}

/** Known native mux limitations are refused before reserving files or backups.
 * Full fingerprint/tag/read-back verification remains the publication gate. */
export function lyricsWriteRefusal(
  path: string,
  meta: IAudioMetadata,
): string | null {
  const format = extname(path).slice(1).toLowerCase();
  if (format === 'mp3') return 'lyrics write not supported for MP3 yet';
  if (!['flac', 'm4a', 'ogg', 'opus'].includes(format)) {
    return `lyrics write not supported for ${format}`;
  }
  if (
    format === 'flac' && !meta.common.picture?.length &&
    Object.values(meta.native).flat().some((tag) =>
      /^encoder(?:-|$)/i.test(tag.id)
    )
  ) return 'lyrics write would change the FLAC ENCODER tag';
  return null;
}

/** Lyrics-only native stream copy. Attached packets and all other streams are
 * retained. FLAC with art uses the same post-init picture window as covers;
 * no-art FLAC uses bitexact only after the preflight ruled out encoder loss. */
export async function remuxLyrics(
  path: string,
  text: string,
  outputPath: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const meta = await parseFile(path);
  const refusal = lyricsWriteRefusal(path, meta);
  if (refusal) throw new Error(refusal);
  const format = extname(path).slice(1).toLowerCase();
  await using input = await Demuxer.open(path, { signal });
  const ogg = input.formatName.split(',').includes('ogg');
  const replace = (
    entries: Record<string, string>,
  ): Record<string, string> => ({
    ...Object.fromEntries(
      Object.entries(entries).filter(([key]) =>
        !/^(lyrics|USLT|SYLT|©lyr)$/i.test(key)
      ),
    ),
    lyrics: text,
  });
  const global = replace(input.metadata);
  if (format === 'm4a' && global.encoder !== undefined) {
    global.encoding_tool = global.encoder;
  }
  await using output = await Muxer.open(outputPath, {
    input,
    format: format === 'm4a' ? 'mp4' : format === 'opus' ? 'ogg' : format,
    signal,
    copyPriorStart: 1,
    copyInitialNonkeyframes: true,
    options: { fflags: '+bitexact' },
    configure(ctx) {
      using dict = Dictionary.fromObject(global);
      ctx.metadata = dict;
    },
  });
  const mapping = new Map<number, number>();
  // Ogg represents its pictures as comments, not additional image streams.
  // music-metadata supplies all original PICTURE fields; use the same serializer
  // as remuxPicture, preserving descriptions, dimensions, depth and type too.
  const pictureTypes = [
    'Other',
    "32x32 pixels 'file icon' (PNG only)",
    'Other file icon',
    'Cover (front)',
    'Cover (back)',
    'Leaflet page',
    'Media (e.g. label side of CD)',
    'Lead artist/lead performer/soloist',
    'Artist/performer',
    'Conductor',
    'Band/Orchestra',
    'Composer',
    'Lyricist/text writer',
    'Recording Location',
    'During recording',
    'During performance',
    'Movie/video screen capture',
    'A bright coloured fish',
    'Illustration',
    'Band/artist logotype',
    'Publisher/Studio logotype',
  ];
  const comments = Object.values(meta.native).flat().filter((tag) =>
    /^METADATA_BLOCK_PICTURE$/i.test(tag.id)
  ).map((tag) => {
    const p = tag.value as {
      type: string;
      format: string;
      description: string;
      width: number;
      height: number;
      colour_depth: number;
      indexed_color: number;
      data: Uint8Array;
    };
    const type = pictureTypes.indexOf(p.type);
    if (type < 0) throw new Error('Cannot preserve unknown picture type');
    return pictureComment({
      ...p,
      type,
      depth: p.colour_depth,
      colors: p.indexed_color,
    });
  });
  for (const stream of input.streams) {
    if (ogg && stream.hasDisposition(AV_DISPOSITION_ATTACHED_PIC)) continue;
    const index = output.addStream(stream);
    mapping.set(stream.index, index);
    if (ogg && stream.codecpar.codecType === AVMEDIA_TYPE_AUDIO) {
      using original = stream.metadata;
      using dict = Dictionary.fromObject(replace(original?.getAll() ?? {}));
      for (const comment of comments) {
        dict.set('METADATA_BLOCK_PICTURE', comment, AV_DICT_MULTIKEY);
      }
      output.getStream(index)!.metadata = dict;
    }
  }
  const packets = input.packets();
  if (format === 'flac' && meta.common.picture?.length) {
    // Initialize with a real audio packet, then restore before any picture can
    // complete the comments header. Keep this iterator; never replay audio.
    const pictures = [];
    try {
      while (true) {
        const next = await packets.next();
        if (next.done) throw new Error('FLAC has no audio packets');
        const packet = next.value;
        if (!packet) continue;
        if (
          input.streams[packet.streamIndex].hasDisposition(
            AV_DISPOSITION_ATTACHED_PIC,
          )
        ) {
          // These demuxed packets carry a real stream timebase. attachedPic's
          // raw packet has timebase 0/1 and cannot enter node-av's rescaler.
          pictures.push(packet);
          continue;
        }
        try {
          await output.writePacket(packet, mapping.get(packet.streamIndex)!);
        } finally {
          packet.free();
        }
        break;
      }
      using dict = Dictionary.fromObject(global);
      output.getFormatContext().metadata = dict;
      for (const packet of pictures) {
        await output.writePacket(packet, mapping.get(packet.streamIndex)!);
      }
    } finally {
      for (const packet of pictures) packet.free();
    }
  }
  for await (const packet of packets) {
    if (!packet) continue;
    try {
      signal?.throwIfAborted();
      if (
        input.streams[packet.streamIndex].hasDisposition(
          AV_DISPOSITION_ATTACHED_PIC,
        ) && ogg
      ) continue;
      const index = mapping.get(packet.streamIndex);
      if (index !== undefined) await output.writePacket(packet, index);
    } finally {
      packet.free();
    }
  }
  await output.close();
}

/** Picture-only stream copy. The caller owns verification and atomic publish.
 * Ogg attaches images using its native FLAC PICTURE comment (not a JPEG stream).
 * All native FFmpeg access stays at the media boundary. */
export async function remuxPicture(
  path: string,
  imagePath: string,
  outputPath: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await using input = await Demuxer.open(path, { signal });
  await using image = await Demuxer.open(imagePath, { signal });
  const picture = image.video();
  if (!picture) throw new Error('Cover has no image stream');
  const format = extname(path).slice(1).toLowerCase();
  const ogg = input.formatName.split(',').includes('ogg');
  let block: string | undefined;
  if (ogg) {
    const bytes = await Deno.readFile(imagePath);
    const codec = avGetCodecName(picture.codecpar.codecId);
    block = pictureComment({
      type: 3,
      format: `image/${codec === 'mjpeg' ? 'jpeg' : codec}`,
      width: picture.codecpar.width,
      height: picture.codecpar.height,
      depth: Math.max(0, picture.codecpar.bitsPerCodedSample),
      data: bytes,
    });
  }
  const withoutPictures = (entries: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(entries).filter(([key]) =>
        !/^(METADATA_BLOCK_PICTURE|COVERART|COVERARTMIME)$/i.test(key)
      ),
    );
  await using output = await Muxer.open(outputPath, {
    input,
    format: format === 'm4a' ? 'mp4' : format === 'opus' ? 'ogg' : format,
    signal,
    copyPriorStart: 1,
    copyInitialNonkeyframes: true,
    options: format === 'mp3' || format === 'm4a'
      ? { fflags: '+bitexact' }
      : {},
    configure(ctx) {
      const entries = withoutPictures(input.metadata);
      // FFmpeg replaces "encoder" at mux initialization. ID3's native TSSE
      // spelling plus bitexact preserves the existing value instead.
      if (format === 'mp3' && entries.encoder) {
        entries.TSSE = entries.encoder;
        delete entries.encoder;
      }
      // The MOV muxer writes ©too from encoding_tool, not encoder. Bitexact
      // suppresses its default tool atom when the input did not have one.
      if (format === 'm4a' && entries.encoder !== undefined) {
        entries.encoding_tool = entries.encoder;
      }
      using metadata = Dictionary.fromObject(entries);
      ctx.metadata = metadata;
    },
  });
  const mapping = new Map<number, number>();
  for (const stream of input.streams) {
    if (stream.hasDisposition(AV_DISPOSITION_ATTACHED_PIC)) continue;
    const index = output.addStream(stream);
    mapping.set(stream.index, index);
    if (block !== undefined) {
      using original = stream.metadata;
      using metadata = Dictionary.fromObject({
        ...withoutPictures(original?.getAll() ?? {}),
        METADATA_BLOCK_PICTURE: block,
      });
      output.getStream(index)!.metadata = metadata;
    }
  }
  const pictureIndex = ogg ? undefined : output.addStream(picture);
  if (pictureIndex !== undefined) {
    output.getStream(pictureIndex)!.disposition = AV_DISPOSITION_ATTACHED_PIC;
  }
  const packets = input.packets();
  if (format === 'flac') {
    // The first audio packet initializes the muxer's header, which waits for
    // its attached picture before writing Vorbis comments. Restore metadata
    // in that window, after init_muxer replaced encoder but before the picture
    // packet completes flac_finish_header. Keep this same packet iterator so
    // no compressed audio is dropped or replayed.
    let initialized = false;
    while (!initialized) {
      const next = await packets.next();
      if (next.done) throw new Error('FLAC has no audio packets');
      const packet = next.value;
      if (!packet) continue;
      try {
        const index = mapping.get(packet.streamIndex);
        if (index !== undefined) {
          await output.writePacket(packet, index);
          initialized = true;
        }
      } finally {
        packet.free();
      }
    }
    using metadata = Dictionary.fromObject(withoutPictures(input.metadata));
    output.getFormatContext().metadata = metadata;
  }
  if (pictureIndex !== undefined) {
    for await (const packet of image.packets()) {
      if (!packet) continue;
      try {
        await output.writePacket(packet, pictureIndex);
      } finally {
        packet.free();
      }
    }
    await output.writePacket(null, pictureIndex);
  }
  for await (const packet of packets) {
    if (!packet) continue;
    try {
      signal?.throwIfAborted();
      const index = mapping.get(packet.streamIndex);
      if (index !== undefined) await output.writePacket(packet, index);
    } finally {
      packet.free();
    }
  }
  await output.close();
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
