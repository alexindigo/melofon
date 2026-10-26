// src/state.ts — app.state: internal state, operator-owned live config
// (one DuckDB table — persists across restarts). The /_/config endpoints are
// its read/write face; the Settings UI (M5) will be a form on them, never a
// second store. Components subscribe with onChange for live toggles (e.g.
// AirPlay mDNS discovery). Env/toml stay first-boot seeds (seedIfUnset) —
// they never stomp an operator's persisted choice.
import type { Store } from './store/index.ts';
import { appLogger, type Log, scopedLog } from './logging.ts';
import {
  encodeSetting,
  parseSetting,
  parseSettingsSchema,
  type SettingsSchema,
  SettingsValidationError,
  type SettingValue,
} from './settings-schema.ts';
import type { StateChange, StateValue, StoredSetting } from './store/state.ts';
import type { Notify } from './notify.ts';
import { SettingsError } from './settings-errors.ts';
import { UserError } from './user-errors.ts';
export { StateRevisionError } from './store/state.ts';

export type SettingsOwner = 'core' | `hat:${string}` | `plugin:${string}`;
export interface SettingDescription {
  key: string;
  owner: SettingsOwner;
  category: string;
  schema: Omit<SettingsSchema, 'default' | 'writeOnly'>;
  default?: SettingValue | null;
  value?: SettingValue | null;
  source: 'stored' | 'default';
  revision: number;
  writeOnly: boolean;
  isSet?: boolean;
  invalid?: true;
}

export interface State {
  /** Register synchronously; typed reads, writes and listing await persistence. */
  declare(key: string, schema: unknown, owner?: SettingsOwner): void;
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
  list(): Promise<Record<string, string | { isSet: boolean }>>;
  /** Subscribe to changes; returns the unsubscribe. */
  onChange(fn: (key: string, value: string) => void): () => void;
}

/** The registry's admin surface is separate from the ordinary owner port. */
export interface SettingsState extends State {
  describe(): Promise<SettingDescription[]>;
  change(caller: string, changes: unknown): Promise<SettingDescription[]>;
}

