// One bounded, ordered reader per transport epoch. Core chooses every successor;
// a completed decoder releases input, not the playing cursor or its sink gate.
import { createOperationScope } from './operations.ts';
import type { Playback, PlaybackRead } from './playback.ts';
import type { PlaybackSource } from './player.ts';
import type { PlaybackSources } from './playback-source.ts';
import type { QueueEntry } from './queue-source.ts';
import {
  queueDisplay,
  queueDuration,
  type QueueMedia,
  type SourceMetadata,
} from './queue-source.ts';
import { pcmOrigin } from './pcm-origin.ts';
import type { TimelineSource, TimelineWriter } from './playback-timeline.ts';
import type { PlaybackPcm } from './playback-source.ts';
import { createPlaybackHead } from './playback-head.ts';
import {
  createTailHold,
  crossfadePlan,
  type CrossfadeRecord,
  mixCrossfade,
} from './playback-mix.ts';

export function createPlaybackReader(deps: {
  playback: Playback;
  sources: PlaybackSources;
  sink: TimelineWriter;
  streamId: bigint;
  epoch: bigint;
  initial: PlaybackRead;
  current(): boolean;
  segment(): bigint;
  mapping(source: PlaybackSource, mapping: TimelineSource): void;
  admitted(): void;
  inputObserved?(
    phase: 'first' | 'end',
    read: PlaybackRead,
    bytes: number,
  ): void;
  /** Requested natural-boundary overlap; read when an outgoing source begins
   * input (its tail hold) and again at its boundary. Absent means 0. */
  crossfadeFrames?(): bigint;
  crossfadeObserved?(record: CrossfadeRecord): void;
  /** Conservative monotonic deadline derived from currently queued sink input,
   * not an extra fade wait. Absent means the outgoing tail must be supplied now. */
  inputWindow?(sources: readonly TimelineSource[]): Promise<number>;
  transportFailed(error: unknown): void;
  contentFailed(entry: QueueEntry, error: unknown): void;
  retirementFailed(error: unknown): void;
}) {
  const { playback, sink, epoch } = deps;
  const operations = createOperationScope('Playback reader');
  const controller = new AbortController();
  const mappings = new Map<PlaybackSource, TimelineSource>();
  const acceptedMappings = new WeakSet<TimelineSource>();
  type Metadata = Parameters<TimelineWriter['metadata']>[0];
  const metadataWrites = new WeakMap<
    PlaybackSource,
    { media: QueueMedia; pending: Metadata[] }
  >();
  const leases = new Set<PlaybackSource>([deps.initial.source]);
  // Incoming heads already mixed into the previous source's native frames.
  const heads = new WeakMap<PlaybackSource, bigint>();
  const publications = new Map<
    PlaybackSource,
    ReturnType<typeof Promise.withResolvers<void>>
  >();
  let drained = false;
  let continuous = false;
  let acceptedInput = 0n;
  const live = () => !controller.signal.aborted && deps.current();
  const owns = (source: PlaybackSource) => live() && !source.signal.aborted;
  const queueMetadata = (
    source: PlaybackSource,
    mapping: TimelineSource,
    frame: bigint,
    facts?: SourceMetadata,
  ) => {
    const state = metadataWrites.get(source)!;
    const head = heads.get(source) ?? 0n;
    frame = frame > head ? frame - head : 0n;
    if (facts && state.media.facts.kind === 'web') {
      state.media = {
        ...state.media,
        facts: { ...state.media.facts, ...facts },
      } as QueueMedia;
    }
    const display = queueDisplay(state.media);
    const marker: Metadata = {
      epoch,
      source: mapping.source,
      sourceFrame: frame,
      originFrame: mapping.originFrame + head,
      durationFrames: pcmOrigin({ startMs: queueDuration(state.media) ?? 0 }),
      title: state.media.facts.kind === 'web'
        ? state.media.facts.streamTitle ?? display.title ?? ''
        : display.title ?? '',
      artist: display.artistName ?? '',
    };
    if (state.pending.at(-1)?.sourceFrame === frame) {
      state.pending[state.pending.length - 1] = marker;
    } else state.pending.push(marker);
  };
  // Native frames of an overlapped source start after its head; pending
  // decoder-frame markers move with it, keeping the latest facts per frame.
  const overlap = (
    source: PlaybackSource,
    mapping: TimelineSource,
    frames: bigint,
  ) => {
    heads.set(source, frames);
    const state = metadataWrites.get(source)!;
    const pending = state.pending.splice(0);
    for (const marker of pending) {
      const moved = {
        ...marker,
        sourceFrame: marker.sourceFrame > frames
          ? marker.sourceFrame - frames
          : 0n,
        originFrame: mapping.originFrame + frames,
      };
      if (state.pending.at(-1)?.sourceFrame === moved.sourceFrame) {
        state.pending[state.pending.length - 1] = moved;
      } else state.pending.push(moved);
    }
  };
  // Native errors retain their transport owner even when they race decoder EOF.
  // A drain/seal/append rejection must never enter catalog content-failure policy.
  class TransportFailure extends Error {}
  const transport = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (cause) {
      throw new TransportFailure('Playback transport failed', { cause });
    }
  };
  const inputWindow = () =>
    deps.inputWindow
      ? transport(() => deps.inputWindow!([...mappings.values()]))
      : Promise.resolve(0);
  const wait = (ms: number, source?: PlaybackSource) =>
    new Promise<void>((resolve) => {
      const signal = source
        ? AbortSignal.any([controller.signal, source.signal])
        : controller.signal;
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
      if (signal.aborted) done();
    });
  const bind = (read: PlaybackRead) => {
    const source = read.source;
    const mapping = playback.bindSource(source, deps.streamId, epoch);
    if (!mapping) return null;
    leases.add(source);
    mappings.set(source, mapping);
    metadataWrites.set(source, { media: read.entry, pending: [] });
    queueMetadata(source, mapping, 0n);
    const publication = Promise.withResolvers<void>();
    publications.set(source, publication);
    source.signal.addEventListener('abort', () => publication.resolve(), {
      once: true,
    });
    deps.mapping(source, mapping);
    void operations.run(async () => {
      while (owns(source)) {
        if (playback.sourcePlanView().playing === source) {
          const progress = await sink.progress(epoch, mapping.source);
          if (progress && owns(source)) {
            playback.sourceProgress(source, progress);
          }
        }
        await wait(25, source);
      }
    }).catch((error) => {
      if (owns(source)) deps.transportFailed(error);
    });
    return mapping;
  };
  type Input = {
    pcm: PlaybackPcm;
    head: IteratorResult<Uint8Array>;
    ready: Uint8Array;
    prefetch?: ReturnType<typeof createPlaybackHead>;
  };
  const acquire = (read: PlaybackRead): Promise<Input | null> =>
    operations.run(async () => {
      const pcm = await deps.sources.open(read.entry, {
        signal: read.source.signal,
        startMs: read.source.startMs,
        onMetadata: (metadata, sourceFrame) => {
          if (owns(read.source)) {
            const mapping = mappings.get(read.source)!;
            queueMetadata(read.source, mapping, sourceFrame, metadata);
            playback.reportSourceMetadata(read.source, metadata, sourceFrame);
          }
        },
        retry: (reason, signal) =>
          playback.retrySource(read.source, reason, signal),
      });
      if (!pcm) throw new Error('No decodable audio');
      void operations.run(() => pcm.completion);
      if (!owns(read.source)) {
        await pcm.return();
        return null;
      }
      // At most one decoded head is retained outside the bounded native ingress.
      try {
        const head = await pcm.next();
        return { pcm, head, ready: new Uint8Array(0) };
      } catch (error) {
        await pcm.return();
        throw error;
      }
    });
  type Acquired = Awaited<ReturnType<typeof acquire>>;
  const future = (after: PlaybackSource) =>
    operations.run(async () => {
      while (owns(after)) {
        let read: PlaybackRead | null;
        try {
          read = await playback.prepareNextSource(after);
        } catch (error) {
          if (!owns(after)) return null;
          if (
            error instanceof Error && 'code' in error &&
            error.code === 'playback_cancelled'
          ) continue;
          // Preparation has its own retained failure. The due transition applies
          // existing source policy after A's native completion, never at read EOF.
          return { preparationFailed: true as const, error };
        }
        if (!live() || !read) return null;
        if (!playback.admitSource(read)) continue;
        continuous = true;
        const mapping = bind(read);
        if (!mapping) return null;
        try {
          const input = await acquire(read);
          if (input && finite(read.entry)) prefetch(input, requestedFrames());
          return { read, mapping, input };
        } catch (error) {
          if (owns(read.source)) {
            playback.reportSourceOutcome(read.source, 'decode-error');
          }
          return { read, mapping, input: null, error };
        }
      }
      return null;
    });
  const observeCompletion = (
    source: PlaybackSource,
    mapping: TimelineSource,
    target: bigint,
  ) => {
    let key = { epoch, source: mapping.source, target, revision: 1n };
    const revisions = [key];
    void operations.run(async () => {
      try {
        let completion = await sink.waitCompletion(key);
        if (!owns(source)) return;
        while (completion.status === 'failed' && owns(source)) {
          const exclude = playback.reviseSourceCompletion(source, completion);
          if (!exclude) break;
          key = await sink.reviseCompletion(key, exclude);
          revisions.push(key);
          completion = await sink.waitCompletion(key);
        }
        if (!owns(source)) return;
        if (completion.status !== 'complete') {
          throw new Error(`Source completion failed: ${completion.status}`);
        }
        // Native completion is a fact, but publication must also follow the
        // reader's handoff/end decision. In particular compatibility silence
        // must finish before final retirement can destroy its observations.
        await publications.get(source)!.promise;
        if (!owns(source)) return;
        await sink.waitCompletion(key);
        const progress = await sink.progress(epoch, mapping.source);
        if (progress && owns(source)) playback.sourceProgress(source, progress);
        await playback.completeSource(source, completion);
      } catch (error) {
        if (owns(source)) deps.transportFailed(error);
      } finally {
        try {
          for (const revision of revisions) {
            await sink.waitCompletion(revision);
            await sink.ackCompletion(revision);
          }
        } catch (error) {
          deps.retirementFailed(error);
        }
        mappings.delete(source);
        publications.delete(source);
        leases.delete(source);
      }
    });
  };
  type Body = {
    read: PlaybackRead;
    mapping: TimelineSource;
    /** Bytes natively accepted for this source, excluding any overlapped head. */
    written: number;
    hold: ReturnType<typeof createTailHold>;
  };
  // Append one range under its source until fully accepted. A decoder chunk
  // reports exact native acceptance; held or pre-copied ranges were already
  // taken from the decoder.
  const append = async (
    body: Body,
    data: Uint8Array,
    decoder?: { pcm: PlaybackPcm; chunk: Uint8Array },
  ) => {
    const { read: { source }, mapping } = body;
    const segment = deps.segment();
    let offset = 0;
    while (offset < data.length && owns(source)) {
      const settled = playback.beginSourceInput(source);
      if (!settled) return false;
      try {
        deps.admitted();
        const receipt = await transport(() =>
          sink.appendSource({
            epoch,
            source: mapping.source,
            segment,
            pcm: data.subarray(offset),
          })
        );
        const accepted = Number(receipt.acceptedFrames) * 4;
        acceptedInput += receipt.acceptedFrames;
        if (accepted) acceptedMappings.add(mapping);
        if (owns(source) && decoder) {
          decoder.pcm.accept(decoder.chunk, receipt.acceptedFrames);
        }
        offset += accepted;
        body.written += accepted;
        if (owns(source) && accepted) {
          playback.sourceAccepted(source, receipt.acceptedFrames);
          playback.sourceAudio(source, accepted / 176400 * 1000);
        }
        const pendingMetadata = metadataWrites.get(source)!.pending;
        while (
          owns(source) && body.written > 0 && pendingMetadata.length &&
          pendingMetadata[0].sourceFrame <= BigInt(body.written / 4)
        ) {
          const status = await transport(() =>
            sink.metadata(pendingMetadata[0])
          );
          if (status === 'accepted') pendingMetadata.shift();
          else if (status === 'canceled') return false;
          else await wait(10, source);
        }
        if (!owns(source)) return false;
        if (receipt.status === 'error' || receipt.status === 'canceled') {
          deps.transportFailed(
            new Error(
              `RAOP append failed: ${receipt.status}/${
                receipt.error ?? 'none'
              }`,
            ),
          );
          return false;
        }
      } finally {
        settled();
      }
      if (offset < data.length) await wait(10, source);
    }
    return owns(source);
  };
  // Decoder input through decoder EOF. With a requested crossfade, the last
  // frames stay in a rolling tail until the boundary is decided.
  const writeBody = async (
    read: PlaybackRead,
    mapping: TimelineSource,
    input: NonNullable<Acquired>,
    holdFrames: bigint,
  ): Promise<Body | null> => {
    const { source } = read, { pcm } = input;
    const body: Body = {
      read,
      mapping,
      written: 0,
      hold: createTailHold(holdFrames),
    };
    let observed = false;
    const feed = async (chunk: Uint8Array, decoded: boolean) => {
      if (!observed && chunk.length) {
        observed = true;
        deps.inputObserved?.('first', read, chunk.length);
      }
      if (!holdFrames) {
        return await append(body, chunk, decoded ? { pcm, chunk } : undefined);
      }
      if (decoded) pcm.accept(chunk, BigInt(chunk.length / 4));
      for (const part of body.hold.push(chunk)) {
        if (!await append(body, part)) return false;
      }
      return owns(source);
    };
    const nextPart = async (
      next: () => Promise<IteratorResult<Uint8Array>>,
    ): Promise<IteratorResult<Uint8Array>> => {
      if (!body.hold.frames || !acceptedInput) return await next();
      let settled = false;
      const pending = next().finally(() => settled = true);
      void pending.catch(() => {});
      const remaining = await inputWindow() - performance.now();
      if (!settled && remaining > 0) {
        await Promise.race([pending, wait(remaining, source)]);
      }
      if (!settled && owns(source)) {
        // Retained PCM is still valid outgoing audio. A slow decoder cannot
        // starve an established stream just to preserve a possible future fade.
        if (!await append(body, body.hold.take())) {
          return { done: true, value: undefined };
        }
      }
      return await pending;
    };
    try {
      if (pcm.originFrame !== mapping.originFrame) {
        throw new Error('Playback source differs from its timeline origin');
      }
      if (input.ready.length && !await feed(input.ready, false)) return null;
      let part = input.prefetch
        ? await nextPart(() => input.prefetch!.next())
        : input.head;
      while (!part.done && owns(source)) {
        if (!await feed(part.value, true)) return null;
        part = await nextPart(() => pcm.next());
      }
      if (!owns(source)) return null;
      if (!pcm.eof || !(body.written + Number(body.hold.frames) * 4)) {
        throw new Error('Empty or incomplete decoder stream');
      }
      deps.inputObserved?.(
        'end',
        read,
        body.written + Number(body.hold.frames) * 4,
      );
      playback.reportSourceOutcome(source, 'eof');
      return owns(source) ? body : null;
    } finally {
      await pcm.return();
      await pcm.completion;
    }
  };
  // Append the held tail (optionally its overlap with the incoming head) and
  // seal the source behind it.
  const finalize = async (body: Body, incomingHead?: Uint8Array) => {
    const { read: { source }, mapping } = body;
    const tail = body.hold.take();
    const split = tail.length - (incomingHead?.length ?? 0);
    if (split && !await append(body, tail.subarray(0, split))) return null;
    if (
      incomingHead &&
      !await append(body, mixCrossfade(tail.subarray(split), incomingHead))
    ) return null;
    const target = BigInt(body.written / 4);
    if (!target) throw new Error('Empty or incomplete decoder stream');
    if (!playback.sealSource(source, target)) return null;
    let marker;
    do {
      marker = await transport(() => sink.seal(epoch, mapping.source, target));
      if (marker.status === 'accepted') break;
      if (!['backpressure', 'not-ready'].includes(marker.status)) {
        throw new TransportFailure(`RAOP seal failed: ${marker.status}`);
      }
      await wait(10, source);
    } while (owns(source));
    if (!owns(source)) return null;
    observeCompletion(source, mapping, target);
    return { inputEnd: marker.inputEnd, frames: target };
  };
  const prefetch = (input: Input, frames: bigint) => {
    if (!input.prefetch && frames > 0n) {
      input.prefetch = createPlaybackHead(
        input.pcm,
        input.head,
        frames,
        (work) => operations.run(work),
      );
    }
    return input.prefetch;
  };
  const natural = (entry: QueueEntry) =>
    entry.facts.kind === 'song'
      ? (queueDuration(entry) ?? 0) > 0
      : entry.facts.mode === 'finite';
  const endStream = async (source: PlaybackSource, target: bigint) => {
    const result = await transport(() => sink.endStream(epoch, target));
    if (result.status !== 'accepted') {
      throw new TransportFailure(`RAOP end failed: ${result.status}`);
    }
    await transport(() => sink.waitDrain(epoch));
    if (!owns(source)) return;
    drained = true;
    publications.get(source)?.resolve();
  };
  const finite = (entry: QueueEntry) =>
    entry.facts.kind === 'song' || entry.facts.mode === 'finite';
  const requestedFrames = () => deps.crossfadeFrames?.() ?? 0n;
  const work = operations.run(async () => {
    let read = deps.initial, mapping = bind(read);
    if (!mapping) return;
    let input: Acquired = null;
    try {
      while (owns(read.source)) {
        // Preparation and one incoming head run concurrently with the outgoing
        // decoder, while the core keeps public current at the playing cursor.
        let pendingReady = false;
        const pending = natural(read.entry)
          ? future(read.source).then((next) => {
            pendingReady = true;
            return next;
          })
          : null;
        void pending?.catch(() => {});
        input ??= await acquire(read);
        if (!input) return;
        // The outgoing tail hold is captured when this source begins input;
        // already accepted audio never changes with a later setting.
        const body = await writeBody(
          read,
          mapping,
          input,
          pending ? requestedFrames() : 0n,
        );
        input = null;
        if (!body || !live()) return;
        const head = heads.get(read.source) ?? 0n;
        const decoded = head + BigInt(body.written / 4) + body.hold.frames;
        const length = queueDuration(read.entry) ?? 0;
        const compatibility = read.entry.facts.kind === 'song' &&
          Math.round(Number(decoded) * 1000 / 44100) + read.source.startMs <
            length;
        const requested = requestedFrames();
        let skippedReason: CrossfadeRecord['reason'] = 'compatibility';
        let inputDeadline: number | undefined;
        const withinInputWindow = async (ready: Promise<unknown>) => {
          inputDeadline ??= await inputWindow();
          const remaining = inputDeadline - performance.now();
          if (remaining > 0) {
            await Promise.race([ready, wait(remaining, read.source)]);
          }
        };
        let end: Awaited<ReturnType<typeof finalize>> = null;
        const plain = async () => (end ??= await finalize(body));
        if (compatibility) {
          if (!await plain()) return;
          await transport(() =>
            sink.compatibilitySilence(epoch, mapping!.source)
          );
          while (
            owns(read.source) &&
            playback.sourcePlanView().playing !== read.source
          ) {
            await wait(10, read.source);
          }
          while (
            owns(read.source) &&
            playback.sourceCompatibilityRemaining(read.source) > 0
          ) {
            await wait(
              playback.sourceCompatibilityRemaining(read.source),
              read.source,
            );
          }
        }
        const endInput = async () => {
          const sealed = await plain();
          if (sealed) await endStream(read.source, sealed.inputEnd);
        };
        if (pending && !pendingReady && !end) {
          if (requested > 0n && body.hold.frames >= 2n) {
            await withinInputWindow(pending);
          }
          // The next decoder cannot withhold healthy outgoing audio. Its head
          // may arrive later, but this boundary is now committed as solo PCM.
          if (!pendingReady) {
            skippedReason = body.hold.frames < 2n
              ? 'short-outgoing'
              : 'incoming-not-ready';
            if (!await plain()) return;
          }
        }
        let next = await pending;
        // EOF may follow an earlier exhausted prefetch and a later ordinary
        // append. Recheck that relationship before committing final input end.
        if (!next && !continuous && natural(read.entry) && owns(read.source)) {
          next = await future(read.source);
        }
        for (;;) {
          if (next && 'preparationFailed' in next) {
            await endInput();
            return;
          }
          if (live() && next?.read.source.signal.aborted && owns(read.source)) {
            await next.input?.pcm.return();
            const replacement = await future(read.source);
            if (replacement && 'preparationFailed' in replacement) {
              await endInput();
              return;
            }
            next = replacement;
            continue;
          }
          if (!live()) return;
          if (!next) {
            if (
              continuous && natural(read.entry) &&
              !playback.finishSources(read.source)
            ) {
              next = await future(read.source);
              continue;
            }
            await endInput();
            return;
          }
          break;
        }
        if (!next.input) {
          // Its failure is due-only core policy. End the healthy prefix so its
          // exact tail can complete before that failure is published.
          await endInput();
          return;
        }
        if (finite(next.read.entry)) prefetch(next.input, requested);
        const headInput = next.input.prefetch;
        const wanted =
          (requested < body.hold.frames ? requested : body.hold.frames) + 1n;
        while (
          !end && headInput && !headInput.finished &&
          headInput.frames < wanted && owns(read.source)
        ) {
          await withinInputWindow(headInput.changed);
          if (performance.now() >= (inputDeadline ?? 0)) break;
        }
        const ready = next.input.prefetch?.freeze();
        if (ready) next.input.ready = ready.bytes;
        if (ready?.failed) {
          if (owns(next.read.source)) {
            playback.reportSourceOutcome(next.read.source, 'decode-error');
          }
          await next.input.pcm.return();
          await endInput();
          return;
        }
        let incoming: Uint8Array | undefined;
        if (end && requested > 0n) {
          deps.crossfadeObserved?.({
            outgoingEntryId: read.source.entryId,
            incomingEntryId: next.read.source.entryId,
            requestedFrames: requested,
            appliedFrames: 0n,
            reason: skippedReason,
          });
        } else if (requested > 0n) {
          let plan: ReturnType<typeof crossfadePlan> = {
            appliedFrames: 0n,
            reason: 'ineligible',
          };
          if (finite(next.read.entry) && ready) {
            plan = crossfadePlan({
              requestedFrames: requested,
              outgoingFrames: body.hold.frames,
              incomingFrames: ready.frames,
              // A pending read may be EOF: never consume the incoming source's
              // entire available head and leave it without its own marker.
              incomingEnded: true,
            });
            if (!ready.ended && plan.reason === 'short-incoming') {
              plan = { ...plan, reason: 'incoming-not-ready' };
            }
          }
          // Bind before the mix enters native input: a later edit of the
          // incoming item is then an accepted-future discontinuity.
          if (
            plan.appliedFrames &&
            playback.overlapSource(next.read.source, plan.appliedFrames)
          ) {
            const bytes = Number(plan.appliedFrames) * 4;
            incoming = next.input.ready.subarray(0, bytes);
            next.input.ready = next.input.ready.subarray(bytes);
            overlap(next.read.source, next.mapping, plan.appliedFrames);
          } else if (plan.appliedFrames) {
            plan = { appliedFrames: 0n, reason: 'ineligible' };
          }
          deps.crossfadeObserved?.({
            outgoingEntryId: read.source.entryId,
            incomingEntryId: next.read.source.entryId,
            requestedFrames: requested,
            appliedFrames: plan.appliedFrames,
            reason: plan.reason,
          });
        }
        if (!end && !(end = await finalize(body, incoming))) {
          await next.input.pcm.return();
          return;
        }
        publications.get(read.source)?.resolve();
        read = next.read;
        mapping = next.mapping;
        input = next.input;
      }
    } catch (error) {
      if (owns(read.source)) {
        if (error instanceof TransportFailure) deps.transportFailed(error);
        else {
          deps.contentFailed(read.entry, error);
          playback.reportSourceOutcome(read.source, 'decode-error');
        }
      }
    } finally {
      await input?.pcm.return();
    }
  });
  void work.catch(deps.transportFailed);
  return {
    get drained() {
      return drained;
    },
    settled: work.then(() => operations.close()),
    mapping(source: PlaybackSource) {
      return mappings.get(source);
    },
    admitted(mapping: TimelineSource) {
      return acceptedMappings.has(mapping);
    },
    cancel() {
      controller.abort();
      for (const source of leases) playback.cancelSource(source);
    },
    async close() {
      this.cancel();
      await operations.close();
    },
  };
}
