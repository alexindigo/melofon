import type { Queries } from './engine.ts';
import { seedMelofonHat, seedShippedHats } from './hats.ts';
import { migrateUserNames } from './users.ts';
import { migrateSettings } from './state.ts';
import { migrateAdoptedSpeakers } from './speakers.ts';
import { migrateQueueReferences } from './playback.ts';

/** Run each release migration and its receipt in the same transaction. */
export async function migrate(q: Queries): Promise<string[]> {
  const conflicts: string[] = [];
  const migrations = [{ id: 'hats-001', apply: seedShippedHats }, {
    id: 'users-001',
    apply: migrateUserNames,
  }, {
    id: 'hats-002',
    apply: seedMelofonHat,
  }, {
    id: 'settings-001',
    apply: migrateSettings,
  }, {
    id: 'speakers-001',
    apply: migrateAdoptedSpeakers,
  }, {
    id: 'server-queue-001',
    apply: migrateQueueReferences,
  }];
  for (const migration of migrations) {
    await q.run('BEGIN TRANSACTION');
    try {
      const applied = await q.all(
        `SELECT id FROM migrations WHERE id = '${migration.id}'`,
      );
      if (applied.length === 0) {
        const result = await migration.apply(q);
        if (result) conflicts.push(...result);
        await q.run(`INSERT INTO migrations (id) VALUES ('${migration.id}')`);
      }
      await q.run('COMMIT');
    } catch (error) {
      await q.run('ROLLBACK');
      throw error;
    }
  }
  return conflicts;
}
