import { atomic, type Engine, esc, type Queries } from './engine.ts';
import { CONNECTION_STRATEGY_DEFAULT_KEY } from '../connection-strategy.ts';

async function get(q: Queries, key: string): Promise<string | null> {
  const rows = await q.all<{ value: string }>(
    `SELECT value FROM state WHERE key = ${esc(key)}`,
  );
  return rows[0]?.value ?? null;
}

export function createStateStore(engine: Engine) {
  return {
    get: (key: string) => engine.exclusive((q) => get(q, key)),
    set: (key: string, value: string): Promise<void> =>
      engine.exclusive((q) =>
        q.run(
          `INSERT OR REPLACE INTO state (key, value) VALUES (${esc(key)}, ${
            esc(value)
          })`,
        )
      ),
    seedIfUnset(key: string, value: string): Promise<boolean> {
      return atomic(engine, async (q) => {
        if (key === CONNECTION_STRATEGY_DEFAULT_KEY) {
          const rows = await q.all(
            `INSERT INTO state (key, value) VALUES (${esc(key)}, ${esc(value)})
           ON CONFLICT (key) DO NOTHING RETURNING value`,
          );
          return rows.length > 0;
        }
        if (await get(q, key) !== null) return false;
        await q.run(
          `INSERT INTO state (key, value) VALUES (${esc(key)}, ${esc(value)})`,
        );
        return true;
      });
    },
    list(): Promise<Record<string, string>> {
      return engine.exclusive(async (q) =>
        Object.fromEntries(
          (await q.all<{ key: string; value: string }>(
            'SELECT key, value FROM state ORDER BY key',
          )).map((r) => [r.key, r.value]),
        )
      );
    },
  };
}
