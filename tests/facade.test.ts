// tests/facade.test.ts — dispatch grammar: /_/ → core tree, /_<name>/ → that
// layer stripped, lookup pass-through on a hit, bare 404 from core on a miss.
// The fixture layers (tests/fixtures/layers/) are real endpoint trees booted
// through loadLayers: layer-a is unported (default listen); layer-p and
// layer-q share the 3689 claim mounted at /alpha and /beta; layer-two claims
// [3689, 3688] at /ws-hook. An empty tree is not representable (pathfinder
// rejects zero-file roots), so dispatch into a layer is proven by its own
// endpoint, never by a fake product route.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { facade } from '../src/facade.ts';
import { loadLayers } from '../src/layers.ts';
import { openStore } from '../src/store/index.ts';
import { captureLogs, parseLogfmt } from './helpers/logging.ts';
import type { Layer } from '../src/layers.ts';

async function makeApps() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-facade-' });
  const store = await openStore(dir);
  const db = store;
  const app = { store, cfg: {} };
  const core = await pathfinder({ roots: ['core/'], app });
  const layers = await loadLayers({ app, layersRoot: 'tests/fixtures/layers' });
  const close = async () => {
    await db.close();
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

Deno.test('bind filter: unported /echo on the default facade, 404 on an extra bind', async () => {
  const { core, layers, close } = await makeApps();
  try {
    const res = await facade(core, layers)(new Request('http://x/echo'));
    assertEquals(res.status, 200);
    const extra = facade(core, layers, {
      listenPort: 3689,
      defaultPort: 4534,
    });
    assertEquals((await extra(new Request('http://x/echo'))).status, 404);
  } finally {
    await close();
  }
});

Deno.test('default facade does not serve ported hats', async () => {
  const { core, layers, close } = await makeApps();
  try {
    const def = facade(core, layers);
    assertEquals((await def(new Request('http://x/alpha'))).status, 404);
    assertEquals((await def(new Request('http://x/beta'))).status, 404);
    assertEquals((await def(new Request('http://x/ws-hook'))).status, 404);
    assertEquals(
      (await def(new Request('http://x/_layer-p/alpha'))).status,
      404,
    );
  } finally {
    await close();
  }
});

Deno.test('shared extra bind: /alpha and /beta split by path on 3689 (claimed as-is)', async () => {
  const { core, layers, close } = await makeApps();
  try {
    const extra = facade(core, layers, {
      listenPort: 3689,
      defaultPort: 4534,
    });
    const alpha = await extra(new Request('http://x/alpha'));
    assertEquals(alpha.status, 200);
    assertEquals(await alpha.json(), { layer: 'p', route: '/alpha' });
    const beta = await extra(new Request('http://x/beta'));
    assertEquals(beta.status, 200);
    assertEquals(await beta.json(), { layer: 'q', route: '/beta' });
    // Force prefix works for candidates on the extra bind…
    const forced = await extra(new Request('http://x/_layer-p/alpha'));
    assertEquals(forced.status, 200);
    assertEquals(await forced.json(), { layer: 'p', route: '/alpha' });
    // …but not for a layer that is not a candidate on this bind.
    assertEquals(
      (await extra(new Request('http://x/_layer-a/echo'))).status,
      404,
    );
  } finally {
    await close();
  }
});

Deno.test('extra bind: a two-claim layer answers on each claimed port', async () => {
  const { core, layers, close } = await makeApps();
  try {
    for (const listenPort of [3689, 3688]) {
      const app = facade(core, layers, { listenPort, defaultPort: 4534 });
      const res = await app(new Request('http://x/ws-hook'));
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { layer: 'two', route: '/ws-hook' });
    }
  } finally {
    await close();
  }
});

Deno.test('REPLACE_ moves the shared claim: hats answer on 4000, not 3689', async () => {
  const { core, layers, close } = await makeApps();
  try {
    const env = { MELOFON_LISTEN_REPLACE_3689: '4000' };
    const moved = facade(core, layers, {
      listenPort: 4000,
      defaultPort: 4534,
      env,
    });
    assertEquals((await moved(new Request('http://x/alpha'))).status, 200);
    assertEquals((await moved(new Request('http://x/beta'))).status, 200);
    const quiet = facade(core, layers, {
      listenPort: 3689,
      defaultPort: 4534,
      env,
    });
    assertEquals((await quiet(new Request('http://x/alpha'))).status, 404);
    assertEquals((await quiet(new Request('http://x/beta'))).status, 404);
  } finally {
    await close();
  }
});

