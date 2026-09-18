// tests/facade.test.ts — dispatch grammar: /_/ → core tree, /_<name>/ → that
// layer stripped, lookup pass-through on a hit, bare 404 from core on a miss.
// The fixture layer (tests/fixtures/layers/layer-a) is a real endpoint tree
// booted through loadLayers (no manifest → the layer dir itself is the one
// root): an empty tree is not representable (pathfinder rejects zero-file
// roots), so dispatch into a layer is proven by its own endpoint, never by a
// fake product route.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { facade } from '../src/facade.ts';
import { loadLayers } from '../src/layers.ts';
import { openDb } from '../src/db.ts';

async function makeApps() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-facade-' });
  const db = await openDb(dir);
  const app = { db, cfg: {} };
  const core = await pathfinder({ roots: ['core/'], app });
  const layers = await loadLayers({ app, layersRoot: 'tests/fixtures/layers' });
  const close = async () => {
    db.close();
    await Deno.remove(dir, { recursive: true });
  };
  return { core, layers, close };
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
    const res = await facade(core, layers)(
      new Request('http://x/_layer-a/echo'),
    );
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

Deno.test('/ answers 200 (client reachability probes; UI lands with M5)', async () => {
  const { core, layers, close } = await makeApps();
  try {
    const res = await facade(core, layers)(new Request('http://x/'));
    assertEquals(res.status, 200);
    assertEquals(
      res.headers.get('content-type'),
      'text/plain; charset=utf-8',
    );
    assertEquals(await res.text(), 'Hello World!\n');
  } finally {
    await close();
  }
});

Deno.test('request trace: accept+headers lines, redacted dump only with the extra flag', async () => {
  const { core, layers, close } = await makeApps();
  try {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (line: unknown) => {
      lines.push(String(line));
    };
    try {
      // Off by default.
      await facade(core, layers)(new Request('http://x/echo?c=test'));
      assertEquals(lines.length, 0);

      // With debugLogRequests: compact accept + headers, no header dump.
      await facade(core, layers, { debugLogRequests: true })(
        new Request('http://x/echo?c=test&u=admin&p=hunter2&apiKey=sekrit', {
          headers: {
            'user-agent': 'facade-test',
            cookie: 'session=abc123',
            'x-api-key': 'alsosomething',
          },
        }),
      );
      assertEquals(lines.length, 2);
      assert(lines[0].includes('accept req=1 inflight=1 GET /echo'));
      assert(lines[0].includes('peer='));
      assert(lines[1].includes('headers req=1'));
      assert(lines[1].includes('-> 200'));
      assert(lines[1].includes('waitMs='));
      // No info.completed in this call → done is skipped.
      for (const line of lines) {
        assert(!line.includes('user-agent'));
        assert(!line.includes('cookie'));
        assert(!line.includes('hunter2'));
        assert(!line.includes('sekrit'));
        assert(!line.includes('abc123'));
        assert(!line.includes('alsosomething'));
      }

      // With the extra flag the dump rides the accept line — redacted.
      lines.length = 0;
      await facade(core, layers, {
        debugLogRequests: true,
        debugLogHeaders: true,
      })(
        new Request('http://x/echo?c=test&u=admin&p=hunter2&apiKey=sekrit', {
          headers: {
            'user-agent': 'facade-test',
            cookie: 'session=abc123',
            'x-api-key': 'alsosomething',
          },
        }),
      );
      assertEquals(lines.length, 2);
      assert(lines[0].includes('accept req=1'));
      assert(lines[0].includes('c=test'));
      assert(lines[0].includes('user-agent: facade-test'));
      assert(lines[0].includes('u=•••'));
      assert(lines[0].includes('p=•••'));
      assert(lines[0].includes('apiKey=•••'));
      assert(!lines[0].includes('hunter2'));
      assert(!lines[0].includes('sekrit'));
      assert(!lines[0].includes('abc123'));
      assert(!lines[0].includes('alsosomething'));
    } finally {
      console.log = orig;
    }
  } finally {
    await close();
  }
});

Deno.test('request trace: done logs when info.completed settles', async () => {
  const { core, layers, close } = await makeApps();
  try {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (line: unknown) => {
      lines.push(String(line));
    };
    try {
      let complete!: () => void;
      const info = { completed: new Promise<void>((r) => (complete = r)) };
      const res = await facade(core, layers, { debugLogRequests: true })(
        new Request('http://x/echo'),
        info,
      );
      assertEquals(res.status, 200);
      assertEquals(lines.length, 2); // accept + headers; done pending
      complete();
      await info.completed;
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertEquals(lines.length, 3);
      assert(lines[2].includes('done req=1'));
      assert(lines[2].includes('bodyMs='));
      assert(!lines[2].includes('aborted'));
    } finally {
      console.log = orig;
    }
  } finally {
    await close();
  }
});
