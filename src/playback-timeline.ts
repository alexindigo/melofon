// Core-owned source incarnations and native-fact projection. No queue policy,
// timers, protocol imports or inferred progress. Production adoption is separate.
export interface TimelineSource {
  readonly streamId: bigint;
  readonly epoch: bigint;
  readonly source: bigint;
  readonly entryId: number;
  readonly generation: number;
  readonly originMs: number;
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
    begin(input: Omit<TimelineSource, 'source'>): TimelineSource {
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
      const source = Object.freeze({ ...input, source: nextSource++ });
      records.set(source.source, {
        source,
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
