// The single DuckDB owner. Public operations own an entire exclusive slot.
import * as duckdb from '@duckdb/node-api';
import { AsyncLocalStorage } from 'node:async_hooks';
import { type Log, scopedLog } from '../logging.ts';
import { upgradeCandidates } from './candidates.ts';
import { upgradeUsers } from './users.ts';
import { upgradeClientQueues } from './clientqueue.ts';
import { upgradeNowPlaying } from './nowplaying.ts';
import { migrate } from './migrations.ts';
import { initializeCatalogRevision } from './catalog-revision.ts';

// Debug spans behind MELOFON_DEBUG_LOG_REQUEST (plans/diag-request-trace):
// [db] begin/end for run + runAndReadAll — sql truncated to the verb plus
// the first identifier, never bind values, `qinflight` shows concurrent
// queries on the single connection, and a begin with qinflight>1 logs
// `overlap` (the stall the plan is hunting).

// Loose superset of the two wrapped method shapes (values/types args ride
// along untyped; the span never inspects them — never-log-bind-values).
type QueryFn = (sql: string, ...rest: unknown[]) => Promise<unknown>;

export function instrumentConn(
  conn: duckdb.DuckDBConnection,
  log: Log = scopedLog('db'),
): void {
  let qinflight = 0;
  const wrap = (fn: QueryFn): QueryFn => {
    return (sql, ...rest) => {
      qinflight++;
      if (qinflight > 1) log.event('db_overlap', { qinflight });
      log.event('db_begin', { sql, qinflight });
      const started = performance.now();
      return fn.apply(conn, [sql, ...rest]).finally(() => {
        qinflight--;
        const waitMs = Math.round(performance.now() - started);
        log.event('db_end', { sql, waitMs });
      });
    };
  };
  const asRun = conn.run.bind(conn) as unknown as QueryFn;
  const asReadAll = conn.runAndReadAll.bind(conn) as unknown as QueryFn;
  conn.run = wrap(asRun) as unknown as duckdb.DuckDBConnection['run'];
  conn.runAndReadAll = wrap(
    asReadAll,
  ) as unknown as duckdb.DuckDBConnection['runAndReadAll'];
}

export function esc(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export interface Queries {
  run(sql: string): Promise<void>;
  all<T = Record<string, unknown>>(sql: string): Promise<T[]>;
  rawAll<T = Record<string, unknown>>(sql: string): Promise<T[]>;
  prepare(sql: string): ReturnType<duckdb.DuckDBConnection['prepare']>;
}

export interface Engine {
  exclusive<T>(fn: (q: Queries) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

// The test seam resolves an engine without putting raw access on Store.
const engines = new WeakMap<object, Engine>();

export function registerStore(store: object, engine: Engine): void {
  engines.set(store, engine);
}

export function engineForTesting(store: object): Engine {
  const engine = engines.get(store);
  if (!engine) throw new Error('Unknown store');
  return engine;
}

function plain(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, plain(v)]),
    );
  }
  return value;
}

/** Multi-statement operations commit or roll back while holding one slot. */
export function atomic<T>(
  engine: Engine,
  fn: (q: Queries) => Promise<T>,
): Promise<T> {
  return engine.exclusive(async (q) => {
    await q.run('BEGIN TRANSACTION');
    try {
      const result = await fn(q);
      await q.run('COMMIT');
      return result;
    } catch (error) {
      await q.run('ROLLBACK');
      throw error;
    }
  });
}

export async function openEngine(
  dataDir: string,
  opts: { debugLogQueries?: boolean; log?: Log } = {},
): Promise<Engine> {
  await Deno.mkdir(dataDir, { recursive: true });
  const instance = await duckdb.DuckDBInstance.create(
    `${dataDir}/melofon.duckdb`,
  );
  let conn: duckdb.DuckDBConnection;
  try {
    conn = await instance.connect();
  } catch (error) {
    instance.closeSync();
    throw error;
  }
  // Bind to the unmodified connection: runAndReadAll internally calls this.run.
  // Instrument external entries only, not that driver-internal recursion.
  const queries = {
    run: conn.run.bind(conn),
    runAndReadAll: conn.runAndReadAll.bind(conn),
  };
  if (opts.debugLogQueries === true) {
    instrumentConn(queries as duckdb.DuckDBConnection, opts.log);
  }
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  let closing = false;
  let closed: Promise<void> | undefined;
  const slots = new AsyncLocalStorage<{ active: boolean }>();

  function exclusive<T>(fn: (q: Queries) => Promise<T>): Promise<T> {
    if (slots.getStore()?.active) {
      return Promise.reject(
        new Error('Nested store operation inside an exclusive slot'),
      );
    }
    if (closing) return Promise.reject(new Error('Store is closed'));
    pending++;
    const result = tail.then(() => {
      const slot = { active: true };
      const check = () => {
        if (!slot.active) {
          throw new Error('Store query used outside its exclusive slot');
        }
      };
      const q: Queries = {
        async run(sql) {
          check();
          await queries.run(sql);
        },
        async all<T>(sql: string): Promise<T[]> {
          check();
          const result = await queries.runAndReadAll(sql);
          return plain(result.getRowObjectsJS()) as T[];
        },
        async rawAll<T>(sql: string): Promise<T[]> {
          check();
          const result = await queries.runAndReadAll(sql);
          return result.getRowObjects() as T[];
        },
        prepare(sql) {
          check();
          return conn.prepare(sql);
        },
      };
      return slots.run(slot, async () => {
        try {
          return await fn(q);
        } finally {
          slot.active = false;
        }
      });
    }).finally(() => pending--);
    tail = result.catch(() => {});
    return result;
  }

  function closeNative(): void {
    try {
      conn.closeSync();
    } finally {
      instance.closeSync();
    }
  }

  function close(): Promise<void> {
    if (slots.getStore()?.active) {
      return Promise.reject(
        new Error('Cannot close store inside an exclusive slot'),
      );
    }
    if (!closed) {
      closing = true;
      if (pending === 0) {
        try {
          closeNative();
          closed = Promise.resolve();
        } catch (error) {
          closed = Promise.reject(error);
        }
      } else {
        closed = tail.then(closeNative);
      }
    }
    return closed;
  }

  const engine: Engine = {
    exclusive,
    ping: () => exclusive((q) => q.run('SELECT 1')),
    close,
  };
  try {
    // Read the file before acquiring the slot: no filesystem work in the queue.
    const schema = await Deno.readTextFile(
      new URL('./schema.sql', import.meta.url),
    );
    const conflicts = await exclusive(async (q) => {
      for (const statement of schema.split(';')) {
        if (statement.trim() !== '') await q.run(statement);
      }
      await upgradeCandidates(q, schema);
      await upgradeUsers(q);
      await upgradeClientQueues(q, schema);
      await upgradeNowPlaying(q);
      await initializeCatalogRevision(q);
      return await migrate(q);
    });
    for (const userId of conflicts) {
      (opts.log ?? scopedLog('db')).event('user_name_collision', { userId });
    }
  } catch (error) {
    await close();
    throw error;
  }
  return engine;
}
