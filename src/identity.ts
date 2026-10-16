// Core-only read side of the retained identity index. The scan owns all writes.
import type { Store } from './store/index.ts';
import type { DuplicateGroup, FileEvent } from './store/catalog.ts';
export type { DuplicateGroup, FileEvent } from './store/catalog.ts';

export interface Identity {
  duplicates(): Promise<DuplicateGroup[]>;
  events(opts: { limit: number }): Promise<FileEvent[]>;
  /** Epoch milliseconds, including identities currently absent from the catalog. */
  firstSeen(ids: string[]): Promise<Record<string, number>>;
}

export function createIdentity(store: Store): Identity {
  return {
    duplicates: store.catalog.duplicates,
    events: store.catalog.events,
    firstSeen: store.catalog.firstSeen,
  };
}
