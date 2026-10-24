// src/notify.ts — app.notify: the in-process change-event hub. Core services
// emit (player, outputs, later scan → database); hats subscribe (the OwnTone
// notify websocket). The vocabulary is OwnTone's event names. Unknown names
// are dropped at emit so a typo never reaches the wire; known-but-unemitted
// names (database, pairing, …) are valid subscriptions that simply stay
// quiet until something emits them. Sync emit, no DuckDB, no persistence.

import { type Log, scopedLog } from './logging.ts';
export type NotifyFn = (
  types: string[],
  keys?: Record<string, string[]>,
) => void;

export interface Notify {
  /** Adds a listener; returns the unsubscribe (sockets drop on close/error). */
  subscribe(fn: NotifyFn): () => void;
  /** Synchronously notifies every listener of the (known) types. */
  emit(types: string[], keys?: Record<string, string[]>): void;
}

// OwnTone's event vocabulary (docs/json-api.md §Push notifications + the
// extras their websocket.c knows: pairing/spotify/lastfm).
const KNOWN = new Set([
  'player',
  'outputs',
  'volume',
  'options',
  'queue',
  'database',
  'update',
  'pairing',
  'spotify',
  'lastfm',
  'hats',
  'settings',
  'libraries',
  'scan',
]);

export function createNotify(log: Log = scopedLog('notify')): Notify {
  const subscribers = new Set<NotifyFn>();
  return {
    subscribe(fn) {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    emit(types, keys) {
      const known = types.filter((t) => KNOWN.has(t));
      if (known.length === 0) return;
      for (const fn of [...subscribers]) {
        try {
          fn(known, keys);
        } catch (err) {
          // A broken listener (closing socket, …) must not break the emitter
          // or starve the other listeners.
          log.event('notify_listener_failed', { error: err });
        }
      }
    },
  };
}