Deno.test('per-layer listen env peels one hat off the shared claim', async () => {
  const { core, layers, close } = await makeApps();
  try {
    const env = { 'MELOFON_LISTEN_layer-p': '3690' };
    const own = facade(core, layers, {
      listenPort: 3690,
      defaultPort: 4534,
      env,
    });
    const alpha = await own(new Request('http://x/alpha'));
    assertEquals(alpha.status, 200);
    assertEquals(await alpha.json(), { layer: 'p', route: '/alpha' });
    assertEquals((await own(new Request('http://x/beta'))).status, 404);
    const shared = facade(core, layers, {
      listenPort: 3689,
      defaultPort: 4534,
      env,
    });
    assertEquals((await shared(new Request('http://x/beta'))).status, 200);
    assertEquals((await shared(new Request('http://x/alpha'))).status, 404);
  } finally {
    await close();
  }
});

Deno.test('per-layer listen env wins over REPLACE_ for that hat', async () => {
  const { core, layers, close } = await makeApps();
  try {
    const env = {
      MELOFON_LISTEN_REPLACE_3689: '4000',
      'MELOFON_LISTEN_layer-p': '3690',
    };
    const own = facade(core, layers, {
      listenPort: 3690,
      defaultPort: 4534,
      env,
    });
    assertEquals((await own(new Request('http://x/alpha'))).status, 200);
    const shared = facade(core, layers, {
      listenPort: 4000,
      defaultPort: 4534,
      env,
    });
    assertEquals((await shared(new Request('http://x/beta'))).status, 200);
    assertEquals((await shared(new Request('http://x/alpha'))).status, 404);
  } finally {
    await close();
  }
});

Deno.test('/_/ answers the core tree on an extra bind too', async () => {
  const { core, layers, close } = await makeApps();
  try {
    const extra = facade(core, layers, {
      listenPort: 3689,
      defaultPort: 4534,
    });
    const res = await extra(new Request('http://x/_/health'));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });
  } finally {
    await close();
  }
});

Deno.test('request trace: accept+headers lines, redacted dump only with the extra flag', async () => {
  const { core, layers, close } = await makeApps();
  try {
    const { log, lines } = captureLogs();
    try {
      // Off by default.
      await facade(core, layers, { log })(new Request('http://x/echo?c=test'));
      assertEquals(lines.length, 0);

      // With debugLogRequests: compact accept + headers, no header dump.
      await facade(core, layers, { debugLogRequests: true, log })(
        new Request('http://x/echo?c=test&u=admin&p=hunter2&apiKey=sekrit', {
          headers: {
            'user-agent': 'facade-test',
            cookie: 'session=abc123',
            'x-api-key': 'alsosomething',
          },
        }),
      );
      assertEquals(lines.length, 2);
      assertEquals(parseLogfmt(lines[0]).event, 'http_accept');
      assertEquals(parseLogfmt(lines[0]).req, '1');
      assertEquals(parseLogfmt(lines[0]).inflight, '1');
      assertEquals(parseLogfmt(lines[0]).method, 'GET');
      assertEquals(parseLogfmt(lines[0]).path, '/echo');
      assert(lines[0].includes('peer='));
      assertEquals(parseLogfmt(lines[1]).event, 'http_headers');
      assertEquals(parseLogfmt(lines[1]).req, '1');
      assertEquals(parseLogfmt(lines[1]).status, '200');
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
        log,
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
      assertEquals(parseLogfmt(lines[0]).event, 'http_accept');
      assertEquals(parseLogfmt(lines[0]).req, '1');
      assert(lines[0].includes('c=test'));
      assertEquals(
        JSON.parse(parseLogfmt(lines[0]).headers)['user-agent'],
        'facade-test',
      );
      const query = new URL(parseLogfmt(lines[0]).url).searchParams;
      assertEquals(query.get('u'), '[redacted]');
      assertEquals(query.get('p'), '[redacted]');
      assertEquals(query.get('apiKey'), '[redacted]');
      assert(!lines[0].includes('hunter2'));
      assert(!lines[0].includes('sekrit'));
      assert(!lines[0].includes('abc123'));
      assert(!lines[0].includes('alsosomething'));
    } finally {
      await log.flush();
    }
  } finally {
    await close();
  }
});

Deno.test('request trace: done logs when info.completed settles', async () => {
  const { core, layers, close } = await makeApps();
  try {
    const { log, lines } = captureLogs();
    try {
      let complete!: () => void;
      const info = { completed: new Promise<void>((r) => (complete = r)) };
      const res = await facade(core, layers, { debugLogRequests: true, log })(
        new Request('http://x/echo'),
        info,
      );
      assertEquals(res.status, 200);
      assertEquals(lines.length, 2); // accept + headers; done pending
      complete();
      await info.completed;
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertEquals(lines.length, 3);
      assertEquals(parseLogfmt(lines[2]).event, 'http_done');
      assertEquals(parseLogfmt(lines[2]).req, '1');
      assert(lines[2].includes('bodyMs='));
      assertEquals(parseLogfmt(lines[2]).aborted, 'false');
    } finally {
      await log.flush();
    }
  } finally {
    await close();
  }
});

