// Test receiver: decode captured, unencrypted ALAC payloads using libavcodec.
import { Buffer } from 'node:buffer';
import {
  AV_CODEC_ID_ALAC,
  AV_SAMPLE_FMT_S16,
  AV_SAMPLE_FMT_S16P,
  AVERROR_EAGAIN,
  AVERROR_EOF,
  Codec,
  CodecContext,
  FFmpegError,
  Frame,
  Packet,
} from 'node-av';

export function pcmAt(frame: number): [number, number] {
  return [1000 + (frame % 20000), -1000 - (Math.floor(frame / 20000) % 20000)];
}
export function alacConfiguration(sdp: string): Buffer {
  if (/a=(?:rsaaeskey|aesiv):/.test(sdp)) {
    throw new Error('test consumer requires unencrypted ALAC');
  }
  const match = sdp.match(/a=fmtp:96 ([\d ]+)\r?\n/);
  if (!match) throw new Error('missing ALAC SDP configuration');
  const v = match[1].trim().split(/\s+/).map(Number);
  if (
    v.length !== 11 || v.some((n) => !Number.isSafeInteger(n) || n < 0) ||
    v[0] !== 352 || v[2] !== 16 || v[6] !== 2 || v[10] !== 44100 ||
    v.slice(1, 7).some((n) => n > 255) || v[7] > 65535 || v[8] > 0xffffffff ||
    v[9] > 0xffffffff
  ) throw new Error('unsupported ALAC test configuration');
  // ALAC atom header (12 B) followed by ALACSpecificConfig (24 B).
  const extra = Buffer.alloc(36);
  extra.writeUInt32BE(36, 0);
  extra.write('alac', 4, 'ascii');
  extra.writeUInt32BE(v[0], 12);
  for (let i = 1; i <= 6; i++) extra[15 + i] = v[i];
  extra.writeUInt16BE(v[7], 22);
  extra.writeUInt32BE(v[8], 24);
  extra.writeUInt32BE(v[9], 28);
  extra.writeUInt32BE(v[10], 32);
  return extra;
}

export function decodeReceiverAudio(
  sdp: string,
  payloads: Uint8Array[],
): Uint8Array {
  const codec = Codec.findDecoder(AV_CODEC_ID_ALAC);
  if (!codec) throw new Error('ALAC decoder unavailable');
  const context = new CodecContext();
  const frame = new Frame();
  const packet = new Packet();
  const chunks: Buffer[] = [];
  try {
    context.allocContext3(codec);
    context.extraData = alacConfiguration(sdp);
    context.threadCount = 1;
    FFmpegError.throwIfError(context.open2Sync(codec), 'receiver ALAC open');
    frame.alloc();
    packet.alloc();
    const drain = () => {
      for (;;) {
        const status = context.receiveFrameSync(frame);
        if (status === AVERROR_EAGAIN || status === AVERROR_EOF) return;
        FFmpegError.throwIfError(status, 'receiver ALAC frame');
        if (
          frame.channelLayout.nbChannels !== 2 || frame.sampleRate !== 44100
        ) throw new Error('unexpected receiver decoded quality');
        const bytes = frame.toBuffer();
        if (frame.format === AV_SAMPLE_FMT_S16) chunks.push(Buffer.from(bytes));
        else if (frame.format === AV_SAMPLE_FMT_S16P) {
          const interleaved = Buffer.alloc(frame.nbSamples * 4);
          for (let i = 0; i < frame.nbSamples; i++) {
            interleaved.writeInt16LE(bytes.readInt16LE(i * 2), i * 4);
            interleaved.writeInt16LE(
              bytes.readInt16LE((frame.nbSamples + i) * 2),
              i * 4 + 2,
            );
          }
          chunks.push(interleaved);
        } else throw new Error('unexpected receiver decoded sample format');
        frame.unref();
      }
    };
    for (const payload of payloads) {
      packet.data = Buffer.from(payload);
      FFmpegError.throwIfError(
        context.sendPacketSync(packet),
        'receiver ALAC packet',
      );
      drain();
      packet.unref();
    }
    FFmpegError.throwIfError(context.sendPacketSync(null), 'receiver ALAC EOF');
    drain();
    return Uint8Array.from(Buffer.concat(chunks));
  } finally {
    packet.free();
    frame.free();
    context.freeContext();
  }
}
