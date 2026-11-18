// One pure queue policy for preparation and publication. Occurrence ids, not
// media references or reusable queue positions, identify every destination.
import type { RepeatMode } from './player.ts';
import type { QueueEntry } from './queue-source.ts';

export interface SuccessorPlan {
  readonly reason: 'natural' | 'failure';
  readonly revision: number;
  readonly currentEntryId: number | undefined;
  readonly repeat: RepeatMode;
  readonly consume: boolean;
  readonly excluded: readonly number[];
  /** Queue after this boundary's consume effect, before activation facts. */
  readonly items: readonly QueueEntry[];
  readonly removedEntryId: number | null;
  /** Ordered activation candidates, including source-resolution fallthrough. */
  readonly candidates: readonly number[];
  readonly entryId: number | null;
}

export function planPlaybackSuccessor(input: {
  reason: SuccessorPlan['reason'];
  revision: number;
  items: readonly QueueEntry[];
  currentEntryId: number | undefined;
  repeat: RepeatMode;
  consume: boolean;
  failed?: ReadonlySet<number>;
}): SuccessorPlan {
  const { reason, revision, currentEntryId, repeat, consume } = input;
  const at = input.items.findIndex((item) => item.id === currentEntryId);
  // Natural repeat has always taken priority over consume. Exhausted sources
  // bypass repeat-single and consume even with repeat-all, as before.
  const remove = at >= 0 && consume &&
    (reason === 'failure' || repeat === 'off');
  const items = Object.freeze(
    input.items.filter((item) => !remove || item.id !== currentEntryId),
  );
  const excluded = Object.freeze(
    reason === 'failure' ? [...input.failed ?? []] : [],
  );
  const candidates: number[] = [];
  if (at >= 0 && items.length) {
    let index = reason === 'natural' && repeat === 'single'
      ? at
      : at + (remove ? 0 : 1);
    const wrap = reason === 'natural' ? repeat !== 'off' : repeat === 'all';
    for (let visited = 0; visited < items.length; visited++, index++) {
      if (index >= items.length) {
        if (!wrap) break;
        index = 0;
      }
      if (!excluded.includes(items[index].id)) candidates.push(items[index].id);
    }
  }
  return Object.freeze({
    reason,
    revision,
    currentEntryId,
    repeat,
    consume,
    excluded,
    items,
    removedEntryId: remove ? currentEntryId! : null,
    candidates: Object.freeze(candidates),
    entryId: candidates[0] ?? null,
  });
}

/** Rebase unscheduled preparation only when the relationship it has actually
 * read is unchanged. Later queue entries and unrelated revisions are not locks.
 * A null selection means exhaustion, so the whole candidate list was read. */
export function reconcilePlaybackSuccessor(
  captured: SuccessorPlan,
  current: SuccessorPlan,
  through: number | null,
): SuccessorPlan | null {
  if (
    captured.reason !== current.reason ||
    captured.currentEntryId !== current.currentEntryId ||
    captured.repeat !== current.repeat ||
    captured.consume !== current.consume ||
    captured.removedEntryId !== current.removedEntryId ||
    captured.excluded.length !== current.excluded.length ||
    captured.excluded.some((id) => !current.excluded.includes(id))
  ) return null;
  const count = through === null
    ? captured.candidates.length
    : captured.candidates.indexOf(through) + 1;
  if (!count && through !== null) return null;
  if (through === null && count !== current.candidates.length) return null;
  return captured.candidates.slice(0, count).every((id, index) =>
      current.candidates[index] === id
    )
    ? current
    : null;
}
