import { assert, assertEquals, assertRejects } from '@std/assert';
import { createTestHttp } from './helpers/http.ts';
import { reservePorts } from './helpers/ports.ts';

function serve(handler: (request: Request) => Response | Promise<Response>) {
  using ports = reservePorts(1);
  const [port] = ports.ports;
  ports.release();
  const server = Deno.serve(
    { hostname: '0.0.0.0', port, onListen() {} },
    handler,
  );
  return { server, origin: `http://melofon.home:${port}` };
}

Deno.test('HTTP readiness: wait for health and a slow response without replaying a mutation', async () => {
  const gate = Promise.withResolvers<void>();
  const firstHealth = Promise.withResolvers<void>();
  let healthy = false;
  let mutations = 0;
  let healthChecks = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const { server, origin } = serve(async (request) => {
    if (new URL(request.url).pathname === '/_/health') {
      healthChecks++;
      // The mutation cannot publish healthy until this response is built.
      firstHealth.resolve();
      return Response.json({ ok: healthy }, { status: healthy ? 200 : 503 });
    }
    mutations++;
    timer = setTimeout(() => gate.resolve(), 5500);
    await Promise.all([gate.promise, firstHealth.promise]);
    healthy = true;
    return Response.json({ committed: true }, { status: 201 });
  });
  const http = createTestHttp(origin);
  try {
    const [response] = await Promise.all([
      http.request('/mutation', { method: 'POST' }),
      // Deliberately deliver the first probe after the mutation's delay. It
      // must still observe not-ready before the mutation publishes healthy.
      gate.promise.then(() => http.ready()),
    ]);
    assertEquals(response.status, 201);
    assertEquals(await response.json(), { committed: true });
    assertEquals(mutations, 1);
    assert(healthy && healthChecks > 1);
  } finally {
    clearTimeout(timer);
    gate.resolve();
    firstHealth.resolve();
    await server.shutdown();
  }
});

Deno.test('HTTP readiness: an outer hang bound cancels an in-flight state probe', async () => {
  const gate = Promise.withResolvers<void>();
  const { server, origin } = serve(async () => {
    await gate.promise;
    return Response.json({ ok: true });
  });
  const http = createTestHttp(origin, { safetyMs: 100 });
  try {
    await assertRejects(
      () => http.ready(),
      Error,
      'waiting for GET /_/health to report ok=true',
    );
  } finally {
    gate.resolve();
    await server.shutdown();
  }
});

Deno.test('HTTP readiness: request hang diagnostics name the operation without credentials', async () => {
  const gate = Promise.withResolvers<void>();
  const { server, origin } = serve(async () => {
    await gate.promise;
    return new Response(null, { status: 204 });
  });
  const http = createTestHttp(origin, { safetyMs: 100 });
  try {
    const error = await assertRejects(
      () => http.request('/mutation?p=secret', { method: 'POST' }),
      Error,
      'POST /mutation: HTTP response did not arrive within 100ms hang bound',
    );
    assert(!error.message.includes('secret'));
  } finally {
    gate.resolve();
    await server.shutdown();
  }
});

Deno.test('HTTP readiness: malformed health and HTTP errors fail without retrying', async () => {
  let calls = 0;
  const { server, origin } = serve(() => {
    calls++;
    return calls === 1
      ? Response.json({ wrong: true })
      : new Response(null, { status: 500 });
  });
  const http = createTestHttp(origin);
  try {
    await assertRejects(() => http.ready(), Error, 'invalid health response');
    assertEquals(calls, 1);
    await assertRejects(() => http.ready(), Error, 'health probe');
    assertEquals(calls, 2);
    const response = await http.request('/error');
    assertEquals(response.status, 500);
    await response.body?.cancel();
  } finally {
    await server.shutdown();
  }
});
