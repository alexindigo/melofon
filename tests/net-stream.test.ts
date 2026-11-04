import { assert, assertEquals, assertRejects } from '@std/assert';
import {
  type CoreNetworkAuthority,
  createNetwork,
} from '../src/lookups/net.ts';
import { openStore } from '../src/store/index.ts';
import { createState } from '../src/state.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const limits = { openTimeoutMs: 1000, idleTimeoutMs: 1000 };
const authority = (): CoreNetworkAuthority => ({
  caller: 'core.stream-test',
  hosts: () => true,
  trustedHosts: ['melofon.home'],
  ratePerMinute: 600000,
  signal: new AbortController().signal,
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);
  return { promise, resolve };
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function eventually(check: () => boolean) {
  const end = performance.now() + 3000;
  while (!check()) {
    assert(performance.now() < end, 'fixture did not observe stream cleanup');
    await sleep(10);
  }
}
async function write(conn: Deno.TcpConn, text: string | Uint8Array) {
  const bytes = typeof text === 'string' ? encoder.encode(text) : text;
  for (let offset = 0; offset < bytes.length;) {
    offset += await conn.write(bytes.subarray(offset));
  }
}
async function untilClosed(conn: Deno.TcpConn) {
  while (await conn.read(new Uint8Array(1024)) !== null) {
    /* Client closes. */
  }
}
function fixture(handler: (conn: Deno.TcpConn, path: string) => Promise<void>) {
  const listener = Deno.listen({ hostname: '0.0.0.0', port: 0 });
  const origin = `http://melofon.home:${(listener.addr as Deno.NetAddr).port}`;
  const connections = new Set<Deno.TcpConn>();
  const tasks: Promise<void>[] = [];
  const hits: string[] = [];
  let closed = 0;
  let closing = false;
  const accept = (async () => {
    try {
      for await (const conn of listener) {
        connections.add(conn);
        tasks.push((async () => {
          try {
            let request = '';
            const buf = new Uint8Array(8192);
            while (!request.includes('\r\n\r\n')) {
              const n = await conn.read(buf);
              if (n === null) return;
              request += decoder.decode(buf.subarray(0, n));
            }
            const path = request.split(' ')[1];
            hits.push(path);
            await handler(conn, path);
          } catch (error) {
            if (
              !closing && !(error instanceof Deno.errors.BrokenPipe) &&
              !(error instanceof Deno.errors.ConnectionReset)
            ) throw error;
          } finally {
            closed++;
            connections.delete(conn);
            try {
              conn.close();
            } catch { /* Already closed. */ }
          }
        })());
      }
    } catch (error) {
      if (!closing) throw error;
    }
  })();
  return {
    origin,
    hits,
    get closed() {
      return closed;
    },
    async close() {
      closing = true;
      listener.close();
      for (const conn of connections) conn.close();
      await accept;
      await Promise.all(tasks);
    },
  };
}
async function parked(conn: Deno.TcpConn) {
  await write(conn, 'HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\n\r\nfirst');
  await untilClosed(conn);
}

Deno.test('stream lease exposes headers and bytes before EOF, survives its open budget and retains final same-host LAN URL', async () => {
  const more = deferred();
  const server = fixture(async (conn, path) => {
    if (path === '/redirect') {
      await write(
        conn,
        'HTTP/1.1 302 Found\r\nLocation: /audio\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    await write(
      conn,
      'HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\nContent-Length: 999999999\r\n\r\nfirst',
    );
    await more.promise;
    await write(conn, 'second');
    await untilClosed(conn);
  });
  const network = createNetwork();
  try {
    const lease = await network.stream(
      authority(),
      `${server.origin}/redirect`,
      {},
      {
        openTimeoutMs: 250,
        idleTimeoutMs: 2000,
      },
    );
    try {
      assertEquals(lease.url, `${server.origin}/audio`);
      assertEquals(lease.response.headers.get('content-type'), 'audio/mpeg');
      const reader = lease.response.body!.getReader();
      assertEquals(decoder.decode((await reader.read()).value), 'first');
      await sleep(500);
      more.resolve();
      assertEquals(decoder.decode((await reader.read()).value), 'second');
      assertEquals(server.closed, 1, 'final body remains open');
      reader.releaseLock();
    } finally {
      await lease.close();
    }
    await eventually(() => server.closed === 2);
    assertEquals(server.hits, ['/redirect', '/audio']);
  } finally {
    more.resolve();
    await server.close();
  }
});

Deno.test('stream idle timeout rejects a parked read, closes TCP and never retries published bytes', async () => {
  const server = fixture(parked);
  try {
    const lease = await createNetwork().stream(authority(), server.origin, {}, {
      ...limits,
      idleTimeoutMs: 100,
    });
    try {
      const reader = lease.response.body!.getReader();
      assertEquals(decoder.decode((await reader.read()).value), 'first');
      await assertRejects(() => reader.read(), Error, 'body idle timed out');
      reader.releaseLock();
      await eventually(() => server.closed === 1);
      assertEquals(server.hits.length, 1);
    } finally {
      await lease.close();
    }
  } finally {
    await server.close();
  }
});

Deno.test('stream returns headers before any body, preserves HTTP errors and releases bodyless responses', async () => {
  const more = deferred();
  const server = fixture(async (conn, path) => {
    if (path === '/empty') {
      await write(conn, 'HTTP/1.1 204 No Content\r\n\r\n');
    } else if (path === '/head') {
      await write(conn, 'HTTP/1.1 200 OK\r\nContent-Length: 999\r\n\r\n');
    } else {
      await write(
        conn,
        `HTTP/1.1 ${
          path === '/error' ? '503 Unavailable' : '200 OK'
        }\r\nContent-Length: 5\r\n\r\n`,
      );
      if (path === '/late') await more.promise;
      await write(conn, 'first');
    }
  });
  try {
    const network = createNetwork();
    const late = await network.stream(
      authority(),
      `${server.origin}/late`,
      {},
      limits,
    );
    try {
      assertEquals(late.response.status, 200);
      more.resolve();
      assertEquals(await late.response.text(), 'first');
    } finally {
      await late.close();
    }
    for (const path of ['/head', '/empty', '/error']) {
      const lease = await network.stream(
        authority(),
        `${server.origin}${path}`,
        path === '/head' ? { method: 'HEAD' } : {},
        limits,
      );
      try {
        assertEquals(
          lease.response.status,
          path === '/empty' ? 204 : path === '/error' ? 503 : 200,
        );
        if (path === '/error') {
          assertEquals(await lease.response.text(), 'first');
        } else assertEquals(lease.response.body, null);
      } finally {
        await lease.close();
      }
    }
    const cancel = new AbortController();
    cancel.abort(new Error('already revoked'));
    await assertRejects(
      () =>
        network.stream(
          { ...authority(), signal: cancel.signal },
          server.origin,
          {},
          limits,
        ),
      Error,
      'already revoked',
    );
    assertEquals(server.hits, ['/late', '/head', '/empty', '/error']);
  } finally {
    more.resolve();
    await server.close();
  }
});

Deno.test('authority and request abort revoke pending or unread stream bodies with the caller reason', async () => {
  const server = fixture(parked);
  try {
    for (const source of ['authority', 'request']) {
      for (const pending of [false, true]) {
        const cancel = new AbortController();
        const context = authority();
        if (source === 'authority') context.signal = cancel.signal;
        const lease = await createNetwork().stream(
          context,
          server.origin,
          source === 'request' ? { signal: cancel.signal } : {},
          limits,
        );
        const reader = lease.response.body!.getReader();
        try {
          let read: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
          if (pending) {
            assertEquals(decoder.decode((await reader.read()).value), 'first');
            read = reader.read();
          }
          cancel.abort(new Error(`revoked ${source}`));
          await assertRejects(
            () => read ?? reader.read(),
            Error,
            `revoked ${source}`,
          );
        } finally {
          reader.releaseLock();
          await lease.close();
        }
      }
    }
    await eventually(() => server.closed === 4);
    assertEquals(server.hits.length, 4);
  } finally {
    await server.close();
  }
});

Deno.test('explicit close is idempotent during a read and body cancellation releases unread leases', async () => {
  const server = fixture(parked);
  try {
    const network = createNetwork();
    const lease = await network.stream(authority(), server.origin, {}, limits);
    const reader = lease.response.body!.getReader();
    await reader.read();
    const pending = reader.read();
    const rejected = assertRejects(() => pending, DOMException, 'closed');
    await Promise.all([lease.close(), lease.close(), rejected]);
    reader.releaseLock();
    const unread = await network.stream(authority(), server.origin, {}, limits);
    await unread.response.body!.cancel();
    await unread.close();
    await eventually(() => server.closed === 2);
  } finally {
    await server.close();
  }
});

Deno.test('stream open budget bounds headers, DNS, redirect chains and rate waits without hidden retries', async () => {
  const server = fixture(async (conn, path) => {
    if (path === '/redirect') {
      await write(
        conn,
        'HTTP/1.1 302 Found\r\nLocation: /redirect\r\nContent-Length: 0\r\n\r\n',
      );
    } else await untilClosed(conn);
  });
  try {
    await assertRejects(
      () =>
        createNetwork().stream(authority(), server.origin, {}, {
          ...limits,
          openTimeoutMs: 100,
        }),
      Error,
      'timed out',
    );
    await eventually(() => server.closed === 1);
    assertEquals(server.hits.length, 1);
    await assertRejects(
      () =>
        createNetwork({
          resolve: () => new Promise(() => {}),
        }).stream(authority(), server.origin, {}, {
          ...limits,
          openTimeoutMs: 100,
        }),
      Error,
      'timed out',
    );
    const network = createNetwork();
    const context = { ...authority(), ratePerMinute: 1 };
    await assertRejects(
      () =>
        network.stream(context, `${server.origin}/redirect`, {}, {
          ...limits,
          openTimeoutMs: 100,
        }),
      Error,
      'timed out',
    );
    assertEquals(server.hits, ['/', '/redirect']);
    await assertRejects(
      () =>
        createNetwork().stream(
          authority(),
          `${server.origin}/redirect`,
          {},
          limits,
        ),
      Error,
      'Too many',
    );
    assertEquals(
      server.hits.length,
      8,
      'six hops under the unchanged five-redirect limit',
    );
  } finally {
    await server.close();
  }
});

Deno.test('stream body truncation is an error, clean EOF is complete, and neither reconnects', async () => {
  const server = fixture(async (conn, path) => {
    await write(
      conn,
      `HTTP/1.1 200 OK\r\nContent-Length: ${
        path === '/ok' ? 5 : 99
      }\r\n\r\nfirst`,
    );
  });
  try {
    const network = createNetwork();
    for (const path of ['/ok', '/truncated']) {
      const lease = await network.stream(
        authority(),
        `${server.origin}${path}`,
        {},
        limits,
      );
      try {
        if (path === '/ok') assertEquals(await lease.response.text(), 'first');
        else await assertRejects(() => lease.response.text());
      } finally {
        await lease.close();
      }
    }
    assertEquals(server.hits, ['/ok', '/truncated']);
  } finally {
    await server.close();
  }
});

Deno.test('stream shares host policy and original trust: no private redirect or mixed/unspecified destination is contacted', async () => {
  const server = fixture(async (conn) => {
    await write(
      conn,
      `HTTP/1.1 302 Found\r\nLocation: http://other.test:${
        new URL(server.origin).port
      }/secret\r\nContent-Length: 0\r\n\r\n`,
    );
  });
  try {
    const network = createNetwork({
      resolve: () => Promise.resolve(['127.0.0.1']),
    });
    const context = {
      ...authority(),
      trustedHosts: ['melofon.home', 'other.test'],
    };
    await assertRejects(
      () => network.stream(context, server.origin, {}, limits),
      Error,
      'destination refused',
    );
    for (
      const addresses of [['8.8.8.8', '10.0.0.1'], ['0.0.0.0'], ['::'], [
        '::ffff:0.0.0.0',
      ]]
    ) {
      await assertRejects(
        () =>
          createNetwork({ resolve: () => Promise.resolve(addresses) })
            .stream(
              { ...context, trustedHosts: [] },
              server.origin,
              {},
              limits,
            ),
        Error,
        'destination refused',
      );
    }
    for (
      const url of [
        'ftp://melofon.home/',
        'http://user:pass@melofon.home/',
        'http://forbidden.test/',
      ]
    ) {
      await assertRejects(
        () =>
          network.stream(
            {
              ...context,
              hosts: (url) => url.hostname === 'melofon.home',
            },
            url,
            {},
            limits,
          ),
        Error,
        'not granted',
      );
    }
    assertEquals(
      server.hits,
      ['/'],
      'forbidden destinations never receive a request',
    );
  } finally {
    await server.close();
  }
});

Deno.test('stream backpressure bounds unread transport buffering rather than draining the live producer', async () => {
  const chunk = new Uint8Array(65536).fill(42);
  const total = 32 * 1024 * 1024;
  let sent = 0;
  const server = fixture(async (conn) => {
    await write(conn, `HTTP/1.1 200 OK\r\nContent-Length: ${total}\r\n\r\n`);
    while (sent < total) {
      await write(conn, chunk);
      sent += chunk.length;
    }
  });
  try {
    const lease = await createNetwork().stream(
      authority(),
      server.origin,
      {},
      { ...limits, idleTimeoutMs: 100 },
    );
    try {
      await sleep(200);
      assert(
        sent < total,
        'unread response must not consume the complete producer',
      );
      const reader = lease.response.body!.getReader();
      let received = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        assert(part.value.every((byte) => byte === 42));
        received += part.value.length;
      }
      reader.releaseLock();
      assertEquals(received, total, 'slow consumption loses no bytes');
    } finally {
      await lease.close();
    }
  } finally {
    await server.close();
  }
});

Deno.test('network stream settings keep lookup defaults separate and apply to subsequent opens', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore(`${dir}/data`);
  const state = createState(store);
  const network = createNetwork({ state });
  const server = fixture(untilClosed);
  try {
    assertEquals(await state.getTyped('net.streamOpenTimeoutSeconds'), 10);
    assertEquals(await state.getTyped('net.streamBodyIdleSeconds'), 10);
    assertEquals(await state.getTyped('net.streamBufferBytes'), 65536);
    assertEquals(await state.getTyped('lookups.requestTimeoutSeconds'), 10);
    assertEquals(await state.getTyped('lookups.requestAttempts'), 2);
    await assertRejects(() => state.set('net.streamOpenTimeoutSeconds', '0'));
    await assertRejects(() => state.set('net.streamBodyIdleSeconds', '-1'));
    await assertRejects(() => state.set('net.streamBufferBytes', '1.5'));
    await state.set('net.streamOpenTimeoutSeconds', '0.1');
    await assertRejects(
      () => network.stream(authority(), server.origin),
      Error,
      'timed out',
    );
    await assertRejects(
      () =>
        network.stream(authority(), server.origin, {}, {
          openTimeoutMs: Infinity,
          idleTimeoutMs: 1,
        }),
      Error,
      'positive and finite',
    );
    assertEquals(server.hits.length, 1);
  } finally {
    await server.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
