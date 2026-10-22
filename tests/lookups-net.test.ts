import { assert, assertEquals, assertRejects } from '@std/assert';
import {
  createLookupNetwork,
  intersectHosts,
  matchesHost,
} from '../src/lookups/net.ts';
import type { Log } from '../src/logging.ts';

Deno.test('approved loopback plugin hosts are trusted while response URLs on other private hosts are refused', async () => {
  const hits: string[] = [];
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    (request): Response => {
      hits.push(new URL(request.url).pathname);
      return Response.json({
        image: `http://localhost:${server.addr.port}/private-image`,
      });
    },
  );
  const authority = {
    plugin: 'local',
    hosts: ['127.0.0.1'],
    ratePerMinute: 600000,
    signal: new AbortController().signal,
  };
  const limits = { timeoutMs: 2000, maxBytes: 1000 };
  const network = createLookupNetwork();
  try {
    const result = await (await network.fetch(
      authority,
      `http://127.0.0.1:${server.addr.port}/plugin`,
      {},
      limits,
    )).json();
    await assertRejects(
      () => network.fetch(authority, result.image, {}, limits),
      Error,
      'Host not granted',
    );
    assertEquals(hits, ['/plugin']);
  } finally {
    await server.shutdown();
  }
});

Deno.test('network grant intersection never broadens exact hosts or wildcard boundaries', () => {
  assertEquals(intersectHosts(['sub.example.test'], ['*.example.test']), [
    'sub.example.test',
  ]);
  assertEquals(intersectHosts(['*.example.test'], ['*.sub.example.test']), [
    '*.sub.example.test',
  ]);
  assertEquals(
    intersectHosts(['*.example.test'], ['example.test', 'badexample.test']),
    [],
  );
  assert(!matchesHost('*.example.test', 'example.test'));
});
Deno.test('lookup effective grants are bounded by the parent process permissions', async () => {
  const url = new URL('../src/lookups/net.ts', import.meta.url).href;
  const worker = new Worker(
    `data:application/javascript,${
      encodeURIComponent(
        `import {parentGrant} from ${
          JSON.stringify(url)
        }; postMessage(await parentGrant(['127.0.0.1','forbidden.test','*.images.test']));`,
      )
    }`,
    {
      type: 'module',
      deno: {
        permissions: {
          read: [new URL('../src', import.meta.url)],
          net: ['127.0.0.1'],
          import: false,
          env: false,
          write: false,
          ffi: false,
          run: false,
          sys: false,
        },
      },
    },
  );
  try {
    const result = await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => resolve(data);
      worker.onerror = (event) => {
        event.preventDefault();
        reject(new Error(event.message));
      };
    });
    assertEquals(result, ['127.0.0.1']);
  } finally {
    worker.terminate();
  }
});
Deno.test('lookup network checks redirects, sets user-agent, caps bodies and logs each request once', async () => {
  const logs: Record<string, unknown>[] = [];
  let hits = 0;
  const server = Deno.serve(
    { port: 0, hostname: '127.0.0.1', onListen() {} },
    (request) => {
      hits++;
      const path = new URL(request.url).pathname;
      if (path === '/redirect') {
        return Response.redirect(
          'https://forbidden.test/image',
          302,
        );
      }
      if (path === '/large') return new Response('x'.repeat(200));
      if (path === '/stream') {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(200));
              controller.close();
            },
          }),
        );
      }
      return Response.json({ ua: request.headers.get('user-agent') });
    },
  );
  const controller = new AbortController();
  const authority = {
    plugin: 'fixture',
    hosts: ['fixture.test'],
    ratePerMinute: 600000,
    signal: controller.signal,
  };
  const network = createLookupNetwork({
    fixtures: { 'fixture.test': `http://127.0.0.1:${server.addr.port}` },
    log: {
      event(_event, facts) {
        logs.push(facts);
      },
    } as Log,
  });
  const limits = { timeoutMs: 1000, maxBytes: 100 };
  try {
    const response = await network.fetch(
      authority,
      'https://fixture.test/',
      {},
      { ...limits, maxBytes: 1000 },
    );
    assert(
      (await response.json()).ua.startsWith(
        'Melofon/0.1.0 (+https://github.com/alexindigo/melofon)',
      ),
    );
    await assertRejects(
      () => network.fetch(authority, 'https://forbidden.test/', {}, limits),
      Error,
      'not granted',
    );
    await assertRejects(
      () =>
        network.fetch(authority, 'https://fixture.test/redirect', {}, limits),
      Error,
      'not granted',
    );
    await assertRejects(
      () => network.fetch(authority, 'https://fixture.test/large', {}, limits),
      Error,
      'size cap',
    );
    await assertRejects(
      () => network.fetch(authority, 'https://fixture.test/stream', {}, limits),
      Error,
      'size cap',
    );
    assertEquals(hits, 4);
    assertEquals(logs.map((l) => [l.host, l.status]), [
      ['fixture.test', 200],
      ['forbidden.test', 'error'],
      ['fixture.test', 302],
      ['forbidden.test', 'error'],
      ['fixture.test', 200],
      ['fixture.test', 200],
    ]);
  } finally {
    controller.abort();
    await server.shutdown();
  }
});
Deno.test('lookup network spaces plugin requests and aborts rate waits on timeout or revocation', async () => {
  const times: number[] = [];
  const server = Deno.serve(
    { port: 0, hostname: '127.0.0.1', onListen() {} },
    () => {
      times.push(performance.now());
      return new Response('ok');
    },
  );
  const controller = new AbortController();
  const authority = {
    plugin: 'fixture',
    hosts: ['fixture.test'],
    ratePerMinute: 600,
    signal: controller.signal,
  };
  const network = createLookupNetwork({
    fixtures: { 'fixture.test': `http://127.0.0.1:${server.addr.port}` },
  });
  const limits = { timeoutMs: 1000, maxBytes: 100 };
  try {
    await Promise.all([
      network.fetch(authority, 'https://fixture.test/', {}, limits),
      network.fetch(authority, 'https://fixture.test/', {}, limits),
    ]);
    assert(times[1] - times[0] >= 80);
    await assertRejects(
      () =>
        network.fetch(authority, 'https://fixture.test/', {}, {
          ...limits,
          timeoutMs: 10,
        }),
      Error,
      'timed out',
    );
    const pending = network.fetch(
      authority,
      'https://fixture.test/',
      {},
      limits,
    );
    controller.abort(new Error('revoked'));
    await assertRejects(() => pending, Error, 'revoked');
    assertEquals(times.length, 2);
  } finally {
    await server.shutdown();
  }
});
