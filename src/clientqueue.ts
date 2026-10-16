// app.clientQueue: the client's saved queue, separate from server playback.
import type { Store } from './store/index.ts';
import type { PlayQueueRow } from './store/clientqueue.ts';
export type { PlayQueueRow } from './store/clientqueue.ts';

export interface ClientQueue {
  get(username: string): Promise<PlayQueueRow | null>;
  save(
    username: string,
    queue: {
      trackIds: string[];
      currentId?: string;
      positionMs?: number;
      changedBy?: string;
    },
  ): Promise<void>;
}

export function createClientQueue(store: Store): ClientQueue {
  return store.clientQueue;
}
