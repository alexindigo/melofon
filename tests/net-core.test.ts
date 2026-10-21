import { assert, assertEquals, assertRejects } from '@std/assert';
import { createNetwork } from '../src/lookups/net.ts';
import { openStore } from '../src/store/index.ts';
import { createState } from '../src/state.ts';
import { publicAddress } from '../src/net-address.ts';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';

const authority = {
  caller: 'core.test',
  hosts: () => true,
  ratePerMinute: 600000,
  signal: new AbortController().signal,
};
const limits = { timeoutMs: 2000, maxBytes: 10000 };

Deno.test('environment proxies cannot bypass pinned destinations for HTTP or HTTPS', async () => {
  let proxyHits = 0, targetHits = 0;
  const proxy = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    () => {
      proxyHits++;
      return new Response('PROXY');
    },
  );
  const handler = () => {
    targetHits++;
    return new Response('TARGET');
  };
  const plain = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    handler,
  );
  const secure = Deno.serve({
    hostname: '127.0.0.1',
    port: 0,
    onListen() {},
    cert: await Deno.readTextFile(
      new URL('./fixtures/net-tls/cert.pem', import.meta.url),
    ),
    key: await Deno.readTextFile(
      new URL('./fixtures/net-tls/key.pem', import.meta.url),
    ),
  }, handler);
  try {
    for (
      const url of [
        `http://feed.test:${plain.addr.port}/`,
        `https://feed.test:${secure.addr.port}/`,
      ]
    ) {
      const proxyUrl = `http://127.0.0.1:${proxy.addr.port}`;
      const output = await new Deno.Command(Deno.execPath(), {
        args: [
          'run',
          '--frozen',
          '--cached-only',
          '--node-modules-dir=manual',
          '--allow-net',
          '--allow-env',
          '--allow-read',
          new URL('./fixtures/net-proxy-consumer.ts', import.meta.url).pathname,
          url,
        ],
        env: {
          NODE_USE_ENV_PROXY: '1',
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          http_proxy: proxyUrl,
          https_proxy: proxyUrl,
          NO_PROXY: '',
          no_proxy: '',
        },
        signal: AbortSignal.timeout(10000),
        stdout: 'piped',
        stderr: 'piped',
      }).output();
      assert(output.success, new TextDecoder().decode(output.stderr));
      assert(
        new TextDecoder().decode(output.stdout).includes(
          'PROXY_CONSUMER 200 TARGET',
        ),
      );
    }
    assertEquals(proxyHits, 0);
    assertEquals(targetHits, 2);
  } finally {
    await plain.shutdown();
    await secure.shutdown();
    await proxy.shutdown();
  }
});

