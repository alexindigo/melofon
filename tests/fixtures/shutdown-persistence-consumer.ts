import { assert, assertEquals, assertRejects } from '@std/assert';
import { startServer } from '../../src/server.ts';
import { openStore } from '../../src/store/index.ts';
import { appLogger, createLogger, installLogger } from '../../src/logging.ts';
import { reservePorts } from '../helpers/ports.ts';
import { observeHeartbeat } from '../helpers/heartbeat.ts';

const mode = Deno.args[0];
Deno.test(mode, async () => {
  using observed = observeHeartbeat();
  const dir = await Deno.makeTempDir({ prefix: 'melofon-shutdown-retry-' });
  const previousLogger = appLogger();
  const logger = createLogger({ sinks: { stdout() {}, stderr() {} } });
  installLogger(logger);
  using reserved = reservePorts(3);
  const [port, own, ws] = reserved.ports;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<number>();
  const attempts: string[] = [];
  const saved: number[] = [];
  let household = false, householdAttempts = 0, storeClosed = false;
  let beforeClose: number | undefined;
  let armed = false;
  const recover = mode !== 'signal-exhaustion';
  reserved.release();
  const server = await startServer({
    exit(code) {
      assert(storeClosed, 'the real store must close before exit');
      assertEquals(observed.active.size, 0);
      exited.resolve(code);
    },
    env: {
      MELOFON_DATA: dir,
      MELOFON_SECRET: 'shutdown-retry-secret',
      MELOFON_USER: 'admin',
      MELOFON_PASSWORD: 'shutdown-retry-password',
      MELOFON_LISTEN: `0.0.0.0:${port}`,
      MELOFON_LISTEN_owntone: `${own},${ws}`,
      MELOFON_AIRPLAY_MDNS: 'off',
    },
    async openStore(dataDir, options) {
      const store = await openStore(dataDir, options);
      await store.state.set('persistence.retryBackoffMs', '[1]');
      await store.state.set('persistence.shutdownRetries', '2');
      const save = store.players.saveChanges;
      store.players.saveChanges = async (batch) => {
        if (armed) {
          observed.assertActive();
          attempts.push(JSON.stringify(batch));
          if (!household || ++householdAttempts <= 2 || !recover) {
            throw new Error('shutdown storage offline');
          }
          if (!saved.length) {
            entered.resolve();
            await release.promise;
          }
        }
        await save(batch);
        if (armed) saved.push(batch.players![0].volume!);
      };
      const close = store.close;
      store.close = async () => {
        observed.assertActive();
        beforeClose = (await store.players.list())[0].volume;
        await close();
        observed.assertActive();
        storeClosed = true;
      };
      return store;
    },
  });
  const closePlayers = server.players.close;
  server.players.close = async () => {
    try {
      await closePlayers();
    } finally {
      household = true;
    }
  };
  let shutdown: Promise<void> | undefined;
  try {
    armed = true;
    // Published commands succeed despite storage failure (decision row 31).
    await server.players.get(1).setVolume({ volume: 61 });
    await server.players.get(1).setVolume({ volume: 73 });
    assertEquals(server.players.get(1).playerView().volume, 73);
    if (mode === 'direct-recovery') {
      shutdown = server.shutdown();
      assertEquals(server.shutdown(), shutdown, 'termination is shared');
      await Promise.race([entered.promise, shutdown.catch(() => {})]);
    } else {
      Deno.kill(Deno.pid, 'SIGTERM');
      await Promise.race([entered.promise, exited.promise]);
    }
    if (recover) {
      assertEquals(
        storeClosed,
        false,
        'retained batches drain before store close',
      );
      observed.assertActive();
      release.resolve();
    }
    if (shutdown) {
      // The earlier engine drain failed; recovery must not hide that error.
      await assertRejects(() => shutdown!, AggregateError);
    } else {
      assertEquals(
        await exited.promise,
        1,
        'cleanup failures use the signal failure exit',
      );
    }
    assertEquals(storeClosed, true);
    assertEquals(householdAttempts, recover ? 4 : 3);
    const loss = logger.records({ limit: 1000 }).records.filter((row) =>
      row.event === 'persistence_shutdown_failed'
    );
    if (recover) {
      assertEquals(
        saved,
        [61, 73],
        'the two whole batches keep publication order',
      );
      assertEquals(
        new Set(attempts.slice(0, -1)).size,
        1,
        'retry the identical first batch',
      );
      assertEquals(beforeClose, 73);
      assertEquals(loss, []);
    } else {
      assertEquals(saved, []);
      assertEquals(beforeClose, 50);
      assertEquals(
        loss.length,
        1,
        'exhaustion is logged before the process exits',
      );
      assertEquals(loss[0].level, 'fatal');
      assertEquals(loss[0].fields.pendingWrites, 2);
      assertEquals(loss[0].fields.attempts, 3);
      assertEquals(loss[0].fields.batches, [
        'players:1(commandedAtMs,volume) speakers:',
        'players:1(commandedAtMs,volume) speakers:',
      ]);
    }
    // Fresh process read-back proves the actual DuckDB owner was released and
    // that the durable final value, not just a save callback, reached the store.
    const probe = await new Deno.Command(Deno.execPath(), {
      args: [
        'eval',
        '--frozen',
        '--cached-only',
        '--node-modules-dir=manual',
        `import { openStore } from './src/store/index.ts';
         const store = await openStore(${JSON.stringify(dir)});
         const volume = (await store.players.list())[0].volume;
         await store.close();
         if (volume !== ${
          recover ? 73 : 50
        }) throw new Error('lost final volume: ' + volume);`,
      ],
      stdout: 'piped',
      stderr: 'piped',
      signal: AbortSignal.timeout(10_000),
    }).output();
    assertEquals(probe.code, 0, new TextDecoder().decode(probe.stderr));
  } finally {
    release.resolve();
    await server.shutdown().catch(() => {});
    await logger.flush();
    installLogger(previousLogger);
    await Deno.remove(dir, { recursive: true });
  }
});
