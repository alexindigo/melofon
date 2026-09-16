// tests/facade.test.ts — dispatch rules with one layer: lookup pass-through,
// unknown paths answered by the default layer, force prefix strips, /_status
// pins to the default layer (masked 404 in-process: Layer 0 loopback guard).
import { assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { facade } from '../src/facade.ts';
import { openDb } from '../src/db.ts';

async function makeUiLayer() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-facade-' });
  const db = await openDb(dir);
  const app = await pathfinder({ roots: ['layers/ui/'], app: { db, cfg: {} } });
  const close = async () => {
    db.close();
    await Deno.remove(dir, { recursive: true });
  };
  return {
    layer: { name: 'ui', app, port: undefined, headers: [], dir: 'layers/ui' },
    close,
  };
}

Deno.test('facade passes /health through to the ui layer', async () => {
  const { layer, close } = await makeUiLayer();
  try {
    const res = await facade([layer])(new Request('http://x/health'));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });
  } finally {
    await close();
  }
});

Deno.test('facade force prefix /_ui strips and dispatches', async () => {
  const { layer, close } = await makeUiLayer();
  try {
    const res = await facade([layer])(new Request('http://x/_ui/health'));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });
  } finally {
    await close();
  }
});

Deno.test('facade answers unknown paths with the default layer 404', async () => {
  const { layer, close } = await makeUiLayer();
  try {
    const res = await facade([layer])(new Request('http://x/nope'));
    assertEquals(res.status, 404);
  } finally {
    await close();
  }
});

Deno.test('facade pins /_status to the default layer (masked 404 in-process)', async () => {
  const { layer, close } = await makeUiLayer();
  try {
    // In-process requests carry no remoteAddr, so pathfinder's Layer 0
    // loopback guard fails closed: 404. The pin itself is what M0 proves.
    const res = await facade([layer])(new Request('http://x/_status/health'));
    assertEquals(res.status, 404);
  } finally {
    await close();
  }
});
