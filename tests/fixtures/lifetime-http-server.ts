// Faults live only in this cold child. HTTP, owners, Workers and storage are real.
import { assert, assertEquals } from '@std/assert';
import { startServer } from '../../src/server.ts';
import { openStore } from '../../src/store/index.ts';
import { eventually } from '../helpers/lookup.ts';

const [mode, dir, port, own, ws] = Deno.args;
const events: Record<string, unknown>[] = [];
function event(name: string, facts: Record<string, unknown> = {}) {
  events.push({ name, ...facts });
  Deno.writeTextFileSync(`${dir}/events.json`, JSON.stringify(events));
}
function exists(name: string) {
  try {
    Deno.statSync(`${dir}/${name}`);
    return true;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    return false;
  }
}
async function held(name: string) {
  event(`${name}-entered`);
  await eventually(() => exists('release'), 60000);
}

Deno.test('cold production lifetime consumer', async () => {
  const active = new Set<Worker>();
  let workers = 0, storeClosing = false, storeClosed = false;
  const NativeWorker = globalThis.Worker;
  globalThis.Worker = class extends NativeWorker {
    constructor(...args: ConstructorParameters<typeof Worker>) {
      super(...args);
      workers++;
      active.add(this);
    }
    override terminate() {
      super.terminate();
      active.delete(this);
    }
  };
  const exited = Promise.withResolvers<number>();
  const onSignal = () => event('sigterm');
  Deno.addSignalListener('SIGTERM', onSignal);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    try {
      server = await startServer({
        env: {
          MELOFON_DATA: `${dir}/db`,
          MELOFON_SECRET: 'lifetime-http-secret',
          MELOFON_USER: 'admin',
          MELOFON_PASSWORD: 'lifetime-http-password',
          MELOFON_LISTEN: `0.0.0.0:${port}`,
          MELOFON_LISTEN_owntone: `${own},${ws}`,
          MELOFON_AIRPLAY_MDNS: 'off',
        },
        exit(code) {
          event('exit', { code, activeWorkers: active.size, storeClosed });
          exited.resolve(code);
        },
        acquired(name) {
          if (name !== 'serving') return;
          event('serving', { workers, activeWorkers: active.size });
          if (mode === 'startup') throw new Error('acceptance startup fault');
        },
        async openStore(...args) {
          const store = await openStore(...args);
          // Observe every store port, not just the publication deliberately held.
          for (const [groupName, group] of Object.entries(store)) {
            if (!group || typeof group !== 'object') continue;
            for (const [method, fn] of Object.entries(group)) {
              if (typeof fn !== 'function') continue;
              Object.assign(group, {
                [method]: (...args: unknown[]) => {
                  if (storeClosing) {
                    event('late-store-call', { groupName, method });
                  }
                  return fn(...args);
                },
              });
            }
          }
          const replace = store.catalog.replaceCatalog;
          store.catalog.replaceCatalog = async (...args) => {
            if (mode !== 'scan' || !exists('arm')) return replace(...args);
            await held('scan');
            const result = await replace(...args);
            event('scan-settled');
            return result;
          };
          const getSong = store.catalog.getSong;
          store.catalog.getSong = async (...args) => {
            if (mode !== 'prepare' || !exists('arm')) return getSong(...args);
            await held('prepare');
            const result = await getSong(...args);
            event('prepare-settled');
            return result;
          };
          const save = store.players.saveChanges;
          store.players.saveChanges = async (changes) => {
            if (mode !== 'saves' || !exists('arm')) return save(changes);
            event('save-attempt', { changes });
            if (!exists('recover')) throw new Error('acceptance save failure');
            await save(changes);
            event('save-landed', { changes });
          };
          const close = store.close;
          store.close = async () => {
            event('store-closing', { activeWorkers: active.size });
            storeClosing = true;
            await close();
            storeClosed = true;
            event('store-closed');
          };
          return store;
        },
      });
    } catch (error) {
      if (mode !== 'startup') throw error;
      assert(String(error).includes('acceptance startup fault'));
      assert(workers > 0, 'startup really acquired Workers');
      assertEquals(active.size, 0);
      assertEquals(storeClosed, true);
      // Prove release before this process exits: OS teardown cannot satisfy it.
      for (const at of [port, own, ws]) {
        const listener = Deno.listen({ hostname: '0.0.0.0', port: Number(at) });
        listener.close();
      }
      const reopened = await openStore(`${dir}/db`);
      await reopened.close();
      event('rollback', {
        workers,
        activeWorkers: active.size,
        storeClosed,
        rebound: 3,
        reopened: true,
      });
      return;
    }
    assertEquals(await exited.promise, 0);
    assertEquals(active.size, 0);
    assertEquals(storeClosed, true);
    assertEquals(events.filter((e) => e.name === 'late-store-call'), []);
  } finally {
    Deno.removeSignalListener('SIGTERM', onSignal);
    await server?.shutdown();
    globalThis.Worker = NativeWorker;
  }
  // The child test sanitizer also checks real Worker/timer/op settlement.
});
