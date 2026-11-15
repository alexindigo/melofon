// Independent RAOP receiver replay. No sender counters, acceptance deadlines,
// JS play clock or assumed 2250 ms drain. Only wire clocks and decoded samples.
import type {
  FakeRaopSession,
  RaopEndpoint,
  RaopWireEvent,
} from './fake-raop.ts';
import { decodeReceiverAudio } from './raop-audio-consumer.ts';

const RATE = 44100;
const BLOCK = 352;
const NTP_SCALE = 2 ** 32;

function view(data: Uint8Array) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function ntp(data: Uint8Array, offset: number): bigint {
  return view(data).getBigUint64(offset);
}

function milliseconds(ticks: bigint): number {
  return Number(ticks) * 1000 / NTP_SCALE;
}

function unwrap(value: number, reference: number, bits: number): number {
  const modulus = 2 ** bits;
  return value + Math.round((reference - value) / modulus) * modulus;
}

function sameEndpoint(a: RaopEndpoint, b?: RaopEndpoint): boolean {
  return b !== undefined && a.address === b.address && a.port === b.port;
}

export interface ScheduledRange {
  epoch: number;
  sequence: number;
  ssrc: number;
  /** Extended RTP frame number, not the wrapping wire uint32. */
  timestamp: number;
  frames: number;
  atMs: number;
  endMs: number;
  pcm: Uint8Array;
}

export interface ScheduledAudio {
  pcm: Uint8Array;
  ranges: ScheduledRange[];
  discarded: {
    reason: string;
    epoch: number;
    timestamp: number;
    frames: number;
  }[];
  pendingFrames: number;
  duplicates: number;
  issues: string[];
  clockUncertaintyMs: number | null;
  lastPresentationAtMs: number | null;
}

type Datagram = Extract<RaopWireEvent, { data: Uint8Array }>;
type Queued = {
  epoch: number;
  sequence: number;
  timestamp: number;
  ssrc: number;
  pcm: Uint8Array;
  used: number;
  arrivalMs: number;
};

/** Snapshot replay, intentionally separate from decodeReceiverAudio's arrival
 * concatenation. Call with fake.nowMs() for live evidence, or a fixture clock.
 * Every range retains its RTP location so missing packets cannot be concealed by
 * concatenation. `issues` must be empty in any successful scheduled proof.
 * Unencrypted 44.1 kHz / s16 / stereo / 352-frame ALAC is the supported format.
 */
