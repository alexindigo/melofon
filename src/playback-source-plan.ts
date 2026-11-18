// Core source preparation has a read cursor independent of the playing source.
// C1 owns acquisition to settlement, C2 binds cancellation to this plan's handle.
// No queue publication, decoder, transport or newest-command lookup lives here.
import { createOperationScope } from './operations.ts';
import type { CommandHandle } from './command-authority.ts';
import type { PlaybackSource, Player } from './player.ts';
import type { QueueMedia } from './queue-source.ts';
import {
  reconcilePlaybackSuccessor,
  type SuccessorPlan,
} from './playback-successor.ts';
import { PlaybackError } from './playback-errors.ts';

type PreparedSource = {
  source: PlaybackSource;
  media: QueueMedia;
  /** Readiness alone does not replace already-resolved queue facts. */
  refreshed: boolean;
} | null;

export interface SourcePreparation {
  readonly plan: SuccessorPlan;
  readonly generation: number;
  readonly command: CommandHandle;
  readonly after?: PlaybackSource;
  readonly signal: AbortSignal;
  readonly settled: Promise<void>;
  readonly ready: PreparedSource | Promise<PreparedSource>;
  source: PlaybackSource | null;
  media: QueueMedia | null;
  refreshed: boolean;
  through: number | null;
  error?: unknown;
}

