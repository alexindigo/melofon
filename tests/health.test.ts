// tests/health.test.ts — in-process contract: the core tree serves /_/health
// only when context.app.db is open.
import { assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';

Deno.test('GET /health on the core tree returns {"ok":true} with a live DuckDB', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-health-' });
  const store = await openStore(dir);
  const db = store;
  try {
    const app = await pathfinder({ roots: ['core/'], app: { store, cfg: {} } });
    const res = await app(new Request('http://x/health'));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });
  } finally {
    await db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('GET /health on the core tree is 500 without a db on context.app', async () => {
  const app = await pathfinder({
    roots: ['core/'],
    app: { store: null, cfg: {} },
  });
  const res = await app(new Request('http://x/health'));
  assertEquals(res.status, 500);
});
