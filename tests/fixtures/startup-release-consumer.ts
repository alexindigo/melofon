import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { startServer } from '../../src/server.ts';
import { openStore } from '../../src/store/index.ts';
import { reservePorts } from '../helpers/ports.ts';

const acquisitions = [
  'store',
  'persistence',
  'logging settings',
  'media',
  'scan',
  'podcasts',
  'lookups',
  'output admission',
  'airplay devices',
  'native logging',
  'reports',
  'discovery',
  'players',
  'artwork background',
  'listeners',
  'unload handler',
  'SIGTERM',
  'SIGINT',
  'serving',
];
for (
  const fail of [
    ...acquisitions,
    'podcast initialization',
    'lookup initialization',
    'shutdown',
  ]
) {
  Deno.test(`production composition release: ${fail}`, async () => {
    const dir = await Deno.makeTempDir({ prefix: 'melofon-startup-release-' });
    using ports = reservePorts(3);
    const [port, own, ws] = ports.ports;
    const acquired: string[] = [];
    const exits: number[] = [];
    let storeReleased = 0;
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    let listenFailed = false;
    const serve = Deno.serve;
    Deno.serve = ((...args: Parameters<typeof Deno.serve>) => {
      // Keep unused numbers reserved across startup awaits. A listener takes
      // ownership only when it is actually about to bind.
      ports.release();
      const handle = serve(...args);
      const close = handle.shutdown.bind(handle);
      handle.shutdown = async () => {
        await close();
        if (fail === 'shutdown' && !listenFailed) {
          listenFailed = true;
          throw new Error('listener release failed');
        }
      };
      return handle;
    }) as typeof Deno.serve;
    try {
      const starting = startServer({
        exit: (code) => exits.push(code),
        env: {
          MELOFON_DATA: dir,
          MELOFON_SECRET: 'startup-test-secret',
          MELOFON_USER: 'admin',
          MELOFON_PASSWORD: 'startup-test-password',
          MELOFON_LISTEN: `0.0.0.0:${port}`,
          MELOFON_LISTEN_owntone: `${own},${ws}`,
          MELOFON_AIRPLAY_MDNS: 'off',
        },
        acquired(name) {
          acquired.push(name);
          if (name === fail) {
            if (fail === 'lookups') {
              for (const at of [port, own, ws]) {
                assertThrows(() => {
                  const contender = Deno.listen({
                    hostname: '0.0.0.0',
                    port: at,
                  });
                  contender.close();
                }, Deno.errors.AddrInUse);
              }
            }
            throw new Error(`fault after ${name}`);
          }
        },
        openStore: async (...args) => {
          const store = await openStore(...args);
          const close = store.close;
          store.close = async () => {
            // Early failure may precede every real listener. Transfer the held
            // reservations straight to this synchronous rebind probe, with no
            // await where an unrelated socket could claim their numbers.
            ports.release();
            for (const at of [port, own, ws]) {
              const socket = Deno.listen({ hostname: '0.0.0.0', port: at });
              socket.close();
            }
            await close();
            storeReleased++;
          };
          if (fail === 'podcast initialization') {
            store.podcasts.channels = () =>
              Promise.reject(new Error('podcast startup fault'));
          }
          if (fail === 'lookup initialization') {
            store.reference.purgeOrphans = () =>
              Promise.reject(new Error('lookup startup fault'));
          }
          return store;
        },
      });
      // Keep unexpected success owned, so a failed assertion cannot leak a server.
      const observed = starting.then((value) => {
        server = value;
        return value;
      });
      if (fail === 'shutdown') {
        const running = await observed;
        const response = await fetch(`http://melofon.home:${port}/_/health`);
        assertEquals(response.status, 200);
        await response.body?.cancel();
        await assertRejects(() => running.shutdown(), AggregateError);
        assertEquals(listenFailed, true);
      } else {
        await assertRejects(() => observed, Error);
        assert(acquired.length > 0);
        if (acquisitions.includes(fail)) assertEquals(acquired.at(-1), fail);
      }
      assertEquals(storeReleased, 1);
      assertEquals(exits, []);
      const reopened = await openStore(dir);
      await reopened.close();
    } finally {
      await server?.shutdown().catch(() => {});
      Deno.serve = serve;
      await Deno.remove(dir, { recursive: true });
    }
    // Deno's per-test resource/op sanitizer proves Workers and timers settled.
  });
}
