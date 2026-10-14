// src/state.ts — app.state: internal state, operator-owned live config
// (one DuckDB table — persists across restarts). The /_/config endpoints are
// its read/write face; the Settings UI (M5) will be a form on them, never a
// second store. Components subscribe with onChange for live toggles (e.g.
// AirPlay mDNS discovery). Env/toml stay first-boot seeds (seedIfUnset) —
// they never stomp an operator's persisted choice.
import type { Db } from './db.ts';
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

function esc(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function createState(db: Db): State {
  const listeners = new Set<(key: string, value: string) => void>();
  const emit = (key: string, value: string) => {
    for (const fn of [...listeners]) {
      try {
        fn(key, value);
      } catch (err) {
        // A broken listener must not break the writer or starve the others.
        console.debug('[melofon] state listener threw:', err);
      }
    }
  };

  const get = async (key: string): Promise<string | null> => {
    const res = await db.conn.runAndReadAll(
      `SELECT value FROM state WHERE key = ${esc(key)}`,
    );
    const row = (res.getRowObjects() as { value: string }[])[0];
    return row === undefined ? null : row.value;
  };

  return {
    get,

    async set(key, value) {
      if (key === CONNECTION_STRATEGY_DEFAULT_KEY) {
        requireConnectionStrategy(value);
      }
      await db.conn.run(
        `INSERT OR REPLACE INTO state (key, value) VALUES (${esc(key)}, ${
          esc(value)
        })`,
      );
      emit(key, value);
    },

    async seedIfUnset(key, value) {
      if (key === CONNECTION_STRATEGY_DEFAULT_KEY) {
        requireConnectionStrategy(value);
        const res = await db.conn.runAndReadAll(
          `INSERT INTO state (key, value) VALUES (${esc(key)}, ${esc(value)})
           ON CONFLICT (key) DO NOTHING RETURNING value`,
        );
        if (res.getRowObjects().length === 0) return false;
        emit(key, value);
        return true;
      }
      if (await get(key) !== null) return false;
      await db.conn.run(
        `INSERT INTO state (key, value) VALUES (${esc(key)}, ${esc(value)})`,
      );
      emit(key, value);
      return true;
    },

    async list() {
      const res = await db.conn.runAndReadAll(
        'SELECT key, value FROM state ORDER BY key',
      );
      return Object.fromEntries(
        (res.getRowObjects() as { key: string; value: string }[]).map((r) => [
          r.key,
          r.value,
        ]),
      );
    },

    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
