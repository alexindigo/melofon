// GET /health — the M0 floor: ok only if the DuckDB index is open on this
// layer's context.app.db. Distinct from pathfinder's Layer 0
// /_status/health, which is router liveness and knows nothing about DuckDB.
export default async function (
  _request: unknown,
  context: {
    app: { db?: { conn: { runAndReadAll(sql: string): Promise<unknown> } } };
  },
) {
  if (!context.app.db) throw new Error('db not open');
  await context.app.db.conn.runAndReadAll('SELECT 1');
  return { ok: true };
}
