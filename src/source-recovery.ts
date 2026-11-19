// Recovery supplies its failed-occurrence facts to the shared successor policy.
import type { QueueEntry } from './queue-source.ts';
import type { RepeatMode } from './player.ts';
import { planPlaybackSuccessor } from './playback-successor.ts';

export function planSourceFailure(
  queue: readonly QueueEntry[],
  currentId: number | undefined,
  failed: ReadonlySet<number>,
  repeat: RepeatMode,
  consume: boolean,
  revision: number,
) {
  return planPlaybackSuccessor({
    reason: 'failure',
    revision,
    items: queue,
    currentEntryId: currentId,
    failed,
    repeat,
    consume,
  });
}