export function renderScheduledAudio(
  session: Pick<FakeRaopSession, 'sdp' | 'wire' | 'endpoints'>,
  throughMs: number,
): ScheduledAudio {
  if (!Number.isFinite(throughMs) || throughMs < 0) {
    throw new Error('invalid receiver snapshot time');
  }
  const result: ScheduledAudio = {
    pcm: new Uint8Array(),
    ranges: [],
    discarded: [],
    pendingFrames: 0,
    duplicates: 0,
    issues: [],
    clockUncertaintyMs: null,
    lastPresentationAtMs: null,
  };
  const issue = (message: string) => {
    if (!result.issues.includes(message)) result.issues.push(message);
  };
  const queued: Queued[] = [];
  const seen = new Map<number, Queued>();
  const timing = new Map<bigint, Datagram>();
  let clock: { sender: bigint; localMs: number; readyMs: number } | null = null;
  let sync: {
    ntp: bigint;
    timestamp: number;
    atMs: number;
    latency: number;
  } | null = null;
  let epoch = 0, active = false, terminal = false, audioSeen = false;
  let originSequence = 0, originTimestamp = 0, highestSequence = 0;
  let ssrc: number | null = null;
  let latency = 0;

  const startMs = (packet: Queued): number | null => {
    if (!clock || !sync) return null;
    // A sync's first RTP field maps to sender NTP before the latency advertised
    // by this receiver. Its final RTP field exposes the sender's buffer lead.
    // Do not add that lead again: it is already in (packet.ts - sync.ts).
    return clock.localMs + milliseconds(sync.ntp - clock.sender) +
      (packet.timestamp - sync.timestamp + sync.latency) * 1000 / RATE;
  };
  const discard = (packet: Queued, frames: number, reason: string) => {
    if (frames <= 0) return;
    result.discarded.push({
      reason,
      epoch: packet.epoch,
      timestamp: packet.timestamp + packet.used,
      frames,
    });
    packet.used += frames;
  };
  const advance = (atMs: number) => {
    for (const packet of queued.sort((a, b) => a.timestamp - b.timestamp)) {
      const start = startMs(packet);
      if (start === null) continue;
      const frames = packet.pcm.length / 4;
      result.lastPresentationAtMs = Math.max(
        result.lastPresentationAtMs ?? -Infinity,
        start + frames * 1000 / RATE,
      );
      // Audio, clock exchange and sync must all have arrived before a frame can
      // be scheduled. A delayed retransmit never retroactively renders sound.
      const ready = Math.max(packet.arrivalMs, clock!.readyMs, sync!.atMs);
      const missed = Math.min(
        frames,
        Math.max(
          0,
          Math.ceil(
            (ready - start) * RATE / 1000 - 1e-7,
          ),
        ),
      );
      if (missed > packet.used) discard(packet, missed - packet.used, 'late');
      const due = Math.min(
        frames,
        Math.max(
          0,
          Math.floor(
            (atMs - start) * RATE / 1000 + 1e-7,
          ),
        ),
      );
      if (due <= packet.used) continue;
      result.ranges.push({
        epoch: packet.epoch,
        sequence: packet.sequence,
        ssrc: packet.ssrc,
        timestamp: packet.timestamp + packet.used,
        frames: due - packet.used,
        atMs: start + packet.used * 1000 / RATE,
        endMs: start + due * 1000 / RATE,
        pcm: packet.pcm.slice(packet.used * 4, due * 4),
      });
      packet.used = due;
    }
  };
  const reset = (reason: string) => {
    if (queued.some((packet) => packet.used < BLOCK) && !sync) {
      issue('missing sync');
    }
    for (const packet of queued) {
      discard(packet, packet.pcm.length / 4 - packet.used, reason);
    }
    queued.length = 0;
    seen.clear();
    sync = null;
    ssrc = null;
  };
  const rtpInfo = (text: string): boolean => {
    const match = /^seq=(\d+);rtptime=(\d+)$/.exec(text);
    if (!match || Number(match[1]) > 65535 || Number(match[2]) > 0xffffffff) {
      issue('invalid RTP-Info');
      active = false;
      return false;
    }
    originSequence = highestSequence = Number(match[1]);
    originTimestamp = Number(match[2]);
    return true;
  };

  for (const event of session.wire.toSorted((a, b) => a.atMs - b.atMs)) {
    if (!Number.isFinite(event.atMs) || event.atMs < 0) {
      issue('invalid wire time');
      continue;
    }
    if (event.atMs > throughMs) break;
    advance(event.atMs);
    if (event.kind === 'record') {
      if (terminal) continue;
      reset('record');
      epoch++;
      latency = event.latencyFrames;
      active = rtpInfo(event.rtpInfo) && Number.isSafeInteger(latency) &&
        latency >= 0;
      if (!active) issue('invalid RECORD');
      continue;
    }
    if (event.kind === 'flush') {
      reset('flush');
      epoch++;
      active = !terminal && active && rtpInfo(event.rtpInfo);
      continue;
    }
    if (event.kind === 'teardown' || event.kind === 'close') {
      reset(event.kind);
      active = false;
      terminal = true;
      continue;
    }
    if (!('data' in event)) continue;
    const data = event.data;
    if (event.kind === 'timing-request') {
      if (
        data.length !== 32 || data[0] !== 0x80 || data[1] !== 0xd2 ||
        !sameEndpoint(event.peer, session.endpoints?.senderTiming) ||
        !sameEndpoint(event.local, session.endpoints?.timing)
      ) issue('invalid timing request');
      else timing.set(ntp(data, 24), event);
      continue;
    }
    if (event.kind === 'timing-reply') {
      if (
        data.length !== 32 || data[0] !== 0x80 || data[1] !== 0xd3 ||
        !sameEndpoint(event.peer, session.endpoints?.senderTiming) ||
        !sameEndpoint(event.local, session.endpoints?.timing)
      ) {
        issue('invalid timing reply');
        continue;
      }
      const request = timing.get(ntp(data, 8));
      if (!request || request.data[2] !== data[2]) {
        issue('unmatched timing reply');
        continue;
      }
      timing.delete(ntp(data, 8));
      const receive = ntp(data, 16), transmit = ntp(data, 24);
      const networkMs = event.atMs - request.atMs -
        milliseconds(transmit - receive);
      if (transmit < receive || networkMs < -1e-6) {
        issue('invalid timing interval');
        continue;
      }
      // Minimum observed RTT is the least-uncertain independent clock sample.
      if (
        !clock || networkMs / 2 < (result.clockUncertaintyMs ?? Infinity)
      ) {
        clock = {
          sender: (receive + transmit) / 2n,
          localMs: (request.atMs + event.atMs) / 2,
          readyMs: event.atMs,
        };
        result.clockUncertaintyMs = Math.max(0, networkMs / 2);
      }
      continue;
    }
    if (!active) continue;
    if (event.kind === 'control' && (data[1] & 0x7f) === 0x54) {
      if (
        data.length !== 20 || (data[0] !== 0x80 && data[0] !== 0x90) ||
        data[2] !== 0 || data[3] !== 7 || ntp(data, 8) === 0n ||
        !sameEndpoint(event.peer, session.endpoints?.senderControl) ||
        !sameEndpoint(event.local, session.endpoints?.control)
      ) {
        issue('invalid sync');
        continue;
      }
      const reference = originTimestamp +
        (highestSequence - originSequence) * BLOCK;
      const next = unwrap(view(data).getUint32(16), reference, 32);
      const current = unwrap(view(data).getUint32(4), next, 32);
      if (
        current >= next || (!sync && next !== originTimestamp) ||
        (sync && ntp(data, 8) < sync.ntp)
      ) {
        issue('invalid sync mapping');
        continue;
      }
      sync = {
        ntp: ntp(data, 8),
        timestamp: current,
        atMs: event.atMs,
        latency,
      };
      continue;
    }
    // Retransmits may be raw RTP (current sender) or RAOP 0x56 encapsulation.
    if (
      (event.kind === 'audio' &&
        !sameEndpoint(event.local, session.endpoints?.audio)) ||
      (event.kind === 'control' &&
        (!sameEndpoint(event.peer, session.endpoints?.senderControl) ||
          !sameEndpoint(event.local, session.endpoints?.control)))
    ) {
      issue('invalid audio endpoint');
      continue;
    }
    const rtp = event.kind === 'control' && (data[1] & 0x7f) === 0x56
      ? data.subarray(4)
      : data;
    if (rtp.length < 12 || (rtp[1] & 0x7f) !== 96) {
      issue('invalid audio datagram');
      continue;
    }
    if (rtp[0] !== 0x80) {
      issue('unsupported RTP header');
      continue;
    }
    audioSeen = true;
    const header = view(rtp);
    const sequence = unwrap(header.getUint16(2), highestSequence, 16);
    const expected = originTimestamp + (sequence - originSequence) * BLOCK;
    const timestamp = unwrap(header.getUint32(4), expected, 32);
    // Old retransmissions after FLUSH cannot acquire the new epoch's schedule.
    if (sequence < originSequence || timestamp < originTimestamp) continue;
    if (timestamp !== expected) {
      issue('RTP sequence/timestamp discontinuity');
      continue;
    }
    const source = header.getUint32(8);
    if (ssrc !== null && source !== ssrc) {
      issue('RTP SSRC changed within epoch');
      continue;
    }
    ssrc = source;
    highestSequence = Math.max(highestSequence, sequence);
    const previous = seen.get(sequence);
    if (previous) {
      const pcm = decodeReceiverAudio(session.sdp, [rtp.subarray(12)]);
      if (
        pcm.length !== previous.pcm.length ||
        pcm.some((byte, i) => byte !== previous.pcm[i])
      ) {
        issue('conflicting RTP duplicate');
      }
      result.duplicates++;
      continue;
    }
    const pcm = decodeReceiverAudio(session.sdp, [rtp.subarray(12)]);
    if (pcm.length !== BLOCK * 4) {
      throw new Error('unexpected ALAC frame count');
    }
    const packet: Queued = {
      epoch,
      sequence,
      timestamp,
      ssrc: source,
      pcm,
      used: 0,
      arrivalMs: event.atMs,
    };
    queued.push(packet);
    seen.set(sequence, packet);
  }
  advance(throughMs);
  if (audioSeen && !clock) issue('missing timing exchange');
  if (queued.some((packet) => packet.used < BLOCK) && !sync) {
    issue('missing sync');
  }
  result.pendingFrames = queued.reduce(
    (sum, packet) => sum + BLOCK - packet.used,
    0,
  );
  const bytes = result.ranges.reduce((sum, range) => sum + range.pcm.length, 0);
  result.pcm = new Uint8Array(bytes);
  let offset = 0;
  for (const range of result.ranges) {
    result.pcm.set(range.pcm, offset);
    offset += range.pcm.length;
  }
  return result;
}
