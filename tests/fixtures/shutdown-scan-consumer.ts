import { assertEquals } from '@std/assert';
import { startServer } from '../../src/server.ts';
import { openStore, type Store } from '../../src/store/index.ts';
import { reservePorts } from '../helpers/ports.ts';

Deno.test('server joins an admitted scan publication before store close begins', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'shutdown-scan-' });
  using ports = reservePorts(3);
  const [port, own, ws] = ports.ports;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const publication = Promise.withResolvers<void>();
  let store!: Store;
  let storeClosing = false, lateWrites = 0, armed = false;
  ports.release();
  const server = await startServer({
    exit() {},
    env: {
      MELOFON_DATA: dir,
      MELOFON_SECRET: 'shutdown-scan-secret',
      MELOFON_USER: 'admin',
      MELOFON_PASSWORD: 'shutdown-scan-password',
      MELOFON_LISTEN: `0.0.0.0:${port}`,
      MELOFON_LISTEN_owntone: `${own},${ws}`,
      MELOFON_AIRPLAY_MDNS: 'off',
    },
    async openStore(...args) {
      store = await openStore(...args);
      const replace = store.catalog.replaceCatalog;
      store.catalog.replaceCatalog = async (...args) => {
        if (!armed) return replace(...args);
        entered.resolve();
        await release.promise;
        if (storeClosing) lateWrites++;
        try {
          return await replace(...args);
        } finally {
          publication.resolve();
        }
      };
      const close = store.close;
      store.close = () => {
        storeClosing = true;
        return close();
      };
      return store;
    },
  });
  const origin = `http://melofon.home:${port}`;
  const producersClosing = Promise.withResolvers<void>();
  const closePlayers = server.players.close;
  server.players.close = async () => {
    await closePlayers();
    producersClosing.resolve();
  };
  try {
    const login = await fetch(`${origin}/api/v1/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({
        username: 'admin',
        password: 'shutdown-scan-password',
        use: 'bearer',
        deviceName: 'Scan shutdown',
      }),
    });
    assertEquals(login.status, 200);
    const { key } = await login.json();
    armed = true;
    const response = await fetch(`${origin}/api/v1/admin/scans`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ mode: 'full' }),
    });
    assertEquals(response.status, 202);
    await response.body?.cancel();
    await entered.promise;
    const closing = server.shutdown();
    assertEquals(server.shutdown(), closing);
    // Player release marks the producer phase. Keep the publication held while
    // shutdown has an opportunity to advance to the store.
    await producersClosing.promise;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const closedEarly = storeClosing;
    release.resolve();
    await publication.promise;
    await closing;
    assertEquals(closedEarly, false);
    assertEquals(lateWrites, 0);
    assertEquals(storeClosing, true);
    const reopened = await openStore(dir);
    await reopened.close();
  } finally {
    release.resolve();
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});
