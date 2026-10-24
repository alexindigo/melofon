// Per-user policy and JSON projection. Storage and the quota check share one
// atomic store operation; events are emitted only after it commits.
import type { Store } from './store/index.ts';
import type { State } from './state.ts';
import type { Notify } from './notify.ts';
import {
  encodeSetting,
  type SettingsSchema,
  SettingsValidationError,
} from './settings-schema.ts';
import { PreferenceError } from './preference-errors.ts';
import type { PreferenceRow } from './store/preferences.ts';

const SCHEMAS: Record<string, SettingsSchema> = {
  theme: {
    type: 'string',
    enum: ['system', 'light', 'dark'],
    default: 'system',
  },
  language: {
    type: 'string',
    maxLength: 35,
    pattern: '^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$',
  },
  viewMode: { type: 'string', enum: ['list', 'grid'], default: 'grid' },
  defaultView: { type: 'string', maxLength: 64 },
  replayGainMode: {
    type: 'string',
    enum: ['off', 'track', 'album'],
    default: 'off',
  },
  volume: { type: 'integer', minimum: 0, maximum: 100 },
};
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function invalid(message: string, key?: string): never {
  throw new PreferenceError('invalid_value', message, key);
}
function jsonValue(value: unknown): boolean {
  if (
    value === null || typeof value === 'string' || typeof value === 'boolean'
  ) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  return object(value) && Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every(jsonValue);
}
function snapshot(rows: PreferenceRow[]) {
  const defaults = Object.fromEntries(
    Object.entries(SCHEMAS).map((
      [key, schema],
    ) => [key, schema.default ?? null]),
  );
  const preferences: Record<string, unknown> = { ...defaults };
  const revisions: Record<string, number> = Object.fromEntries(
    Object.keys(SCHEMAS).map((key) => [key, 0]),
  );
  for (const row of rows) {
    revisions[row.key] = row.revision;
    if (row.value !== null) preferences[row.key] = JSON.parse(row.value);
  }
  return { preferences, revisions, defaults };
}

export function createPreferences(store: Store, state: State, notify: Notify) {
  state.declare('preferences.uiMaxBytes', {
    type: 'integer',
    minimum: 2,
    maximum: 65536,
    default: 65536,
    description:
      'Maximum serialized UTF-8 bytes in one user’s ui.* preferences',
  });
  return Object.freeze({
    async get(userId: string) {
      return snapshot(await store.preferences.get(userId));
    },
    async change(userId: string, preferences: unknown, revisions?: unknown) {
      if (!object(preferences)) invalid('preferences must be an object');
      if (revisions !== undefined && !object(revisions)) {
        invalid('revisions must be an object');
      }
      const expected = (revisions ?? {}) as Record<string, unknown>;
      for (const [key, revision] of Object.entries(expected)) {
        if (
          !Object.hasOwn(preferences, key) || !Number.isSafeInteger(revision) ||
          (revision as number) < 0
        ) {
          invalid(
            'revision must be a non-negative safe integer for a changed key',
            key,
          );
        }
      }
      const changes = Object.entries(preferences).map(([key, value]) => {
        const schema = Object.hasOwn(SCHEMAS, key) ? SCHEMAS[key] : undefined;
        if (!schema && !/^ui\.[A-Za-z0-9_.-]{1,64}$/.test(key)) {
          throw new PreferenceError(
            'unknown_preference',
            'Unknown preference',
            key,
          );
        }
        try {
          if (value !== null) {
            if (schema) encodeSetting(schema, value);
            else if (!jsonValue(value)) invalid('must be a JSON value', key);
          }
          return {
            key,
            value: value === null ? null : JSON.stringify(value),
            revision: expected[key] as number | undefined,
          };
        } catch (error) {
          if (
            error instanceof SettingsValidationError ||
            error instanceof RangeError || error instanceof TypeError
          ) {
            invalid(
              error instanceof SettingsValidationError
                ? error.message
                : 'must be a JSON value',
              key,
            );
          }
          throw error;
        }
      });
      const maxBytes = Number(await state.getTyped('preferences.uiMaxBytes'));
      const rows = await store.preferences.change(userId, changes, maxBytes);
      if (changes.length) {
        notify.emit(
          ['preferences'],
          { preferences: changes.map((c) => c.key) },
          { userId },
        );
      }
      return snapshot(rows);
    },
  });
}
