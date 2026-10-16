// GET /_/health — the core infra probe: ok only if the DuckDB index is open
// on context.app.store. Core's tree is rooted at core/ and reached via the
// "no layer" force prefix /_/; it is never globbed as a layer.
export default async function (
  _request: unknown,
  context: {
    app: { store?: { ping(): Promise<void> } };
  },
) {
  if (!context.app.store) throw new Error('store not open');
  await context.app.store.ping();
  return { ok: true };
}
