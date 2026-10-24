import { atomic, type Engine, esc, type Queries } from './engine.ts';
import { requireCaller } from './users.ts';
import { SettingsError } from '../settings-errors.ts';

export interface StateValue {
  value: string | null;
  revision: number;
}
export interface StoredSetting extends StateValue {
  key: string;
  writeOnly: boolean;
}
export interface StateChange {
  key: string;
  value: string | null;
  revision?: number;
  writeOnly: boolean;
}

/** A null value is a reset tombstone; keep revision and declaration metadata. */
export async function migrateSettings(q: Queries): Promise<void> {
  await q.run('ALTER TABLE state RENAME TO state_before_settings');
  await q.run(`CREATE TABLE state (
    key VARCHAR PRIMARY KEY, value VARCHAR, revision BIGINT DEFAULT 0,
    declared BOOLEAN DEFAULT false, write_only BOOLEAN DEFAULT false)`);
  await q.run(`INSERT INTO state (key, value, revision, declared)
    SELECT key, value, revision, declared FROM state_before_settings`);
  await q.run('DROP TABLE state_before_settings');
}

async function write(q: Queries, change: StateChange, declared = true) {
  await q.run(`INSERT INTO state (key, value, revision, declared, write_only)
    VALUES (${esc(change.key)}, ${
    change.value === null ? 'NULL' : esc(change.value)
  }, 1, ${declared}, ${change.writeOnly})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value,
    revision = state.revision + 1, declared = state.declared OR excluded.declared,
    write_only = state.write_only OR excluded.write_only`);
}
export class StateRevisionError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`stale setting revision: expected ${expected}, current ${actual}`);
    this.name = 'StateRevisionError';
  }
}
async function read(q: Queries, key: string): Promise<StateValue> {
  const rows = await q.all<{ value: string; revision: number }>(
    `SELECT value, revision FROM state WHERE key = ${esc(key)}`,
  );
  return {
    value: rows[0]?.value ?? null,
    revision: Number(rows[0]?.revision ?? 0),
  };
}

export function createStateStore(engine: Engine) {
  return {
    snapshot: (): Promise<StoredSetting[]> =>
      engine.exclusive(async (q) =>
        (await q.all<
          {
            key: string;
            value: string | null;
            revision: number;
            writeOnly: boolean;
          }
        >(
          'SELECT key, value, revision, write_only AS writeOnly FROM state ORDER BY key',
        )).map((row) => ({ ...row, revision: Number(row.revision) }))
      ),
    change: (
      caller: string,
      changes: StateChange[],
    ): Promise<StoredSetting[]> =>
      atomic(engine, async (q) => {
        await requireCaller(q, caller);
        const revisions: Record<string, number> = {};
        let conflict = false;
        for (const change of changes) {
          const current = await read(q, change.key);
          revisions[change.key] = current.revision;
          if (
            change.revision !== undefined &&
            change.revision !== current.revision
          ) conflict = true;
        }
        if (conflict) {
          throw new SettingsError(
            'revision_conflict',
            'Stale setting revision',
            undefined,
            revisions,
          );
        }
        const result: StoredSetting[] = [];
        for (const change of changes) {
          await write(q, change);
          const row = (await q.all<{ writeOnly: boolean }>(
            `SELECT write_only AS writeOnly FROM state WHERE key = ${
              esc(change.key)
            }`,
          ))[0];
          result.push({
            key: change.key,
            value: change.value,
            revision: revisions[change.key] + 1,
            writeOnly: row.writeOnly,
          });
        }
        return result;
      }),
    get: (key: string) =>
      engine.exclusive(async (q) => (await read(q, key)).value),
    getWithRevision: (key: string) => engine.exclusive((q) => read(q, key)),
    markDeclared: (key: string, writeOnly = false) =>
      engine.exclusive((q) =>
        q.run(
          `UPDATE state SET declared = true, write_only = write_only OR ${writeOnly} WHERE key = ${
            esc(key)
          }`,
        )
      ),
    set(
      key: string,
      value: string,
      options: {
        expectedRevision?: number;
        declared?: boolean;
        writeOnly?: boolean;
      } = {},
    ): Promise<void> {
      return atomic(engine, async (q) => {
        if (options.expectedRevision !== undefined) {
          if (
            !Number.isSafeInteger(options.expectedRevision) ||
            options.expectedRevision < 0
          ) {
            throw new Error(
              'expectedRevision must be a non-negative safe integer',
            );
          }
          const current = await read(q, key);
          if (current.revision !== options.expectedRevision) {
            throw new StateRevisionError(
              options.expectedRevision,
              current.revision,
            );
          }
        }
        await write(
          q,
          { key, value, writeOnly: options.writeOnly === true },
          options.declared === true,
        );
      });
    },
    seedIfUnset(
      key: string,
      value: string,
      declared = false,
      writeOnly = false,
    ): Promise<boolean> {
      return atomic(engine, async (q) => {
        const current = await read(q, key);
        if (current.value !== null || current.revision !== 0) return false;
        await write(q, { key, value, writeOnly }, declared);
        return true;
      });
    },
    list(activeDeclarations: string[] = []): Promise<Record<string, string>> {
      return engine.exclusive(async (q) =>
        Object.fromEntries(
          (await q.all<{ key: string; value: string; declared: boolean }>(
            'SELECT key, value, declared FROM state WHERE value IS NOT NULL AND NOT write_only ORDER BY key',
          ))
            .filter((row) =>
              !row.declared || activeDeclarations.includes(row.key)
            )
            .map((row) => [row.key, row.value]),
        )
      );
    },
  };
}
