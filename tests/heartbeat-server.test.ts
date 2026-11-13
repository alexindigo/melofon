import { assert, assertEquals, assertRejects } from '@std/assert';
import { startServer } from '../src/server.ts';
import { observeHeartbeat } from './helpers/heartbeat.ts';
import { reservePorts } from './helpers/ports.ts';

Deno.test('server heartbeat survives startup and all shutdown work until the exit boundary', async () => {
  using observed = observeHeartbeat();
  using ports = reservePorts(3);
  const dir = await Deno.makeTempDir({ prefix: 'heartbeat-server-' });
  const [port, own, ws] = ports.ports;
  ports.release();
  let exited = false;
  try {
    const server = await startServer({
      env: {
        MELOFON_DATA: dir,
        MELOFON_USER: 'admin',
        MELOFON_PASSWORD: 'heartbeat-test',
        MELOFON_SECRET: 'heartbeat-secret',
        MELOFON_LISTEN: `0.0.0.0:${port}`,
        MELOFON_LISTEN_owntone: `${own},${ws}`,
        MELOFON_AIRPLAY_MDNS: 'off',
      },
      exit(code) {
        assertEquals(code, 0);
        assertEquals(observed.active.size, 0);
        exited = true;
      },
    });
    try {
      const heartbeat = [...observed.timers.keys()][0];
      assert(observed.active.has(heartbeat));
      assertEquals(observed.timers.get(heartbeat)?.ms, 50);
      assertEquals(observed.timers.get(heartbeat)?.unref, true);
      const response = await fetch(`http://melofon.home:${port}/_/health`);
      assertEquals(await response.json(), { ok: true });
    } finally {
      await server.shutdown();
    }
    assert(exited);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('failed server startup releases its heartbeat and the failed store lease', async () => {
  using observed = observeHeartbeat();
  const dir = await Deno.makeTempDir({ prefix: 'heartbeat-server-failure-' });
  try {
    await Deno.writeTextFile(`${dir}/not-a-directory`, 'fixture');
    await assertRejects(() =>
      startServer({ env: { MELOFON_DATA: `${dir}/not-a-directory` } })
    );
    assertEquals(observed.timers.size, 1);
    assertEquals(observed.active.size, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
