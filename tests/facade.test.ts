// tests/facade.test.ts — dispatch grammar: /_/ → core tree, /_<name>/ → that
// layer stripped, lookup pass-through on a hit, bare 404 from core on a miss.
// The fixture layer (tests/fixtures/layer-a) is a real endpoint tree: an
// empty tree is not representable (pathfinder rejects zero-file roots), so
// dispatch into a layer is proven by its own endpoint, never by a fake
// product route.
import { assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { facade } from '../src/facade.ts';
import { openDb } from '../src/db.ts';

async function makeApps() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-facade-' });
  const db = await openDb(dir);
  const app = { db, cfg: {} };
  const core = await pathfinder({ roots: ['core/'], app });
  const layerA = {
    name: 'a',
    app: await pathfinder({ roots: ['tests/fixtures/layer-a/'], app }),
    port: undefined,
    headers: [],
    dir: 'tests/fixtures/layer-a',
  };
  const close = async () => {
    db.close();
    await Deno.remove(dir, { recursive: true });
  };
  return { core, layers: [layerA], close };
}

Deno.test('/_/health routes to the core tree', async () => {
  const { core, layers, close } = await makeApps();
  try {
    const res = await facade(core, layers)(new Request('http://x/_/health'));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });
  } finally {
    await close();
  }
});

Deno.test('/_<name>/ strips the prefix and dispatches into the layer', async () => {
  const { core, layers, close } = await makeApps();
  try {
    const res = await facade(core, layers)(new Request('http://x/_a/echo'));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { layer: 'a', route: '/echo' });
  } finally {
    await close();
  }
});

Deno.test('lookup pass-through: one hit → that layer', async () => {
  const { core, layers, close } = await makeApps();
  try {
    const res = await facade(core, layers)(new Request('http://x/echo'));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { layer: 'a', route: '/echo' });
  } finally {
    await close();
  }
});

Deno.test('lookup miss → bare 404 from core (no default-layer backstop)', async () => {
  const { core, layers, close } = await makeApps();
  try {
    const res = await facade(core, layers)(new Request('http://x/nope'));
    assertEquals(res.status, 404);
    assertEquals(await res.json(), { detail: 'Not Found' });
  } finally {
    await close();
  }
});

Deno.test('/_/ answers the core tree even when no layers exist', async () => {
  const { core, close } = await makeApps();
  try {
    const res = await facade(core, [])(new Request('http://x/_/health'));
    assertEquals(res.status, 200);
    const miss = await facade(core, [])(new Request('http://x/anything'));
    assertEquals(miss.status, 404);
  } finally {
    await close();
  }
});
