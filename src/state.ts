// src/state.ts — app.state: internal state, operator-owned live config
// (one DuckDB table — persists across restarts). The /_/config endpoints are
// its read/write face; the Settings UI (M5) will be a form on them, never a
// second store. Components subscribe with onChange for live toggles (e.g.
// AirPlay mDNS discovery). Env/toml stay first-boot seeds (seedIfUnset) —
// they never stomp an operator's persisted choice.
import type { Store } from './store/index.ts';
import { type Log, scopedLog } from './logging.ts';
import {
  CONNECTION_STRATEGY_DEFAULT_KEY,
  requireConnectionStrategy,
} from './connection-strategy.ts';

export interface State {
  get(key: string): Promise<string | null>;
  /** Upsert + notify listeners. */
  set(key: string, value: string): Promise<void>;
  /** Sets only when the key is unset; true when it seeded. */
  seedIfUnset(key: string, value: string): Promise<boolean>;
  /** All keys, for the /_/config list. */
  list(): Promise<Record<string, string>>;
  /** Subscribe to changes; returns the unsubscribe. */
  onChange(fn: (key: string, value: string) => void): () => void;
}

export function createState(
  store: Store,
  log: Log = scopedLog('state'),
): State {
  const listeners = new Set<(key: string, value: string) => void>();
  const emit = (key: string, value: string) => {
    for (const fn of [...listeners]) {
      try {
        fn(key, value);
      } catch (err) {
        // A broken listener must not break the writer or starve the others.
        log.event('state_listener_failed', { error: err });
      }
    }
  };

  return {
    get: store.state.get,

    async set(key, value) {
      if (key === CONNECTION_STRATEGY_DEFAULT_KEY) {
        requireConnectionStrategy(value);
      }
      await store.state.set(key, value);
      emit(key, value);
    },

    async seedIfUnset(key, value) {
      if (key === CONNECTION_STRATEGY_DEFAULT_KEY) {
        requireConnectionStrategy(value);
      }
      if (!await store.state.seedIfUnset(key, value)) return false;
      emit(key, value);
      return true;
    },

    list: store.state.list,

    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
