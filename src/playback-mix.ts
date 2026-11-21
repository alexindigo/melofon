// Natural-boundary crossfade on normalized 44.1 kHz s16le stereo PCM. One
// mix per player timeline, before native accept; no queue or transport policy.
import { PCM_RATE } from './pcm-origin.ts';

const FRAME = 4;
export const MAX_CROSSFADE_MS = 13_000;

/** Validate settings before mutation or restoration, never cap a playing mix. */
export function validateCrossfadeMs(ms: unknown): number {
  if (
    typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0 ||
    ms > MAX_CROSSFADE_MS
  ) {
    throw new RangeError(
      `Crossfade must be integer milliseconds from 0 to ${MAX_CROSSFADE_MS}`,
    );
  }
  return ms;
}

/** Requested overlap: floor(ms * 44100 / 1000) whole frames. */
export function crossfadeFrames(ms: number): bigint {
  return BigInt(validateCrossfadeMs(ms)) * BigInt(PCM_RATE) / 1000n;
}

/** Complementary linear ramps over F >= 2 frames: frame i uses incoming gain
 * i/(F-1) and outgoing gain 1-i/(F-1), rounded half up once and saturated. */
export function mixCrossfade(outgoing: Uint8Array, incoming: Uint8Array) {
  if (
    outgoing.length !== incoming.length || outgoing.length % FRAME ||
    outgoing.length < 2 * FRAME
  ) throw new RangeError('Crossfade requires two equal ranges of >= 2 frames');
  const frames = outgoing.length / FRAME, d = frames - 1;
  const a = new DataView(outgoing.buffer, outgoing.byteOffset, outgoing.length);
  const b = new DataView(incoming.buffer, incoming.byteOffset, incoming.length);
  const out = new Uint8Array(outgoing.length), o = new DataView(out.buffer);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < 2; c++) {
      const at = i * FRAME + c * 2;
      const n = a.getInt16(at, true) * (d - i) + b.getInt16(at, true) * i;
      let q = Math.floor(n / d);
      if (2 * (n - q * d) >= d) q++;
      o.setInt16(at, Math.max(-32768, Math.min(32767, q)), true);
    }
  }
  return out;
}

/** Rolling outgoing tail: releases everything except the last `frames`. */
export function createTailHold(frames: bigint) {
  const bytesFor = (frames: bigint) => {
    if (typeof frames !== 'bigint' || frames < 0n) {
      throw new RangeError('Tail hold requires nonnegative frames');
    }
    return Number(frames) * FRAME;
  };
  let limit = bytesFor(frames);
  const parts: Uint8Array[] = [];
  let held = 0;
  return {
    get frames() {
      return BigInt(held / FRAME);
    },
    /** Copy a decoded chunk in; a new window affects only retained/new PCM,
     * never a prefix already released to the sink. */
    push(chunk: Uint8Array, frames?: bigint): Uint8Array[] {
      if (chunk.length % FRAME) throw new RangeError('Incomplete PCM frame');
      if (frames !== undefined) limit = bytesFor(frames);
      if (!limit && !held) return chunk.length ? [chunk] : [];
      if (chunk.length) {
        parts.push(chunk.slice());
        held += chunk.length;
      }
      const release: Uint8Array[] = [];
      while (held > limit) {
        const first = parts[0], excess = held - limit;
        if (first.length <= excess) {
          release.push(parts.shift()!);
          held -= first.length;
        } else {
          release.push(first.subarray(0, excess));
          parts[0] = first.subarray(excess);
          held -= excess;
        }
      }
      return release;
    },
    /** Remove the held tail as one contiguous range. */
    take(): Uint8Array {
      const out = new Uint8Array(held);
      let at = 0;
      for (const part of parts.splice(0)) {
        out.set(part, at);
        at += part.length;
      }
      held = 0;
      return out;
    },
  };
}

export type CrossfadeReason =
  | 'applied'
  | 'ineligible'
  | 'compatibility'
  | 'incoming-not-ready'
  | 'short-outgoing'
  | 'short-incoming';

export interface CrossfadeRecord {
  readonly outgoingEntryId: number;
  readonly incomingEntryId: number | null;
  readonly requestedFrames: bigint;
  readonly appliedFrames: bigint;
  readonly reason: CrossfadeReason;
}

/** Applied overlap: at most the held outgoing tail and the ready incoming head,
 * leaving the incoming source at least one frame of its own. Fewer than two
 * frames concatenate. */
export function crossfadePlan(input: {
  requestedFrames: bigint;
  outgoingFrames: bigint;
  incomingFrames: bigint;
  incomingEnded: boolean;
}): { appliedFrames: bigint; reason: CrossfadeReason } {
  const { requestedFrames } = input;
  let applied = requestedFrames, reason: CrossfadeReason = 'applied';
  if (input.outgoingFrames < applied) {
    applied = input.outgoingFrames;
    reason = 'short-outgoing';
  }
  const incoming = input.incomingEnded
    ? input.incomingFrames - 1n
    : input.incomingFrames;
  if (incoming < applied) {
    applied = incoming > 0n ? incoming : 0n;
    reason = 'short-incoming';
  }
  if (applied < 2n) applied = 0n;
  return { appliedFrames: applied, reason };
}
