import { atomic, type Engine, esc, type Queries } from './engine.ts';

export interface StateValue {
  value: string | null;
  revision: number;
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
    get: (key: string) =>
      engine.exclusive(async (q) => (await read(q, key)).value),
    getWithRevision: (key: string) => engine.exclusive((q) => read(q, key)),
    markDeclared: (key: string) =>
      engine.exclusive((q) =>
        q.run(`UPDATE state SET declared = true WHERE key = ${esc(key)}`)
      ),
    set(
      key: string,
      value: string,
      options: { expectedRevision?: number; declared?: boolean } = {},
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
        await q.run(`INSERT INTO state (key, value, revision, declared)
          VALUES (${esc(key)}, ${esc(value)}, 1, ${options.declared === true})
          ON CONFLICT (key) DO UPDATE SET value = excluded.value,
          revision = state.revision + 1, declared = state.declared OR excluded.declared`);
      });
    },
    seedIfUnset(
      key: string,
      value: string,
      declared = false,
    ): Promise<boolean> {
      return atomic(engine, async (q) => {
        if ((await read(q, key)).value !== null) return false;
        await q.run(
          `INSERT INTO state (key, value, revision, declared) VALUES (${
            esc(key)
          }, ${esc(value)}, 1, ${declared})`,
        );
        return true;
      });
    },
    list(activeDeclarations: string[] = []): Promise<Record<string, string>> {
      return engine.exclusive(async (q) =>
        Object.fromEntries(
          (await q.all<{ key: string; value: string; declared: boolean }>(
            'SELECT key, value, declared FROM state ORDER BY key',
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
