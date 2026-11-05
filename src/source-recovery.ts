// Shared, pure queue transition plan. Playback prepares the selected activation;
// the engine applies exactly that plan without learning about IO or timers.
import type { QueueEntry } from './queue-source.ts';
import type { RepeatMode } from './player.ts';

export function planSourceFailure(
  queue: QueueEntry[],
  currentId: number | undefined,
  failed: ReadonlySet<number>,
  repeat: RepeatMode,
  consume: boolean,
): { items: QueueEntry[]; index: number | null } {
  const at = queue.findIndex((item) => item.id === currentId);
  const items = consume ? queue.filter((item) => item.id !== currentId) : queue;
  if (at < 0 || !items.length) return { items, index: null };
  let index = at + (consume ? 0 : 1);
  for (let visited = 0; visited < items.length; visited++, index++) {
    if (index >= items.length) {
      if (repeat !== 'all') break;
      index = 0;
    }
    if (!failed.has(items[index].id)) return { items, index };
  }
  return { items, index: null };
}
