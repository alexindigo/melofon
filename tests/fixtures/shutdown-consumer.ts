import { assertEquals, assertRejects } from '@std/assert';
import { startServer } from '../../src/server.ts';
import { openStore } from '../../src/store/index.ts';
import {
  createFfiSpawn,
  raopFfiInternals,
  shutdownNativeLogging,
} from '../../src/boots/raop-ffi.ts';
import { reservePorts } from '../helpers/ports.ts';

if (Deno.args[0] === 'probe') {
  // A separate DuckDB process cannot open the database until its owner releases it.
  const store = await openStore(Deno.args[1]);
  assertEquals(await store.users.adminCount(), 1);
  await store.close();
} else {
  Deno.test('failed player release still quiesces every server-owned consumer', async () => {
    const dir = await Deno.makeTempDir({ prefix: 'melofon-shutdown-' });
    using reserved = reservePorts(3);
    const [port, own, ws] = reserved.ports;
    const exits: number[] = [];
    reserved.release();
    const server = await startServer({
      exit: (code) => exits.push(code),
      env: {
        MELOFON_DATA: dir,
        MELOFON_SECRET: 'shutdown-test-secret',
        MELOFON_USER: 'admin',
        MELOFON_PASSWORD: 'shutdown-test-password',
        MELOFON_LISTEN: `0.0.0.0:${port}`,
        MELOFON_LISTEN_owntone: `${own},${ws}`,
        MELOFON_AIRPLAY_MDNS: 'off',
      },
    });
    const engine = server.players.get(1);
    const close = engine.close;
    engine.close = async () => {
      await close();
      throw new Error('engine drain failed');
    };
    createFfiSpawn();
    // Observe the actual native consumer, not whether its JS release was called.
    const native = Deno.dlopen(raopFfiInternals.resolveLibPath(), {
      raop_log_consumer: { parameters: ['i32'], result: 'i32' },
    });
    try {
      await assertRejects(() => server.shutdown(), AggregateError);
      assertEquals(exits, [], 'cleanup errors propagate to the direct caller');
      const probe = await new Deno.Command(Deno.execPath(), {
        args: [
          'run',
          '--frozen',
          '--cached-only',
          '--node-modules-dir=manual',
          '--allow-net',
          '--allow-env',
          '--allow-read',
          '--allow-write',
          '--allow-ffi',
          '--allow-sys',
          'tests/fixtures/shutdown-consumer.ts',
          'probe',
          dir,
        ],
        stdout: 'piped',
        stderr: 'piped',
        signal: AbortSignal.timeout(10_000),
      }).output();
      assertEquals(probe.code, 0, new TextDecoder().decode(probe.stderr));
      assertEquals(
        native.symbols.raop_log_consumer(1),
        0,
        'native diagnostic ownership was released',
      );
      native.symbols.raop_log_consumer(0);
      // Deno's default op/resource sanitizer below proves report expiry is gone.
    } finally {
      shutdownNativeLogging();
      native.close();
      await Deno.remove(dir, { recursive: true });
    }
  });
}
