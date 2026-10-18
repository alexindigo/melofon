// src/state.ts — app.state: internal state, operator-owned live config
// (one DuckDB table — persists across restarts). The /_/config endpoints are
// its read/write face; the Settings UI (M5) will be a form on them, never a
// second store. Components subscribe with onChange for live toggles (e.g.
// AirPlay mDNS discovery). Env/toml stay first-boot seeds (seedIfUnset) —
// they never stomp an operator's persisted choice.
import type { Store } from './store/index.ts';
import { type Log, scopedLog } from './logging.ts';
import {
  parseSetting,
  parseSettingsSchema,
  type SettingsSchema,
  SettingsValidationError,
  type SettingValue,
} from './settings-schema.ts';
import type { StateValue } from './store/state.ts';
export { StateRevisionError } from './store/state.ts';

export interface State {
  /** Register synchronously; typed reads, writes and listing await persistence. */
  declare(key: string, schema: unknown): void;
  get(key: string): Promise<string | null>;
  getTyped(key: string): Promise<SettingValue | undefined>;
  getWithRevision(key: string): Promise<StateValue>;
  /** Upsert + notify listeners. */
  set(
    key: string,
    value: string,
    options?: { expectedRevision?: number },
  ): Promise<void>;
  /** Sets only when the key is unset; true when it seeded. */
  seedIfUnset(key: string, value: string): Promise<boolean>;
  /** Visible stored keys; declarations retired by their owner stay hidden. */
  list(): Promise<Record<string, string>>;
  /** Subscribe to changes; returns the unsubscribe. */
  onChange(fn: (key: string, value: string) => void): () => void;
}

export function createState(
  store: Store,
  log: Log = scopedLog('state'),
): State {
  const declarations = new Map<
    string,
    { schema: SettingsSchema; ready: Promise<void> }
  >();
  const validate = (key: string, value: string) => {
    const declaration = declarations.get(key);
    if (declaration) {
      try {
        parseSetting(declaration.schema, value);
      } catch (error) {
        if (error instanceof SettingsValidationError) {
          throw new SettingsValidationError(`${key}: ${error.message}`);
        }
        throw error;
      }
    }
    return declaration;
  };
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
    declare(key, raw) {
      const schema = parseSettingsSchema(raw);
      const previous = declarations.get(key);
      if (previous) {
        if (JSON.stringify(previous.schema) !== JSON.stringify(schema)) {
          throw new SettingsValidationError(
            `${key}: already declared with a different schema`,
          );
        }
        return;
      }
      const ready = store.state.markDeclared(key);
      // Persistence failures remain observable on subsequent operations, not unhandled tasks.
      void ready.catch(() => {});
      declarations.set(key, { schema, ready });
    },
    get: store.state.get,
    getWithRevision: store.state.getWithRevision,
    async getTyped(key) {
      const declaration = declarations.get(key);
      await declaration?.ready;
      const raw = await store.state.get(key);
      if (!declaration) return raw ?? undefined;
      return raw === null
        ? structuredClone(declaration.schema.default)
        : parseSetting(declaration.schema, raw);
    },

    async set(key, value, options) {
      const declaration = validate(key, value);
      await declaration?.ready;
      await store.state.set(key, value, {
        ...options,
        declared: declaration !== undefined,
      });
      emit(key, value);
    },

    async seedIfUnset(key, value) {
      const declaration = validate(key, value);
      await declaration?.ready;
      if (
        !await store.state.seedIfUnset(key, value, declaration !== undefined)
      ) return false;
      emit(key, value);
      return true;
    },

    async list() {
      await Promise.all([...declarations.values()].map((d) => d.ready));
      return store.state.list([...declarations.keys()]);
    },

    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