Deno.test({
  name: 'DNS rebinding cannot replace a checked public address at connect time',
  permissions: { net: ['localhost', '127.0.0.1'] },
  async fn() {
    let hits = 0, resolutions = 0;
    const server = Deno.serve(
      { hostname: '127.0.0.1', port: 0, onListen() {} },
      () => {
        hits++;
        return new Response('private');
      },
    );
    try {
      const network = createNetwork({
        state: {
          declare() {},
          getTyped: (key) =>
            Promise.resolve(key === 'lookups.requestAttempts' ? 1 : undefined),
        },
        resolve: () =>
          Promise.resolve([
            ++resolutions === 1 ? '93.184.216.34' : '127.0.0.1',
          ]),
      });
      // The numeric public connection is refused by this test's narrowed Deno
      // permission, before any external traffic. An unpinned localhost lookup
      // would reach the private fixture and fail these assertions.
      await assertRejects(
        () =>
          network.fetch(
            authority,
            `http://localhost:${server.addr.port}/`,
            {},
            limits,
          ),
        Error,
        '93.184.216.34',
      );
      assertEquals(resolutions, 1);
      assertEquals(hits, 0);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test('pinned HTTPS preserves TLS certificate and logical hostname verification', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore(`${dir}/data`);
  const state = createState(store);
  const cert = await Deno.readTextFile(
    new URL('./fixtures/net-tls/cert.pem', import.meta.url),
  );
  const key = await Deno.readTextFile(
    new URL('./fixtures/net-tls/key.pem', import.meta.url),
  );
  let hits = 0;
  const server = Deno.serve({
    hostname: '127.0.0.1',
    port: 0,
    cert,
    key,
    onListen() {},
  }, (request) => {
    hits++;
    return new Response(request.headers.get('host'));
  });
  try {
    const network = createNetwork({
      state,
      ca: cert,
      resolve: () => Promise.resolve(['127.0.0.1']),
    });
    await state.set('net.allowPrivateDestinations', 'true');
    await state.set('lookups.requestAttempts', '1');
    const response = await network.fetch(
      authority,
      `https://feed.test:${server.addr.port}/`,
      {},
      limits,
    );
    assertEquals(await response.text(), `feed.test:${server.addr.port}`);
    const error = await assertRejects(() =>
      network.fetch(
        authority,
        `https://wrong.test:${server.addr.port}/`,
        {},
        limits,
      )
    );
    assert(
      /certificate|hostname|not valid|cert/i.test(String(error)),
      String(error),
    );
    const untrusted = createNetwork({
      state,
      resolve: () => Promise.resolve(['127.0.0.1']),
    });
    await assertRejects(() =>
      untrusted.fetch(
        authority,
        `https://feed.test:${server.addr.port}/`,
        {},
        limits,
      )
    );
    assertEquals(
      hits,
      1,
      'neither wrong hostname nor an untrusted CA reaches the HTTP consumer',
    );
  } finally {
    await server.shutdown();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('core buffered/file consumers decode gzip, deflate and br with decoded-byte caps', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore(`${dir}/data`);
  const state = createState(store);
  const plain = 'decoded feed data '.repeat(1000);
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    (request) => {
      const encoding = new URL(request.url).pathname.slice(1);
      const bytes = new TextEncoder().encode(plain);
      const body = encoding === 'gzip'
        ? gzipSync(bytes)
        : encoding === 'deflate'
        ? deflateSync(bytes)
        : brotliCompressSync(bytes);
      return new Response(body, {
        headers: {
          'content-encoding': encoding,
          'content-length': String(body.length),
        },
      });
    },
  );
  try {
    const network = createNetwork({ state });
    await state.set('net.allowPrivateDestinations', 'true');
    for (const encoding of ['gzip', 'deflate', 'br']) {
      const url = `http://127.0.0.1:${server.addr.port}/${encoding}`;
      const response = await network.fetch(authority, url, {}, {
        ...limits,
        maxBytes: 20000,
      });
      assertEquals(await response.text(), plain);
      await network.toFile(authority, url, `${dir}/${encoding}`, {
        ...limits,
        maxBytes: 20000,
      });
      assertEquals(await Deno.readTextFile(`${dir}/${encoding}`), plain);
      await assertRejects(
        () =>
          network.toFile(authority, url, `${dir}/large`, {
            ...limits,
            maxBytes: 1000,
          }),
        Error,
        'size cap',
      );
    }
  } finally {
    await server.shutdown();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('core network defaults refuse private IPv4/IPv6 and unusual numeric URL forms before connection', async () => {
  const network = createNetwork();
  for (
    const host of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.1.1',
      '192.168.2.2',
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1',
      '[::1]',
      '[::]',
      '[fc00::1]',
      '[fe80::1]',
      '[::ffff:127.0.0.1]',
      '[::ffff:192.168.1.1]',
      '2130706433',
      '0x7f000001',
      '127.1',
    ]
  ) {
    await assertRejects(
      () => network.fetch(authority, `http://${host}:9/`, {}, limits),
      Error,
      'destination refused',
    );
  }
  for (
    const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']
  ) assert(publicAddress(ip), ip);
  for (
    const ip of [
      'invalid',
      '224.0.0.1',
      'ff02::1',
      '2002:7f00:1::',
      '2001:db8::1',
    ]
  ) assert(!publicAddress(ip), ip);
});

Deno.test('core network rejects private/mixed DNS answers and checks every redirect hop', async () => {
  let hits = 0;
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    () => {
      hits++;
      return Response.redirect('http://localhost:9/secret');
    },
  );
  try {
    const network = createNetwork({
      fixtures: { 'fixture.test': `http://127.0.0.1:${server.addr.port}` },
      resolve: (host) =>
        Promise.resolve(
          host === 'mixed.test' ? ['8.8.8.8', '10.0.0.1'] : ['127.0.0.1'],
        ),
    });
    for (const host of ['private.test', 'mixed.test']) {
      await assertRejects(
        () => network.fetch(authority, `http://${host}/`, {}, limits),
        Error,
        'destination refused',
      );
    }
    await assertRejects(
      () => network.fetch(authority, 'http://fixture.test/', {}, limits),
      Error,
      'destination refused',
    );
    assertEquals(hits, 1, 'redirect never contacts the private destination');
    await assertRejects(
      () => createNetwork().fetch(authority, 'http://localhost:9/', {}, limits),
      Error,
      'destination refused',
    );
  } finally {
    await server.shutdown();
  }
});

Deno.test('core file streaming pins DNS, preserves Host, enforces both byte caps and publishes only complete files', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore(`${dir}/data`);
  const state = createState(store);
  const hosts: string[] = [];
  const payload = new Uint8Array(256 * 1024).map((_, i) => i % 251);
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    (request) => {
      hosts.push(request.headers.get('host')!);
      const path = new URL(request.url).pathname;
      if (path === '/http-error') {
        return new Response('not media', {
          status: 404,
        });
      }
      if (path === '/length') {
        return new Response(payload, {
          headers: { 'content-length': String(payload.length) },
        });
      }
      if (path === '/redirect') {
        return Response.redirect(
          'http://private.test/stream',
        );
      }
      let offset = 0;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (offset === payload.length) {
              controller.close();
              return;
            }
            controller.enqueue(payload.slice(offset, offset += 1024));
          },
        }),
        { headers: { 'content-type': 'audio/mpeg' } },
      );
    },
  );
  try {
    const network = createNetwork({
      state,
      resolve: () => Promise.resolve(['127.0.0.1']),
    });
    assertEquals(await state.getTyped('net.allowPrivateDestinations'), false);
    await state.set('net.allowPrivateDestinations', 'true');
    const url = `http://does-not-resolve.invalid:${server.addr.port}`;
    const file = `${dir}/episode.mp3`;
    const result = await network.toFile(authority, `${url}/stream`, file, {
      ...limits,
      maxBytes: payload.length,
    });
    assertEquals(result, { size: payload.length, contentType: 'audio/mpeg' });
    assertEquals(await Deno.readFile(file), payload);
    assertEquals(hosts[0], `does-not-resolve.invalid:${server.addr.port}`);
    for (const path of ['/stream', '/length']) {
      await assertRejects(
        () =>
          network.toFile(authority, `${url}${path}`, file, {
            ...limits,
            maxBytes: 2000,
          }),
        Error,
        'size cap',
      );
      assertEquals(
        await Deno.readFile(file),
        payload,
        'an existing destination is never replaced by partial data',
      );
    }
    await assertRejects(
      () =>
        network.toFile(
          authority,
          `${url}/http-error`,
          `${dir}/missing`,
          limits,
        ),
      Error,
      'HTTP 404',
    );
    assertEquals(
      [...Deno.readDirSync(dir)].filter((entry) =>
        entry.name.endsWith('.part')
      ),
      [],
    );
    await state.set('net.allowPrivateDestinations', 'false');
    const count = hosts.length;
    await assertRejects(
      () => network.toFile(authority, `${url}/stream`, file, limits),
      Error,
      'destination refused',
    );
    assertEquals(
      hosts.length,
      count,
      'the next request observes the live setting',
    );
  } finally {
    await server.shutdown();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('stream-to-file shares timeout retry and caller cancellation without retaining partial files', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore(`${dir}/data`);
  const state = createState(store);
  let hits = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    () => {
      hits++;
      if (hits === 2) return new Response('complete');
      let timer: ReturnType<typeof setTimeout>;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('partial'));
            timer = setTimeout(() => {
              timers.delete(timer);
              controller.close();
            }, 5000);
            timers.add(timer);
          },
          cancel() {
            clearTimeout(timer);
            timers.delete(timer);
          },
        }),
      );
    },
  );
  try {
    const network = createNetwork({ state });
    await state.set('net.allowPrivateDestinations', 'true');
    await state.set('lookups.bodyIdleSeconds', '0.05');
    await state.set('lookups.requestTimeoutSeconds', '1');
    const url = `http://127.0.0.1:${server.addr.port}/`;
    const path = `${dir}/episode`;
    await network.toFile(authority, url, path, limits);
    assertEquals(hits, 2);
    assertEquals(await Deno.readTextFile(path), 'complete');
    const cancel = new AbortController();
    const pending = network.toFile(
      { ...authority, signal: cancel.signal },
      url,
      `${dir}/cancelled`,
      limits,
    );
    const timer = setTimeout(
      () => cancel.abort(new Error('cancelled by caller')),
      20,
    );
    try {
      await assertRejects(() => pending, Error, 'cancelled by caller');
    } finally {
      clearTimeout(timer);
    }
    assertEquals(
      [...Deno.readDirSync(dir)].filter((entry) =>
        entry.name.endsWith('.part')
      ),
      [],
    );
  } finally {
    for (const timer of timers) clearTimeout(timer);
    await server.shutdown();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
