// One bounded, ordered reader per transport epoch. Core chooses every successor;
// a completed decoder releases input, not the playing cursor or its sink gate.
import { createOperationScope } from './operations.ts';
import type { Playback, PlaybackRead } from './playback.ts';
import type { PlaybackSource } from './player.ts';
import type { PlaybackSources } from './playback-source.ts';
import type { QueueEntry } from './queue-source.ts';
import { queueDuration } from './queue-source.ts';
import type { TimelineSource, TimelineWriter } from './playback-timeline.ts';

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
  transportFailed(error: unknown): void;
  contentFailed(entry: QueueEntry, error: unknown): void;
  retirementFailed(error: unknown): void;
}) {
  const { playback, sink, epoch } = deps;
  const operations = createOperationScope('Playback reader');
  const controller = new AbortController();
  const mappings = new Map<PlaybackSource, TimelineSource>();
  const acceptedMappings = new WeakSet<TimelineSource>();
  const leases = new Set<PlaybackSource>([deps.initial.source]);
  const publications = new Map<
    PlaybackSource,
    ReturnType<typeof Promise.withResolvers<void>>
  >();
  let drained = false;
  let continuous = false;
  const live = () => !controller.signal.aborted && deps.current();
  const owns = (source: PlaybackSource) => live() && !source.signal.aborted;
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
  const acquire = (read: PlaybackRead) =>
    operations.run(async () => {
      const pcm = await deps.sources.open(read.entry, {
        signal: read.source.signal,
        startMs: read.source.startMs,
        onMetadata: (metadata) => {
          if (owns(read.source)) {
            playback.reportSourceMetadata(read.source, metadata);
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
        return { pcm, head };
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
          return { read, mapping, input: await acquire(read) };
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
  const write = async (
    read: PlaybackRead,
    mapping: TimelineSource,
    input: NonNullable<Acquired>,
  ) => {
    const { source } = read, { pcm } = input;
    let bytes = 0;
    try {
      if (pcm.originFrame !== mapping.originFrame) {
        throw new Error('Playback source differs from its timeline origin');
      }
      let part = input.head;
      while (!part.done && owns(source)) {
        const chunk = part.value, segment = deps.segment();
        if (!bytes) deps.inputObserved?.('first', read, chunk.length);
        let offset = 0;
        while (offset < chunk.length && owns(source)) {
          const settled = playback.beginSourceInput(source);
          if (!settled) return null;
          try {
            deps.admitted();
            const receipt = await transport(() =>
              sink.appendSource({
                epoch,
                source: mapping.source,
                segment,
                pcm: chunk.subarray(offset),
              })
            );
            const accepted = Number(receipt.acceptedFrames) * 4;
            if (accepted) acceptedMappings.add(mapping);
            if (owns(source)) pcm.accept(chunk, receipt.acceptedFrames);
            offset += accepted;
            bytes += accepted;
            if (owns(source) && accepted) {
              playback.sourceAccepted(source, receipt.acceptedFrames);
              playback.sourceAudio(source, accepted / 176400 * 1000);
            }
            if (!owns(source)) return null;
            if (receipt.status === 'error' || receipt.status === 'canceled') {
              deps.transportFailed(
                new Error(
                  `RAOP append failed: ${receipt.status}/${
                    receipt.error ?? 'none'
                  }`,
                ),
              );
              return null;
            }
          } finally {
            settled();
          }
          if (offset < chunk.length) await wait(10, source);
        }
        if (!owns(source)) return null;
        part = await pcm.next();
      }
      if (!owns(source)) return null;
      if (!pcm.eof || !bytes) {
        throw new Error('Empty or incomplete decoder stream');
      }
      deps.inputObserved?.('end', read, bytes);
      playback.reportSourceOutcome(source, 'eof');
      if (!owns(source)) return null;
      const target = BigInt(bytes / 4);
      if (!playback.sealSource(source, target)) return null;
      let marker;
      do {
        marker = await transport(() =>
          sink.seal(epoch, mapping.source, target)
        );
        if (marker.status === 'accepted') break;
        if (!['backpressure', 'not-ready'].includes(marker.status)) {
          throw new TransportFailure(`RAOP seal failed: ${marker.status}`);
        }
        await wait(10, source);
      } while (owns(source));
      if (!owns(source)) return null;
      observeCompletion(source, mapping, target);
      return { inputEnd: marker.inputEnd, frames: target };
    } finally {
      await pcm.return();
      await pcm.completion;
    }
  };
  const natural = (entry: QueueEntry) =>
    entry.facts.kind === 'song'
      ? (queueDuration(entry) ?? 0) > 0
      : entry.facts.mode === 'finite';
  const endInput = async (source: PlaybackSource, target: bigint) => {
    const result = await transport(() => sink.endStream(epoch, target));
    if (result.status !== 'accepted') {
      throw new TransportFailure(`RAOP end failed: ${result.status}`);
    }
    await transport(() => sink.waitDrain(epoch));
    if (!owns(source)) return;
    drained = true;
    publications.get(source)?.resolve();
  };
  const work = operations.run(async () => {
    let read = deps.initial, mapping = bind(read);
    if (!mapping) return;
    let input: Acquired = null;
    try {
      while (owns(read.source)) {
        // Preparation and one incoming head run concurrently with the outgoing
        // decoder, while the core keeps public current at the playing cursor.
        const pending = natural(read.entry) ? future(read.source) : null;
        void pending?.catch(() => {});
        input ??= await acquire(read);
        if (!input) return;
        const end = await write(read, mapping, input);
        input = null;
        if (!end || !live()) return;
        const length = queueDuration(read.entry) ?? 0;
        if (
          read.entry.facts.kind === 'song' &&
          Math.round(Number(end.frames) * 1000 / 44100) + read.source.startMs <
            length
        ) {
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
        let next = await pending;
        // EOF may follow an earlier exhausted prefetch and a later ordinary
        // append. Recheck that relationship before committing final input end.
        if (!next && !continuous && natural(read.entry) && owns(read.source)) {
          next = await future(read.source);
        }
        for (;;) {
          if (next && 'preparationFailed' in next) {
            await endInput(read.source, end.inputEnd);
            return;
          }
          if (live() && next?.read.source.signal.aborted && owns(read.source)) {
            await next.input?.pcm.return();
            const replacement = await future(read.source);
            if (replacement && 'preparationFailed' in replacement) {
              await endInput(read.source, end.inputEnd);
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
            await endInput(read.source, end.inputEnd);
            return;
          }
          break;
        }
        if (!next.input) {
          // Its failure is due-only core policy. End the healthy prefix so its
          // exact tail can complete before that failure is published.
          await endInput(read.source, end.inputEnd);
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
