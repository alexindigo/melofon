// Core-owned source incarnations and native-fact projection. No queue policy,
// timers, protocol imports or inferred progress. Seal/completion authority stays
// with the same immutable source until its core transition commits.
import { pcmOrigin } from './pcm-origin.ts';
export interface TimelineSource {
  readonly streamId: bigint;
  readonly epoch: bigint;
  readonly source: bigint;
  readonly entryId: number;
  readonly generation: number;
  readonly originMs: number;
  /** Exact normalized decoder origin, relative to media start, not its PTS. */
  readonly originFrame: bigint;
}
export interface TimelineProgress {
  readonly streamId: bigint;
  readonly epoch: bigint;
  readonly source: bigint;
  readonly capturedNs: bigint;
  readonly sourceFrames: bigint;
  readonly status: 'waiting' | 'scheduled' | 'failed';
  readonly error: string;
}
export interface TimelineCutoff {
  readonly streamId: bigint;
  readonly epoch: bigint;
  readonly nextEpoch: bigint;
  readonly source: bigint;
  readonly admittedNs: bigint;
  readonly progress: TimelineProgress | null;
}
export interface TimelinePosition {
  readonly positionMs: number;
  readonly sourceFrames: bigint;
  readonly capturedNs: bigint | null;
  readonly status: 'waiting' | 'scheduled' | 'failed';
  readonly error: string;
  readonly canceled: boolean;
}
export interface TimelineCompletion {
  readonly streamId: bigint;
  readonly epoch: bigint;
  readonly source: bigint;
  readonly target: bigint;
  readonly revision: bigint;
  readonly status: 'pending' | 'complete' | 'canceled' | 'failed';
  readonly attachments?: readonly {
    readonly attachment: bigint;
    readonly outcome:
      | 'pending'
      | 'complete'
      | 'withdrawn'
      | 'failed'
      | 'canceled';
    readonly excluded: boolean;
    readonly error: string;
  }[];
}
/** The reader consumes an injected timeline port, not a protocol adapter. */
export interface TimelineWriter {
  appendSource(input: {
    epoch: bigint;
    source: bigint;
    segment: bigint;
    pcm: Uint8Array;
  }): Promise<{
    acceptedFrames: bigint;
    status: 'accepted' | 'backpressure' | 'not-ready' | 'canceled' | 'error';
    error?: string;
  }>;
  seal(epoch: bigint, source: bigint, target: bigint): Promise<{
    status: string;
    inputEnd: bigint;
  }>;
  endStream(epoch: bigint, target: bigint): Promise<{ status: string }>;
  waitDrain(epoch: bigint): Promise<void>;
  compatibilitySilence(epoch: bigint, source: bigint): Promise<void>;
  progress(epoch: bigint, source: bigint): Promise<TimelineProgress | null>;
  waitCompletion(key: {
    epoch: bigint;
    source: bigint;
    target: bigint;
    revision: bigint;
  }): Promise<TimelineCompletion>;
  reviseCompletion(key: {
    epoch: bigint;
    source: bigint;
    target: bigint;
    revision: bigint;
  }, exclude: readonly bigint[]): Promise<{
    epoch: bigint;
    source: bigint;
    target: bigint;
    revision: bigint;
  }>;
  ackCompletion(key: {
    epoch: bigint;
    source: bigint;
    target: bigint;
    revision: bigint;
  }): Promise<void>;
}
const u64 = (n: bigint) => {
  if (typeof n !== 'bigint' || n < 0n || n > 0xffffffffffffffffn) {
    throw new RangeError('Timeline facts require unsigned 64-bit values');
  }
};

