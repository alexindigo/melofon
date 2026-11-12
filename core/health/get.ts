// GET /_/health — the core infra probe: the DuckDB index must be open and
// published writes must not be stuck unsaved. Core's tree is rooted at core/
// and reached via the "no layer" force prefix /_/; it is never globbed as a layer.
export default async function (
  _request: unknown,
  context: {
    app: {
      store?: { ping(): Promise<void> };
      persistence?: { health(): { pendingWrites: number } };
    };
  },
) {
  if (!context.app.store) throw new Error('store not open');
  await context.app.store.ping();
  const persistence = context.app.persistence?.health();
  if (persistence?.pendingWrites) {
    return Response.json({ ok: false, persistence }, { status: 503 });
  }
  return { ok: true };
}
