import { atomic, type Engine, esc, type Queries } from './engine.ts';
import type { EntityType } from './candidates.ts';

export interface LookupInput {
  plugin: string;
  entityType: EntityType;
  entityId: string;
  factsHash: string;
  mode: 'missing' | 'all';
}
export interface LookupJob extends LookupInput {
  id: string;
  state: 'waiting' | 'active' | 'done' | 'failed';
  attempts: number;
  lastError: string | null;
  queuedAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  notBeforeMs: number;
}
export type LookupOutcome =
  | { state: 'done' }
  | { state: 'failed'; error: string }
  | {
    state: 'waiting';
    notBeforeMs: number;
    error?: string;
    countAttempt?: boolean;
  };

const projection =
  `id, plugin, entity_type AS entityType, entity_id AS entityId,
  facts_hash AS factsHash, mode, state, attempts, last_error AS lastError,
  epoch_ms(queued_at) AS queuedAtMs, epoch_ms(started_at) AS startedAtMs,
  epoch_ms(finished_at) AS finishedAtMs, epoch_ms(not_before) AS notBeforeMs`;

/** Store-internal composition: the queue remains the sole lookup_jobs writer. */
export async function enqueueLookups(
  q: Queries,
  jobs: LookupInput[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const job of jobs) {
    const match = `plugin = ${esc(job.plugin)} AND entity_type = ${
      esc(job.entityType)
    }
      AND entity_id = ${esc(job.entityId)} AND facts_hash = ${
      esc(job.factsHash)
    }`;
    const states = job.mode === 'all'
      ? "('waiting', 'active')"
      : "('waiting', 'active', 'done')";
    if (
      (await q.all(
        `SELECT 1 FROM lookup_jobs WHERE ${match} AND state IN ${states} LIMIT 1`,
      )).length
    ) continue;
    const id = crypto.randomUUID();
    await q.run(`INSERT INTO lookup_jobs
      (id, plugin, entity_type, entity_id, facts_hash, mode, state, queued_at, not_before)
      VALUES (${esc(id)}, ${esc(job.plugin)}, ${esc(job.entityType)}, ${
      esc(job.entityId)
    },
        ${esc(job.factsHash)}, ${esc(job.mode)}, 'waiting', now(), now())`);
    ids.push(id);
  }
  return ids;
}

export function createLookupsStore(engine: Engine) {
  return {
    enqueue(jobs: LookupInput[]): Promise<string[]> {
      return atomic(engine, (q) => enqueueLookups(q, jobs));
    },
    claimNext(plugin: string): Promise<LookupJob | null> {
      return atomic(engine, async (q) => {
        const rows = await q.all<{ id: string }>(`SELECT id FROM lookup_jobs
          WHERE plugin = ${
          esc(plugin)
        } AND state = 'waiting' AND not_before <= now()
          ORDER BY queued_at, seq LIMIT 1`);
        if (!rows.length) return null;
        const id = esc(rows[0].id);
        await q.run(
          `UPDATE lookup_jobs SET state = 'active', attempts = attempts + 1,
          started_at = now(), finished_at = NULL WHERE id = ${id}`,
        );
        return (await q.all<LookupJob>(
          `SELECT ${projection} FROM lookup_jobs WHERE id = ${id}`,
        ))[0];
      });
    },
    /** Only active jobs finish. Retry-later uses countAttempt=false (not a failed attempt). */
    finish(id: string, outcome: LookupOutcome): Promise<void> {
      return engine.exclusive((q) =>
        q.run(`UPDATE lookup_jobs SET state = ${esc(outcome.state)},
        last_error = ${
          'error' in outcome && outcome.error !== undefined
            ? esc(outcome.error)
            : 'NULL'
        },
        finished_at = ${outcome.state === 'waiting' ? 'NULL' : 'now()'},
        ${
          outcome.state === 'waiting'
            ? `not_before = to_timestamp(${outcome.notBeforeMs} / 1000.0),`
            : ''
        }
        attempts = attempts ${
          outcome.state === 'waiting' && outcome.countAttempt === false
            ? '- 1'
            : '+ 0'
        }
        WHERE id = ${esc(id)} AND state = 'active'`)
      );
    },
    resetActive(): Promise<void> {
      return engine.exclusive((q) =>
        q.run(`UPDATE lookup_jobs SET state = 'waiting',
        started_at = NULL, finished_at = NULL, not_before = now() WHERE state = 'active'`)
      );
    },
    /** Absolute cutoff in epoch milliseconds. Failed jobs are retained. */
    purgeDone(olderThanMs: number): Promise<void> {
      return engine.exclusive((q) =>
        q.run(`DELETE FROM lookup_jobs WHERE state = 'done'
        AND finished_at < to_timestamp(${olderThanMs} / 1000.0)`)
      );
    },
    stats(plugin: string): Promise<Record<LookupJob['state'], number>> {
      return engine.exclusive(async (q) => {
        const result = { waiting: 0, active: 0, done: 0, failed: 0 };
        for (
          const row of await q.all<{ state: LookupJob['state']; n: number }>(
            `SELECT state, count(*) AS n FROM lookup_jobs WHERE plugin = ${
              esc(plugin)
            } GROUP BY state`,
          )
        ) result[row.state] = row.n;
        return result;
      });
    },
  };
}