Deno.test('claimed prefixes exclude unrelated bare matches, including missing paths and other methods', async () => {
  const { core, layers, close } = await makeApps();
  try {
    const root = layers.find((l) => l.name === 'layer-a')!;
    // Real root-mounted /echo route also matches this mounted hat's namespace.
    const mounted: Layer = {
      ...root,
      name: 'mounted',
      mounts: root.mounts.map((mount) => ({ ...mount, prefix: '/echo' })),
    };
    const app = facade(core, [root, mounted]);
    const missing = await app(new Request('http://x/echo'));
    assertEquals(missing.status, 404); // mounted remainder '/', never root /echo
    await missing.body?.cancel();
    const response = await app(new Request('http://x/echo/echo'));
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { layer: 'a', route: '/echo' });
    const post = await app(
      new Request('http://x/echo/echo', { method: 'POST' }),
    );
    assertEquals(post.status, 405);
    await post.body?.cancel();
    // The force-prefix grammar still deliberately selects only that hat.
    const forced = await app(new Request('http://x/_layer-a/echo'));
    assertEquals(forced.status, 200);
    assertEquals(await forced.json(), { layer: 'a', route: '/echo' });
  } finally {
    await close();
  }
});

Deno.test('shared claimed prefix preserves header dispatch on default and replaced/per-layer sockets', async () => {
  const { core, layers, close } = await makeApps();
  try {
    const root = layers.find((l) => l.name === 'layer-a')!;
    const make = (name: string, header: string, ports: number[]): Layer => ({
      ...layers.find((l) => l.name === `layer-${name}`)!,
      name,
      ports,
      headers: [{ name: 'x-hat', includes: header }],
      mounts: layers.find((l) => l.name === `layer-${name}`)!.mounts.map((
        mount,
      ) => ({ ...mount, prefix: '/shared' })),
    });
    const a = make('p', 'p', []), b = make('q', 'q', []);
    // Root /echo is a legitimate unrelated bare route, never a shared claimant.
    const variants: NonNullable<Parameters<typeof facade>[2]>[] = [
      {},
      {
        listenPort: 4000,
        defaultPort: 4534,
        env: { MELOFON_LISTEN_REPLACE_3689: '4000' },
      },
      {
        listenPort: 4001,
        defaultPort: 4534,
        env: { MELOFON_LISTEN_p: '4001', MELOFON_LISTEN_q: '4001' },
      },
    ];
    for (const opts of variants) {
      const ported = 'listenPort' in opts;
      const selected = [a, b].map((layer) => ({
        ...layer,
        ports: ported ? [3689] : [],
      }));
      const app = facade(core, [root, ...selected], opts);
      for (const header of ['p', 'q']) {
        const response = await app(
          new Request('http://x/shared', { headers: { 'x-hat': header } }),
        );
        assertEquals(response.status, 200);
        assertEquals(await response.json(), {
          layer: header,
          route: header === 'p' ? '/alpha' : '/beta',
        });
      }
      const ambiguous = await app(new Request('http://x/shared'));
      assertEquals(ambiguous.status, 404);
      await ambiguous.body?.cancel();
    }
  } finally {
    await close();
  }
});

Deno.test('unclaimed bare aliases keep previous exclusive-socket and force-prefix behavior', async () => {
  const { core, layers, close } = await makeApps();
  try {
    const root = layers.find((l) => l.name === 'layer-a')!;
    const mounted: Layer = {
      ...root,
      name: 'mounted',
      ports: [3689],
      mounts: root.mounts.map((mount) => ({ ...mount, prefix: '/claimed' })),
    };
    const app = facade(core, [root, mounted], {
      listenPort: 3689,
      defaultPort: 4534,
    });
    for (
      const path of [
        '/echo',
        '/claimed/echo',
        '/_mounted/echo',
        '/_mounted/claimed/echo',
      ]
    ) {
      const response = await app(new Request(`http://x${path}`));
      assertEquals(response.status, 200, path);
      assertEquals(await response.json(), { layer: 'a', route: '/echo' });
    }
    const absentClaimant = await facade(core, [mounted])(
      new Request('http://x/claimed/echo'),
    );
    assertEquals(absentClaimant.status, 404);
    await absentClaimant.body?.cancel();
  } finally {
    await close();
  }
});
