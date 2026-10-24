// Core change-event hub. Legacy OwnTone names remain compatible; native
// names carry ids and, for private changes, an explicit user audience.

import { type Log, scopedLog } from './logging.ts';
export type NotifyFn = (
  types: string[],
  keys?: Record<string, string[]>,
  audience?: { userId: string },
) => void;

export interface Notify {
  /** Adds a listener; returns the unsubscribe (sockets drop on close/error). */
  subscribe(fn: NotifyFn): () => void;
  /** Synchronously notifies every listener of the (known) types. */
  emit(
    types: string[],
    keys?: Record<string, string[]>,
    audience?: { userId: string },
  ): void;
}

const bootId = crypto.randomUUID();

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
  'users',
  'me',
  'sessions',
  'preferences',
  'plugins',
]);

export function createNotify(
  log: Log = scopedLog('notify'),
): Notify & { readonly bootId: string } {
  const subscribers = new Set<NotifyFn>();
  return {
    bootId,
    subscribe(fn) {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    emit(types, keys, audience) {
      const known = types.filter((t) => KNOWN.has(t));
      if (known.length === 0) return;
      for (const fn of [...subscribers]) {
        try {
          fn(known, keys, audience);
        } catch (err) {
          // A broken listener (closing socket, …) must not break the emitter
          // or starve the other listeners.
          log.event('notify_listener_failed', { error: err });
        }
      }
    },
  };
}
