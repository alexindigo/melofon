import type { Queries } from './engine.ts';
import { seedShippedHats } from './hats.ts';

/** Run each release migration and its receipt in the same transaction. */
export async function migrate(q: Queries): Promise<void> {
  const migrations = [{ id: 'hats-001', apply: seedShippedHats }];
  for (const migration of migrations) {
    await q.run('BEGIN TRANSACTION');
    try {
      const applied = await q.all(
        `SELECT id FROM migrations WHERE id = '${migration.id}'`,
      );
      if (applied.length === 0) {
        await migration.apply(q);
        await q.run(`INSERT INTO migrations (id) VALUES ('${migration.id}')`);
      }
      await q.run('COMMIT');
    } catch (error) {
      await q.run('ROLLBACK');
      throw error;
    }
  }
}
