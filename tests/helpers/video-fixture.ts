// Synthetic, tiny media for HTTP consumers; also usable by the bounded live
// evidence script with explicitly supplied 1080p/30s dimensions and duration.
import { Buffer } from 'node:buffer';
import {
  AV_CHANNEL_LAYOUT_MONO,
  AV_CHANNEL_LAYOUT_STEREO,
  AV_PIX_FMT_YUV420P,
  AV_SAMPLE_FMT_S16,
  Codec,
  Dictionary,
  Encoder,
  FF_ENCODER_AAC,
  FF_ENCODER_LIBX264,
  FF_ENCODER_LIBX265,
  FF_ENCODER_MPEG4,
  Frame,
  Muxer,
} from 'node-av';

export async function videoFixture(
  path: string,
  width = 320,
  height = 180,
  seconds = 2,
  fps = 25,
  sourceCodec: 'hevc' | 'h264' = 'hevc',
) {
  const hevc = sourceCodec === 'hevc' &&
    Codec.findEncoderByName(FF_ENCODER_LIBX265);
  using video = await Encoder.create(
    sourceCodec === 'h264'
      ? FF_ENCODER_LIBX264
      : hevc
      ? FF_ENCODER_LIBX265
      : FF_ENCODER_MPEG4,
    {
      context: {
        bitRate: '2000k',
        maxBFrames: 0,
        gopSize: fps,
        threadCount: 1,
      },
      ...(hevc
        ? {
          options: {
            preset: 'ultrafast',
            'x265-params': 'pools=1:frame-threads=1:log-level=error',
          },
        }
        : sourceCodec === 'h264'
        ? { options: { preset: 'ultrafast' } }
        : {}),
    },
  );
  using mono = await Encoder.create(FF_ENCODER_AAC, {
    autoResample: true,
    context: { bitRate: '64k' },
  });
  using stereo = await Encoder.create(FF_ENCODER_AAC, {
    autoResample: true,
    context: { bitRate: '128k' },
  });
  await using output = await Muxer.open(path, {
    format: 'matroska',
    configure(ctx) {
      using tags = Dictionary.fromObject({
        title: 'HLS encode fixture',
        artist: 'Fixture',
      });
      ctx.metadata = tags;
      for (const [index, language] of [[1, 'eng'], [2, 'fra']] as const) {
        using tags = Dictionary.fromObject({ language });
        ctx.streams[index].metadata = tags;
      }
    },
  });
  const vi = output.addStream(video),
    mi = output.addStream(mono),
    si = output.addStream(stereo);
  async function write(encoder: Encoder, frame: Frame | null, index: number) {
    const packets = await encoder.encodeAll(frame);
    try {
      for (const packet of packets) await output.writePacket(packet, index);
    } finally {
      for (const packet of packets) packet.free();
    }
  }
  let v = 0, a = 0, random = 17;
  while (v < seconds * fps || a < seconds * 48000) {
    if (v < seconds * fps && (a >= seconds * 48000 || v / fps <= a / 48000)) {
      const bytes = Buffer.alloc(width * height * 3 / 2, 128);
      for (let i = 0; i < width * height; i++) {
        random = (random * 1664525 + 1013904223) >>> 0;
        bytes[i] = 16 + ((random >>> 24) % 220);
      }
      using frame = Frame.fromVideoBuffer(bytes, {
        width,
        height,
        format: AV_PIX_FMT_YUV420P,
        timeBase: { num: 1, den: fps },
        pts: BigInt(v++),
      });
      frame.duration = 1n;
      await write(video, frame, vi);
    } else {
      const count = Math.min(1024, seconds * 48000 - a);
      for (
        const [channels, hz, encoder, index] of [[1, 440, mono, mi], [
          2,
          880,
          stereo,
          si,
        ]] as const
      ) {
        const bytes = Buffer.alloc(count * channels * 2);
        for (let n = 0; n < count; n++) {
          for (let c = 0; c < channels; c++) {
            bytes.writeInt16LE(
              Math.round(12000 * Math.sin((a + n) * hz * 2 * Math.PI / 48000)),
              (n * channels + c) * 2,
            );
          }
        }
        using frame = Frame.fromAudioBuffer(bytes, {
          nbSamples: count,
          format: AV_SAMPLE_FMT_S16,
          sampleRate: 48000,
          channelLayout: channels === 1
            ? AV_CHANNEL_LAYOUT_MONO
            : AV_CHANNEL_LAYOUT_STEREO,
          timeBase: { num: 1, den: 48000 },
          pts: BigInt(a),
        });
        await write(encoder, frame, index);
      }
      a += count;
    }
  }
  await write(video, null, vi);
  await write(mono, null, mi);
  await write(stereo, null, si);
  await output.close();
  return sourceCodec === 'h264' ? 'h264' : hevc ? 'hevc' : 'mpeg4';
}
