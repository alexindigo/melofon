import { atomic, type Engine, esc, type Queries } from './engine.ts';
import { requireCaller } from './users.ts';
import { PreferenceError } from '../preference-errors.ts';

export interface PreferenceRow {
  key: string;
  value: string | null;
  revision: number;
}
interface PreferenceChange {
  key: string;
  value: string | null;
  revision?: number;
}
async function read(q: Queries, userId: string): Promise<PreferenceRow[]> {
  return (await q.all<PreferenceRow>(
    `SELECT key, value, revision FROM user_preferences
    WHERE user_id = ${esc(userId)} ORDER BY key`,
  )).map((row) => ({ ...row, revision: Number(row.revision) }));
}
export function createPreferencesStore(engine: Engine) {
  return {
    get: (userId: string) =>
      engine.exclusive(async (q) => {
        await requireCaller(q, userId, userId);
        return read(q, userId);
      }),
    change: (userId: string, changes: PreferenceChange[], maxBytes: number) =>
      atomic(engine, async (q) => {
        await requireCaller(q, userId, userId);
        const rows = await read(q, userId);
        const current = new Map(rows.map((row) => [row.key, row]));
        const revisions = Object.fromEntries(
          changes.map(({ key }) => [key, current.get(key)?.revision ?? 0]),
        );
        if (
          changes.some((c) =>
            c.revision !== undefined && c.revision !== revisions[c.key]
          )
        ) {
          throw new PreferenceError(
            'revision_conflict',
            'Stale preference revision',
            undefined,
            revisions,
          );
        }
        const next = new Map(rows.map((row) => [row.key, row.value]));
        for (const c of changes) next.set(c.key, c.value);
        // Count the exact serialized UI object without decoding stored JSON inside
        // the store slot. UI keys are ASCII; values are already JSON text.
        const entries = [...next].filter(([key, value]) =>
          key.startsWith('ui.') && value !== null
        );
        const encoder = new TextEncoder();
        const bytes = 2 + Math.max(0, entries.length - 1) +
          entries.reduce(
            (n, [key, value]) =>
              n + encoder.encode(`"${key}":${value}`).byteLength,
            0,
          );
        if (bytes > maxBytes) {
          throw new PreferenceError(
            'too_large',
            'UI preferences are too large',
          );
        }
        for (const c of changes) {
          // A SQL NULL tombstone removes the value, retaining monotone revisions
          // so a pre-reset device cannot revive a stale value (the ABA problem).
          await q.run(
            `INSERT INTO user_preferences (user_id, key, value, revision, updated_at)
          VALUES (${esc(userId)}, ${esc(c.key)}, ${
              c.value === null ? 'NULL' : esc(c.value)
            }, 1, now())
          ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value,
          revision = user_preferences.revision + 1, updated_at = excluded.updated_at`,
          );
        }
        return read(q, userId);
      }),
  };
}