export function createSourcePlanOwner(deps: {
  player: Player;
  resolve(
    media: QueueMedia,
    signal: AbortSignal,
  ): QueueMedia | null | Promise<QueueMedia | null>;
  current(reason: SuccessorPlan['reason']): SuccessorPlan | null;
  afterCurrent?(
    reason: SuccessorPlan['reason'],
    after: PlaybackSource,
  ): SuccessorPlan | null;
}) {
  const operations = createOperationScope('Source preparation');
  let reading: SourcePreparation | null = null;
  let latest: SourcePreparation | null = null;
  let playing: PlaybackSource | null = null;
  const admitted: SourcePreparation[] = [];
  const controllers = new WeakMap<SourcePreparation, AbortController>();
  const unbind = new WeakMap<SourcePreparation, () => void>();
  const cancelled = () =>
    new PlaybackError('playback_cancelled', 'Source plan cancelled');
  const cancel = (record: SourcePreparation) => {
    unbind.get(record)?.();
    unbind.delete(record);
    controllers.get(record)?.abort();
    if (record.source) deps.player.cancelSource(record.source);
    if (reading === record) reading = null;
  };
  const reconcile = (record: SourcePreparation) => {
    if (
      record.signal.aborted ||
      !admitted.includes(record) && !record.command.isCurrent() ||
      (record.after
        ? !deps.player.hasSource(record.after)
        : deps.player.status().generation !== record.generation)
    ) return null;
    const current = record.after && deps.afterCurrent
      ? deps.afterCurrent(record.plan.reason, record.after)
      : deps.current(record.plan.reason);
    if (!current) return null;
    return reconcilePlaybackSuccessor(
      record.plan,
      current,
      record.through,
    );
  };
  return {
    get reading() {
      return reading;
    },
    get playing() {
      // Keep the last playing identity for the sink's atomic-cutoff authority
      // even after its reader is revoked. Reader cancellation is not retirement.
      return playing;
    },
    get admitted(): readonly SourcePreparation[] {
      return admitted;
    },
    playingSource(source: PlaybackSource) {
      playing = source;
    },
    reconcile() {
      if (reading && !reconcile(reading)) cancel(reading);
      return admitted.findIndex((record) => !reconcile(record));
    },
    validate: reconcile,
    prepare(
      plan: SuccessorPlan,
      command: CommandHandle,
      after?: PlaybackSource,
    ): SourcePreparation {
      if (operations.closed) throw cancelled();
      if (
        reading && reading.plan.reason === plan.reason &&
        reading.command === command &&
        (reading.after ?? playing) === (after ?? playing) && reconcile(reading)
      ) {
        return reading;
      }
      const previous = latest;
      if (reading) cancel(reading);
      const controller = new AbortController();
      let settled!: Promise<void>;
      const abort = () => cancel(record);
      command.signal.addEventListener('abort', abort, { once: true });
      const record: SourcePreparation = {
        plan,
        command,
        after,
        generation: deps.player.status().generation,
        signal: controller.signal,
        get settled() {
          return settled;
        },
        get ready() {
          return ready;
        },
        source: null,
        media: null,
        refreshed: false,
        through: plan.entryId,
      };
      controllers.set(record, controller);
      unbind.set(
        record,
        () => command.signal.removeEventListener('abort', abort),
      );
      reading = record;
      latest = record;
      const acquired = () => {
        if (latest === record) latest = null;
      };
      const failed = (error: unknown): never => {
        const aborted = controller.signal.aborted;
        if (aborted) cancel(record);
        else {
          if (record.source) deps.player.cancelSource(record.source);
          record.source = null;
        }
        throw aborted ? cancelled() : error;
      };
      let ready: PreparedSource | Promise<PreparedSource>;
      try {
        ready = operations.runImmediate((operation) => {
          settled = operation.settled;
          operation.signal.addEventListener('abort', abort, { once: true });
          const finish = () => {
            operation.signal.removeEventListener('abort', abort);
          };
          const acquire = (
            index = 0,
          ): PreparedSource | Promise<PreparedSource> => {
            for (; index < plan.candidates.length; index++) {
              const entryId = plan.candidates[index];
              record.through = entryId;
              if (!reconcile(record)) throw cancelled();
              const source = deps.player.prepareSource(
                entryId,
                record.generation,
              );
              if (!source) throw cancelled();
              record.source = source;
              const item = plan.items.find((item) => item.id === entryId)!;
              const resolved = (media: QueueMedia | null) => {
                if (!reconcile(record) || source.signal.aborted) {
                  throw cancelled();
                }
                if (media) {
                  record.media = media;
                  record.refreshed = media !== item;
                  return { source, media, refreshed: record.refreshed };
                }
                deps.player.cancelSource(source);
                record.source = null;
                return null;
              };
              const media = deps.resolve(item, controller.signal);
              if (media instanceof Promise) {
                const next = index + 1;
                return media.then(resolved).then((result) =>
                  result ?? acquire(next)
                );
              }
              const result = resolved(media);
              if (result) return result;
            }
            record.through = null;
            if (!reconcile(record)) throw cancelled();
            return null;
          };
          try {
            // Only outstanding acquisition needs a join. Ready no-I/O facts keep
            // C1's synchronous publication contract, without a second policy path.
            const result = previous
              ? previous.settled.then(() => acquire())
              : acquire();
            if (result instanceof Promise) {
              return result.catch(failed).finally(finish);
            }
            finish();
            return result;
          } catch (error) {
            finish();
            return failed(error);
          }
        });
      } catch (error) {
        ready = Promise.reject(error);
      }
      // Speculation has no caller yet. Retain the error for the due boundary;
      // observing it here does not turn acquisition failure into success.
      if (ready instanceof Promise) {
        void ready.then(acquired, (error) => {
          record.error = error;
          acquired();
        });
      } else acquired();
      return record;
    },
    admit(record: SourcePreparation) {
      if (
        reading !== record || !reconcile(record) || !record.source ||
        !deps.player.admitSource(record.source)
      ) return false;
      admitted.push(record);
      reading = null;
      // Accepted input follows the source/transport lifetime, not a later
      // harmless option command. Relationship reconciliation fences edits.
      unbind.get(record)?.();
      unbind.delete(record);
      return true;
    },
    discardFuture(from = 0) {
      if (reading) cancel(reading);
      for (const record of admitted.splice(from)) cancel(record);
    },
    commit(
      record: SourcePreparation,
      change: (plan: SuccessorPlan) => boolean,
    ) {
      const plan = reconcile(record);
      if (!plan) {
        cancel(record);
        throw cancelled();
      }
      if (!change(plan)) return false;
      if (reading === record) reading = null;
      const index = admitted.indexOf(record);
      if (index >= 0) {
        if (index !== 0) throw new Error('Cannot publish an unordered source');
        admitted.shift();
        playing = record.source;
      }
      // The command can be superseded after promotion without aborting the
      // playing source (e.g. an option edit). Player discontinuities own that.
      controllers.delete(record);
      unbind.get(record)?.();
      unbind.delete(record);
      return true;
    },
    cancel,
    close() {
      if (reading) cancel(reading);
      for (const record of admitted.splice(0)) cancel(record);
      return operations.close();
    },
  };
}
