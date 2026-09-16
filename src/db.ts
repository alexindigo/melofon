// src/db.ts — one DuckDB file, in-process, migrated from src/schema.sql.
// The file lives at <dataDir>/melofon.duckdb; opening is allowed to fail
// startup (main.ts lets the error propagate).
import * as duckdb from '@duckdb/node-api';

export interface Db {
  conn: duckdb.DuckDBConnection;
  close(): void;
}

export async function openDb(dataDir: string): Promise<Db> {
  await Deno.mkdir(dataDir, { recursive: true });
  const instance = await duckdb.DuckDBInstance.create(
    `${dataDir}/melofon.duckdb`,
  );
  const conn = await instance.connect();
  const schema = new URL('./schema.sql', import.meta.url);
  for (const statement of (await Deno.readTextFile(schema)).split(';')) {
    if (statement.trim() !== '') await conn.run(statement);
  }
  return {
    conn,
    close: () => conn.closeSync(),
  };
}