export function createPlaybackTimeline() {
  let nextSource = 1n;
  let closed = false;
  const records = new Map<bigint, {
    source: TimelineSource;
    position: TimelinePosition;
    acceptedFrames: bigint;
    pendingAppends: number;
    revision: bigint;
    exclusions: { attachment: bigint; outcome: string; error: string }[];
    target?: bigint;
    completed?: boolean;
  }>();
  const canceledThrough = new Map<bigint, bigint>();
  const owned = (source: TimelineSource) => {
    const record = records.get(source.source);
    return record?.source === source ? record : undefined;
  };
  const project = (source: TimelineSource, progress: TimelineProgress) => {
    if (
      progress.streamId !== source.streamId ||
      progress.epoch !== source.epoch ||
      progress.source !== source.source
    ) return null;
    u64(progress.sourceFrames);
    u64(progress.capturedNs);
    const elapsedMs = progress.sourceFrames * 1000n / 44100n;
    if (elapsedMs > BigInt(Number.MAX_SAFE_INTEGER - source.originMs)) {
      throw new RangeError('Timeline media position is not representable');
    }
    return Object.freeze({
      positionMs: source.originMs + Number(elapsedMs),
      sourceFrames: progress.sourceFrames,
      capturedNs: progress.capturedNs,
      status: progress.status,
      error: progress.error,
      canceled: false,
    });
  };
  return {
    begin(
      input: Omit<TimelineSource, 'source' | 'originFrame'> & {
        originFrame?: bigint;
      },
    ): TimelineSource {
      if (closed) throw new Error('Playback timeline is closed');
      u64(input.streamId);
      u64(input.epoch);
      u64(nextSource);
      if (
        !input.streamId || !input.epoch ||
        input.epoch <= (canceledThrough.get(input.streamId) ?? 0n) ||
        !Number.isSafeInteger(input.entryId) || input.entryId <= 0 ||
        !Number.isSafeInteger(input.generation) || input.generation < 0 ||
        !Number.isSafeInteger(input.originMs) || input.originMs < 0
      ) throw new RangeError('Invalid timeline source incarnation or origin');
      const originFrame = pcmOrigin(
        input.originFrame === undefined
          ? { startMs: input.originMs }
          : { startFrame: input.originFrame },
      );
      u64(originFrame);
      const source = Object.freeze({
        ...input,
        originFrame,
        source: nextSource++,
      });
      records.set(source.source, {
        source,
        acceptedFrames: 0n,
        pendingAppends: 0,
        revision: 1n,
        exclusions: [],
        position: Object.freeze({
          positionMs: source.originMs,
          sourceFrames: 0n,
          capturedNs: null,
          status: 'waiting',
          error: 'none',
          canceled: false,
        }),
      });
      return source;
    },
    position(source: TimelineSource): TimelinePosition | null {
      return owned(source)?.position ?? null;
    },
    accepted(source: TimelineSource): bigint {
      return owned(source)?.acceptedFrames ?? 0n;
    },
    hasInput(source: TimelineSource): boolean {
      const record = owned(source);
      return !!record &&
        (record.acceptedFrames > 0n || record.pendingAppends > 0);
    },
    admitting(source: TimelineSource): (() => void) | null {
      const record = owned(source);
      if (!record || record.position.canceled || record.target !== undefined) {
        return null;
      }
      record.pendingAppends++;
      let settled = false;
      return () => {
        if (settled) return;
        settled = true;
        record.pendingAppends--;
      };
    },
    accept(source: TimelineSource, frames: bigint): boolean {
      u64(frames);
      const record = owned(source);
      if (!record || record.position.canceled || record.target !== undefined) {
        return false;
      }
      u64(record.acceptedFrames + frames);
      record.acceptedFrames += frames;
      return true;
    },
    seal(source: TimelineSource, target: bigint): boolean {
      u64(target);
      const record = owned(source);
      if (!record || record.position.canceled || record.target !== undefined) {
        return false;
      }
      record.target = target;
      return true;
    },
    complete(source: TimelineSource, receipt: TimelineCompletion): boolean {
      const record = owned(source);
      if (
        !record || record.position.canceled || record.completed ||
        receipt.streamId !== source.streamId ||
        receipt.epoch !== source.epoch ||
        receipt.source !== source.source || receipt.target !== record.target ||
        receipt.revision !== record.revision || receipt.status !== 'complete'
      ) return false;
      record.completed = true;
      return true;
    },
    revise(
      source: TimelineSource,
      receipt: TimelineCompletion,
    ): readonly bigint[] | null {
      const record = owned(source);
      if (
        !record || record.completed || record.position.canceled ||
        receipt.streamId !== source.streamId ||
        receipt.epoch !== source.epoch ||
        receipt.source !== source.source || receipt.target !== record.target ||
        receipt.revision !== record.revision || receipt.status !== 'failed' ||
        !receipt.attachments
      ) return null;
      const captured = receipt.attachments.filter((attachment) =>
        !attachment.excluded
      );
      const excluded = captured.filter((attachment) =>
        attachment.outcome === 'withdrawn' || attachment.outcome === 'failed'
      );
      if (
        !excluded.length ||
        !captured.some((attachment) =>
          attachment.outcome === 'pending' || attachment.outcome === 'complete'
        )
      ) return null;
      record.exclusions.push(
        ...excluded.map(({ attachment, outcome, error }) => ({
          attachment,
          outcome,
          error,
        })),
      );
      record.revision++;
      return excluded.map((attachment) => attachment.attachment);
    },
    cohort(source: TimelineSource) {
      const record = owned(source);
      return record
        ? {
          revision: record.revision,
          exclusions: record.exclusions.map((e) => ({ ...e })),
        }
        : null;
    },
    observe(source: TimelineSource, progress: TimelineProgress): boolean {
      const record = owned(source);
      if (!record || record.position.canceled) return false;
      const position = project(source, progress);
      if (
        !position || record.position.capturedNs !== null &&
          position.capturedNs < record.position.capturedNs
      ) return false;
      record.position = position;
      return true;
    },
    /** Commit the captured old primary bookmark before discarding its authority.
     * Null projection is an unobserved cutoff, never permission to invent one. */
    cancel(source: TimelineSource, cutoff: TimelineCutoff): boolean {
      const record = owned(source);
      if (
        !record || record.position.canceled ||
        cutoff.streamId !== source.streamId ||
        cutoff.epoch !== source.epoch || cutoff.source !== source.source ||
        cutoff.nextEpoch !== source.epoch + 1n || !cutoff.progress ||
        cutoff.progress.capturedNs !== cutoff.admittedNs
      ) return false;
      const position = project(source, cutoff.progress);
      if (!position) return false;
      record.position = position;
      const previous = canceledThrough.get(source.streamId) ?? 0n;
      canceledThrough.set(
        source.streamId,
        cutoff.epoch > previous ? cutoff.epoch : previous,
      );
      for (const entry of records.values()) {
        if (
          entry.source.streamId === source.streamId &&
          entry.source.epoch <= cutoff.epoch
        ) {
          entry.position = Object.freeze({ ...entry.position, canceled: true });
        }
      }
      return true;
    },
    retire(source: TimelineSource): void {
      if (owned(source)) records.delete(source.source);
    },
    close(): void {
      closed = true;
      records.clear();
      canceledThrough.clear();
    },
  };
}
