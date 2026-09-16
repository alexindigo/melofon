// GET /_/health — the core infra probe: ok only if the DuckDB index is open
// on context.app.db. Core's tree is rooted at core/ and reached via the
// "no layer" force prefix /_/; it is never globbed as a layer.
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
