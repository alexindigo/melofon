// tests/health.test.ts — in-process contract: facade over the real layers/ui
// tree serves GET /health only when context.app.db is open.
import { assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openDb } from '../src/db.ts';

Deno.test('GET /health returns {"ok":true} with a live DuckDB', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-health-' });
  const db = await openDb(dir);
  try {
    const app = await pathfinder({
      roots: ['layers/ui/'],
      app: { db, cfg: {} },
    });
    const res = await app(new Request('http://x/health'));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('GET /health is 500 without a db on context.app', async () => {
  const app = await pathfinder({
    roots: ['layers/ui/'],
    app: { db: null, cfg: {} },
  });
  const res = await app(new Request('http://x/health'));
  assertEquals(res.status, 500);
});