export function createState(
  store: Store,
  log: Log = scopedLog('state'),
  notify?: Notify,
): SettingsState {
  const register = (values: (string | undefined)[]) =>
    appLogger().registerSecrets(
      values.flatMap((value) =>
        value === undefined
          ? []
          : [value, ...value.split(',').map((part) => part.trim())]
      ),
    );
  // Persisted markers also cover secrets whose owning declaration was removed.
  const boot = store.state.snapshot().then((rows) => {
    register(
      rows.filter((row) => row.writeOnly).map((row) => row.value ?? undefined),
    );
  });
  void boot.catch(() => {});
  const declarations = new Map<
    string,
    { schema: SettingsSchema; owner: SettingsOwner; ready: Promise<void> }
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
  const ready = async () => {
    await boot;
    await Promise.all([...declarations.values()].map((d) => d.ready));
  };
  function describe(row: StoredSetting): SettingDescription {
    const { schema: declared, owner } = declarations.get(row.key)!;
    const { default: fallback, writeOnly: secret, ...schema } = structuredClone(
      declared,
    );
    const writeOnly = secret === true || row.writeOnly;
    let value = fallback ?? null;
    let invalid = false;
    if (!writeOnly && row.value !== null) {
      try {
        value = parseSetting(declared, row.value);
      } catch (error) {
        if (!(error instanceof SettingsValidationError)) throw error;
        invalid = true;
      }
    }
    return {
      key: row.key,
      owner,
      category: row.key.split('.')[0],
      schema,
      source: row.value === null ? 'default' : 'stored',
      revision: row.revision,
      writeOnly,
      ...(writeOnly
        ? { isSet: row.value !== null || fallback !== undefined }
        : {
          default: fallback ?? null,
          value,
          ...(invalid ? { invalid: true as const } : {}),
        }),
    };
  }
  const announce = (changes: StateChange[], rows: StoredSetting[]) => {
    for (const [index, change] of changes.entries()) {
      const schema = declarations.get(change.key)?.schema;
      const value = change.value ??
        (schema?.default === undefined ? '' : String(schema.default));
      emit(change.key, rows[index].writeOnly ? '' : value);
    }
    if (changes.length) {
      notify?.emit(
        ['settings'],
        { settings: changes.map((c) => c.key) },
        'admins',
      );
    }
  };

  return {
    declare(key, raw, owner = 'core') {
      const schema = parseSettingsSchema(raw);
      const previous = declarations.get(key);
      if (previous) {
        if (
          previous.owner !== owner ||
          JSON.stringify(previous.schema) !== JSON.stringify(schema)
        ) {
          throw new SettingsValidationError(
            `${key}: already declared with a different schema or owner`,
          );
        }
        return;
      }
      if (schema.writeOnly && schema.default !== undefined) {
        register([String(schema.default)]);
      }
      const ready = store.state.markDeclared(key, schema.writeOnly).then(
        async () => {
          if (schema.writeOnly) {
            register([(await store.state.get(key)) ?? undefined]);
          }
        },
      );
      // Persistence failures remain observable on subsequent operations, not unhandled tasks.
      void ready.catch(() => {});
      declarations.set(key, { schema, owner, ready });
    },
    async describe() {
      await ready();
      const stored = new Map(
        (await store.state.snapshot()).map((row) => [row.key, row]),
      );
      return [...declarations.keys()].map((key) =>
        describe(
          stored.get(key) ?? {
            key,
            value: null,
            revision: 0,
            writeOnly: false,
          },
        )
      ).sort((a, b) =>
        a.owner.localeCompare(b.owner) || a.key.localeCompare(b.key)
      );
    },
    async change(caller, input) {
      if ((await store.users.byId(caller))?.role !== 'admin') {
        throw new UserError('forbidden');
      }
      if (!Array.isArray(input)) {
        throw new SettingsError('invalid_value', 'changes must be an array');
      }
      const keys = new Set<string>();
      const changes: StateChange[] = input.map((item) => {
        if (
          !item || typeof item !== 'object' || Array.isArray(item) ||
          typeof item.key !== 'string'
        ) {
          throw new SettingsError(
            'invalid_value',
            'Each change must name a key',
          );
        }
        const { key } = item;
        const declaration = declarations.get(key);
        if (!declaration) {
          throw new SettingsError('unknown_setting', 'Unknown setting', key);
        }
        const invalid = (message: string): never => {
          throw new SettingsError('invalid_value', message, key);
        };
        if (keys.has(key)) invalid('Duplicate setting');
        keys.add(key);
        if (
          Object.keys(item).some((k) =>
            !['key', 'value', 'reset', 'revision'].includes(k)
          )
        ) invalid('Unknown change field');
        if (
          item.revision !== undefined &&
          (!Number.isSafeInteger(item.revision) || item.revision < 0)
        ) invalid('revision must be a non-negative safe integer');
        if (
          ('reset' in item)
            ? item.reset !== true || 'value' in item
            : !('value' in item)
        ) invalid('Specify value or reset: true');
        let value: string | null = null;
        if (!('reset' in item)) {
          try {
            value = encodeSetting(declaration.schema, item.value);
          } catch (error) {
            if (error instanceof SettingsValidationError) {
              invalid(error.message);
            }
            throw error;
          }
        }
        return {
          key,
          value,
          revision: item.revision,
          writeOnly: declaration.schema.writeOnly === true,
        };
      });
      await ready();
      const stored = new Map(
        (await store.state.snapshot()).map((row) => [row.key, row]),
      );
      for (const change of changes) {
        change.writeOnly ||= stored.get(change.key)?.writeOnly === true;
      }
      // Register before store/notification work, including rejected races: diagnostics
      // must never echo a submitted secret even when the write does not commit.
      register(
        changes.filter((c) => c.writeOnly).map((c) => c.value ?? undefined),
      );
      const rows = await store.state.change(caller, changes);
      announce(changes, rows);
      return rows.map(describe);
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
      await boot;
      await declaration?.ready;
      const secret = declaration?.schema.writeOnly === true ||
        (await store.state.snapshot()).some((r) =>
          r.key === key && r.writeOnly
        );
      if (secret) register([value]);
      await store.state.set(key, value, {
        ...options,
        declared: declaration !== undefined,
        writeOnly: secret,
      });
      emit(key, secret ? '' : value);
      notify?.emit(['settings'], { settings: [key] }, 'admins');
    },

    async seedIfUnset(key, value) {
      const declaration = validate(key, value);
      await boot;
      await declaration?.ready;
      const secret = declaration?.schema.writeOnly === true ||
        (await store.state.snapshot()).some((r) =>
          r.key === key && r.writeOnly
        );
      if (secret) register([value]);
      if (
        !await store.state.seedIfUnset(
          key,
          value,
          declaration !== undefined,
          secret,
        )
      ) return false;
      emit(key, secret ? '' : value);
      notify?.emit(['settings'], { settings: [key] }, 'admins');
      return true;
    },

    async list() {
      await ready();
      const values: Record<string, string | { isSet: boolean }> = await store
        .state.list([...declarations.keys()]);
      const rows = new Map(
        (await store.state.snapshot()).map((row) => [row.key, row]),
      );
      for (const [key, declaration] of declarations) {
        const row = rows.get(key);
        if (declaration.schema.writeOnly || row?.writeOnly) {
          values[key] = {
            isSet: row?.value != null ||
              declaration.schema.default !== undefined,
          };
        }
      }
      return values;
    },

    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
