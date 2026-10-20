import { assert, assertEquals, assertRejects } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { createLookupNetwork } from '../src/lookups/net.ts';
import { createLookupRunner } from '../src/lookups/runner.ts';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { createState } from '../src/state.ts';
import { createLibraries } from '../src/libraries.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibrary } from '../src/library.ts';
import { createArtwork } from '../src/artwork.ts';
import { seedFirstUser } from '../src/users.ts';
import { createUserService } from '../src/user.ts';
import { loadLayers } from '../src/layers.ts';
import { facade } from '../src/facade.ts';
import { eventually, lookupPlugin } from './helpers/lookup.ts';
import { pictured } from './helpers/pictured.ts';

// Real TCP: accepting without sending headers, and sending headers without a
// complete body, exercise different native fetch phases (no mocked timers).
function fixture(
  handler: (conn: Deno.TcpConn, path: string, hit: number) => Promise<void>,
) {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const connections = new Set<Deno.TcpConn>();
  const tasks: Promise<void>[] = [];
  const hits: { path: string; at: number }[] = [];
  let closing = false;
  const accept = (async () => {
    try {
      for await (const conn of listener) {
        connections.add(conn);
        tasks.push((async () => {
          try {
            const buf = new Uint8Array(8192);
            const n = await conn.read(buf);
            if (n === null) return;
            const path =
              new TextDecoder().decode(buf.subarray(0, n)).split(' ')[1];
            hits.push({ path, at: performance.now() });
            await handler(conn, path, hits.length);
          } catch (error) {
            if (
              !closing && !(error instanceof Deno.errors.BrokenPipe) &&
              !(error instanceof Deno.errors.ConnectionReset)
            ) throw error;
          } finally {
            connections.delete(conn);
            try {
              conn.close();
            } catch { /* Already closed during cleanup. */ }
          }
        })());
      }
    } catch (error) {
      if (!closing) throw error;
    }
  })();
  return {
    origin: `http://127.0.0.1:${(listener.addr as Deno.NetAddr).port}`,
    hits,
    async close() {
      closing = true;
      listener.close();
      for (const conn of connections) conn.close();
      await accept;
      await Promise.all(tasks);
    },
  };
}
async function write(conn: Deno.TcpConn, value: string | Uint8Array) {
  const bytes = typeof value === 'string'
    ? new TextEncoder().encode(value)
    : value;
  for (let offset = 0; offset < bytes.length;) {
    offset += await conn.write(bytes.subarray(offset));
  }
}
async function stall(conn: Deno.TcpConn) {
  while (
    await conn.read(new Uint8Array(1024)) !== null
  ) { /* Until client abort. */ }
}
async function answer(
  conn: Deno.TcpConn,
  bytes = new TextEncoder().encode('ok'),
  type = 'text/plain',
) {
  await write(
    conn,
    `HTTP/1.1 200 OK\r\nContent-Length: ${bytes.length}\r\nContent-Type: ${type}\r\nConnection: close\r\n\r\n`,
  );
  await write(conn, bytes);
}
const authority = (ratePerMinute = 600000) => ({
  plugin: 'fixture',
  hosts: ['fixture.test'],
  ratePerMinute,
  signal: new AbortController().signal,
});
const limits = { timeoutMs: 1500, maxBytes: 10000 };
async function networkCase(
  handler: Parameters<typeof fixture>[0],
  run: (s: {
    state: ReturnType<typeof createState>;
    network: ReturnType<typeof createLookupNetwork>;
    server: Awaited<ReturnType<typeof fixture>>;
  }) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  const store = await openStore(`${dir}/data`);
  const state = createState(store);
  const server = await fixture(handler);
  const network = createLookupNetwork({
    fixtures: { 'fixture.test': server.origin },
    state,
  });
  try {
    await state.set('lookups.requestTimeoutSeconds', '0.2');
    await state.set('lookups.bodyIdleSeconds', '0.05');
    await state.set('lookups.requestAttempts', '2');
    await run({ state, network, server });
  } finally {
    await server.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('response timeout bounds accepted connections without headers and exhausts exactly the configured attempts', async () => {
  await networkCase(stall, async ({ network, server }) => {
    const start = performance.now();
    await assertRejects(
      () => network.fetch(authority(), 'https://fixture.test/', {}, limits),
      Error,
      'response timed out',
    );
    assertEquals(server.hits.length, 2);
    assert(
      performance.now() - start < 1000,
      'Must finish before the 1500ms whole-call budget',
    );
  });
});
Deno.test('body idle timeout bounds stalled bodies and discards partial bytes before retry', async () => {
  await networkCase(async (conn, _path, hit) => {
    if (hit === 2) return await answer(conn);
    await write(conn, 'HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nx');
    await stall(conn);
  }, async ({ network, server }) => {
    const result = await network.fetch(
      authority(),
      'https://fixture.test/',
      {},
      limits,
    );
    assertEquals(await result.text(), 'ok');
    assertEquals(server.hits.length, 2);
  });
});
Deno.test('body idle deadline resets on progress rather than limiting total download time', async () => {
  await networkCase(async (conn) => {
    await write(conn, 'HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n');
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await write(conn, 'x');
    }
  }, async ({ network, state, server }) => {
    await state.set('lookups.bodyIdleSeconds', '0.1');
    const result = await network.fetch(
      authority(),
      'https://fixture.test/',
      {},
      limits,
    );
    assertEquals(await result.text(), 'xxxxx');
    assertEquals(server.hits.length, 1);
  });
});
Deno.test('redirected requests get their own idle deadline and exhaust stalled-body attempts before the job budget', async () => {
  await networkCase(async (conn, path) => {
    if (path === '/') {
      return await write(
        conn,
        'HTTP/1.1 302 Found\r\nLocation: /body\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      );
    }
    await write(conn, 'HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nx');
    await stall(conn);
  }, async ({ network, server }) => {
    const start = performance.now();
    await assertRejects(
      () => network.fetch(authority(), 'https://fixture.test/', {}, limits),
      Error,
      'body idle timed out',
    );
    assertEquals(server.hits.map((h) => h.path), ['/', '/body', '/body']);
    assert(performance.now() - start < 1000);
  });
});
Deno.test('retries and redirect hops respect rate spacing; headers deadline excludes the rate wait', async () => {
  await networkCase(async (conn, path, hit) => {
    if (hit === 1) return await stall(conn);
    if (path === '/') {
      return await write(
        conn,
        'HTTP/1.1 302 Found\r\nLocation: /end\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      );
    }
    await answer(conn);
  }, async ({ network, server }) => {
    const result = await network.fetch(
      authority(300),
      'https://fixture.test/',
      {},
      limits,
    );
    assertEquals(await result.text(), 'ok');
    assertEquals(server.hits.map((h) => h.path), ['/', '/', '/end']);
    for (let i = 1; i < server.hits.length; i++) {
      assert(server.hits[i].at - server.hits[i - 1].at >= 175);
    }
  });
});
Deno.test('network-owned settings declare defaults, validate, persist and change subsequent requests live', async () => {
  await networkCase(async (conn) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await answer(conn);
  }, async ({ network, state, server }) => {
    // Defaults are tested in the runner fixture before any values are set.
    await state.set('lookups.requestTimeoutSeconds', '0.05');
    await assertRejects(() => state.set('lookups.requestAttempts', '0'));
    await assertRejects(() => state.set('lookups.requestAttempts', '1.5'));
    await assertRejects(() => state.set('lookups.requestTimeoutSeconds', '0'));
    await assertRejects(() => state.set('lookups.bodyIdleSeconds', '-1'));
    await state.set('lookups.requestAttempts', '1');
    await assertRejects(
      () => network.fetch(authority(), 'https://fixture.test/', {}, limits),
      Error,
      'response timed out',
    );
    await state.set('lookups.requestTimeoutSeconds', '0.3');
    assertEquals(
      await (await network.fetch(
        authority(),
        'https://fixture.test/',
        {},
        limits,
      )).text(),
      'ok',
    );
    assertEquals(server.hits.length, 2);
    assertEquals(await state.get('lookups.requestTimeoutSeconds'), '0.3');
    assertEquals(await state.getTyped('lookups.requestAttempts'), 1);
  });
});
Deno.test('outer cancellation and whole-call budget stop retries, including rate waits', async () => {
  await networkCase(stall, async ({ network, state, server }) => {
    await state.set('lookups.requestAttempts', '5');
    const controller = new AbortController();
    const pending = network.fetch(authority(60), 'https://fixture.test/', {
      signal: controller.signal,
    }, limits);
    await eventually(() => server.hits.length === 1);
    controller.abort(new Error('caller cancelled'));
    await assertRejects(() => pending, Error, 'caller cancelled');
    const start = performance.now();
    await assertRejects(
      () =>
        network.fetch(authority(60), 'https://fixture.test/', {}, {
          ...limits,
          timeoutMs: 100,
        }),
      Error,
      'timed out',
    );
    assert(performance.now() - start < 500);
    assertEquals(server.hits.length, 1);
  });
});
Deno.test('connection failures retry, while HTTP errors and policy failures do not', async () => {
  await networkCase(async (conn, path, hit) => {
    if (path === '/connect' && hit === 1) return; // EOF before headers.
    if (path === '/http') {
      return await write(
        conn,
        'HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      );
    }
    if (path === '/large') {
      return await write(
        conn,
        'HTTP/1.1 200 OK\r\nContent-Length: 999999\r\nConnection: close\r\n\r\n',
      );
    }
    await answer(conn);
  }, async ({ network, server }) => {
    assertEquals(
      await (await network.fetch(
        authority(),
        'https://fixture.test/connect',
        {},
        limits,
      )).text(),
      'ok',
    );
    assertEquals(
      (await network.fetch(
        authority(),
        'https://fixture.test/http',
        {},
        limits,
      )).status,
      503,
    );
    await assertRejects(
      () =>
        network.fetch(authority(), 'https://fixture.test/large', {}, limits),
      Error,
      'size cap',
    );
    await assertRejects(
      () => network.fetch(authority(), 'https://forbidden.test/', {}, limits),
      Error,
      'not granted',
    );
    assertEquals(server.hits.map((h) => h.path), [
      '/connect',
      '/connect',
      '/http',
      '/large',
    ]);
  });
});

for (const fail of [false, true]) {
  Deno.test(`lookup job ${fail ? 'fails only after request attempts' : 'recovers both RPC search and core image stalls; HTTP cover sees bytes'}`, async () => {
    const dir = await Deno.makeTempDir();
    const store = await openStore(`${dir}/data`);
    const state = createState(store);
    const image = await Deno.readFile(
      'tests/fixtures/library/Fixture Artist/Fixture Album/cover.jpg',
    );
    const counts = new Map<string, number>();
    const server = await fixture(async (conn, path) => {
      const count = (counts.get(path) ?? 0) + 1;
      counts.set(path, count);
      if (path === '/search' && (fail || count === 1)) return await stall(conn);
      if (path === '/image' && count === 1) {
        await write(conn, 'HTTP/1.1 200 OK\r\nContent-Length: 9999\r\n\r\nx');
        return await stall(conn);
      }
      await answer(
        conn,
        path === '/image' ? image : new TextEncoder().encode('ok'),
        path === '/image' ? 'image/jpeg' : 'text/plain',
      );
    });
    let runner: Awaited<ReturnType<typeof createLookupRunner>> | undefined;
    try {
      const cfg = {
        listen: undefined,
        dataDir: `${dir}/data`,
        user: 'admin',
        password: 'test',
        secret: 'g4',
        version: 'test',
      };
      await seedFirstUser(store, cfg);
      await pictured(`${dir}/music/Album/song.mp3`);
      await createLibraries(store).add('Music', `${dir}/music`);
      await scanLibrary(store);
      await lookupPlugin(
        `${dir}/lookups`,
        `export default { async cover(item, ctx) {
      await ctx.fetch('https://fixture.test/search');
      return { candidates: [{ target: { type: 'album', id: item.id }, confidence: 'strong', values: { 'album.image.front': { url: 'https://fixture.test/image' } } }] };
    } };`,
      );
      await state.set('lookups.plugin.fixture.hosts', 'fixture.test');
      const network = createLookupNetwork({
        fixtures: { 'fixture.test': server.origin },
        state,
      });
      assertEquals(await state.getTyped('lookups.requestTimeoutSeconds'), 10);
      assertEquals(await state.getTyped('lookups.bodyIdleSeconds'), 10);
      assertEquals(await state.getTyped('lookups.requestAttempts'), 2);
      await state.set('lookups.requestTimeoutSeconds', '0.2');
      await state.set('lookups.bodyIdleSeconds', '0.05');
      await state.set('lookups.jobTimeoutSeconds', '5');
      await state.set('lookups.maxAttempts', '1');
      runner = await createLookupRunner({
        store,
        state,
        dataDir: cfg.dataDir,
        builtin: `${dir}/lookups`,
        network,
      });
      await runner.hosts[0].start();
      const album =
        (await store.catalog.listAlbums({ sort: 'name', size: 10, offset: 0 }))[
          0
        ];
      const start = performance.now();
      await runner.request({ type: 'album', id: album.id }, 'all');
      await eventually(
        async () =>
          (await store.lookups.stats('fixture'))[fail ? 'failed' : 'done'] ===
            1,
        2500,
      );
      assert(
        performance.now() - start < 2500,
        'Request retries must finish before 5s job budget',
      );
      const [job] = await rawSql(store).all<
        { attempts: number; lastError: string | null }
      >('SELECT attempts, last_error AS lastError FROM lookup_jobs');
      assertEquals(job.attempts, 1);
      assertEquals(counts.get('/search'), 2);
      if (fail) {
        assert(job.lastError?.includes('response timed out'));
        assertEquals(
          await store.candidates.candidatesFor('album', album.id),
          [],
        );
      } else {
        assertEquals(counts.get('/image'), 2);
        const library = createLibrary(store);
        const app = facade(
          await pathfinder({ roots: ['core/'], app: { store, cfg } }),
          await loadLayers({
            app: {
              cfg,
              state,
              library,
              artwork: createArtwork(library),
              user: createUserService(store, cfg),
            },
          }),
        );
        const response = await app(
          new Request(
            `http://x/rest/getCoverArt.view?u=admin&p=test&v=1.16.1&c=g4&id=${album.id}`,
          ),
        );
        assertEquals(response.status, 200);
        assertEquals(response.headers.get('content-type'), 'image/jpeg');
        assertEquals(new Uint8Array(await response.arrayBuffer()), image);
      }
    } finally {
      await runner?.close();
      await server.close();
      await store.close();
      await Deno.remove(dir, { recursive: true });
    }
  });
}
