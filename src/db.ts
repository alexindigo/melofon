// src/db.ts — one DuckDB file, in-process, migrated from src/schema.sql.
// The file lives at <dataDir>/melofon.duckdb; opening is allowed to fail
// startup (main.ts lets the error propagate).
import * as duckdb from '@duckdb/node-api';
import { type Log, scopedLog } from './logging.ts';

export interface Db {
  conn: duckdb.DuckDBConnection;
  close(): void;
}

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

export async function openDb(
  dataDir: string,
  opts: { debugLogQueries?: boolean; log?: Log } = {},
): Promise<Db> {
  await Deno.mkdir(dataDir, { recursive: true });
  const instance = await duckdb.DuckDBInstance.create(
    `${dataDir}/melofon.duckdb`,
  );
  const conn = await instance.connect();
  if (opts.debugLogQueries === true) instrumentConn(conn, opts.log);
  const schema = new URL('./schema.sql', import.meta.url);
  for (const statement of (await Deno.readTextFile(schema)).split(';')) {
    if (statement.trim() !== '') await conn.run(statement);
  }
  return {
    conn,
    close: () => conn.closeSync(),
  };
}
