// tests/raop-ffi.test.ts — the FFI transport end-to-end, all in-process:
// Deno.dlopen loads libmelofon_raop, a fake RAOP device (tests/helpers/
// fake-raop.ts, same wire shape as helper/raop/test/fake_raop.py) answers
// RTSP and counts RTP packets. start → connected → PCM streams → volume →
// teardown → stopped. Gated on the built library existing, so dev machines
// without `make -C helper/raop` still run the suite green. Sanitizers off:
// the dlopen'd library is process-lifetime by design.
import { assert, assertEquals, assertRejects } from '@std/assert';
import { createFfiSpawn } from '../src/boots/raop-ffi.ts';
import { startFakeRaop } from './helpers/fake-raop.ts';

const LIB_PATH = decodeURIComponent(
  new URL('../helper/raop/libmelofon_raop.so', import.meta.url).pathname,
);
const HAVE_LIB = await Deno.stat(LIB_PATH).then(() => true).catch(() => false);

async function until(what: string, fn: () => boolean, timeoutMs = 15000) {
  const deadline = performance.now() + timeoutMs;
  while (!fn()) {
    if (performance.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

Deno.test({
  name: 'FFI transport streams to a fake RAOP device in-process',
  ignore: !HAVE_LIB,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const fake = await startFakeRaop();
    const events: [string, string | undefined][] = [];
    const transport = createFfiSpawn()((event, value) =>
      events.push([event, value])
    );
    try {
      await transport.send({
        cmd: 'start',
        host: '127.0.0.1',
        port: fake.port,
        name: 'FFI smoke',
        volume: 80,
      });
      await until(
        'connected',
        () => events.some(([e, v]) => e === 'state' && v === 'connected'),
      );

      // One second of PCM (silence encodes fine through the ALAC path).
      // The wire — not a 'streaming' event (raop.c raises it only on a
      // timing-dependent status path) — is the honest streaming signal.
      await transport.pcm(new Uint8Array(176400));
      await until(
        'RTP packets arrive',
        () => (fake.sessions[0]?.audioPackets ?? 0) > 100,
      );

      await transport.send({ cmd: 'volume', volume: 42 });
      await transport.send({ cmd: 'teardown' });
      await until(
        'stopped',
        () => events.some(([e, v]) => e === 'state' && v === 'stopped'),
      );

      const session = fake.sessions[0];
      assert(session !== undefined, 'one RTSP session');
      const methods = session.requests.map((r) => r.method);
      for (
        const expected of [
          'OPTIONS',
          'ANNOUNCE',
          'SETUP',
          'RECORD',
          'SET_PARAMETER',
          'TEARDOWN',
        ]
      ) {
        assert(
          methods.includes(expected),
          `missing RTSP ${expected}: ${methods}`,
        );
      }
      assertEquals(session.teardowns, 1);
      assert(
        session.volumeParams.some((v) => v.startsWith('volume: -17.')),
        `volume command missing: ${session.volumeParams}`,
      );
    } finally {
      await transport.close().catch(() => {});
      fake.close();
    }
  },
});

Deno.test({
  name: 'FFI transport: send on a closed transport rejects; close is memoized',
  ignore: !HAVE_LIB,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const fake = await startFakeRaop();
    const transport = createFfiSpawn()(() => {});
    try {
      await transport.send({
        cmd: 'start',
        host: '127.0.0.1',
        port: fake.port,
        name: 'closed-contract',
        volume: 50,
      });
      const first = transport.close();
      const second = transport.close();
      assert(first === second, 'close memoizes its promise');
      await first; // resolves: native cleanup proven
      await second; // a repeated close reuses the result
      await assertRejects(
        () => transport.send({ cmd: 'volume', volume: 10 }),
        Error,
        'closed transport',
      );
    } finally {
      fake.close();
    }
  },
});

Deno.test({
  name: 'FFI transport: a flush abandons a backpressured in-flight pcm write',
  ignore: !HAVE_LIB,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const fake = await startFakeRaop();
    const events: [string, string | undefined][] = [];
    const transport = createFfiSpawn()((event, value) =>
      events.push([event, value])
    );
    try {
      await transport.send({
        cmd: 'start',
        host: '127.0.0.1',
        port: fake.port,
        name: 'writegen',
        volume: 80,
      });
      await until(
        'connected',
        () => events.some(([e, v]) => e === 'state' && v === 'connected'),
      );
      // 4 s of PCM in one call: the ~2 s native cap parks the write in
      // backpressure, and realtime pacing would drain it over ~4 s.
      const started = performance.now();
      const pending = transport.pcm(new Uint8Array(4 * 176400));
      await new Promise((resolve) => setTimeout(resolve, 150));
      await transport.send({ cmd: 'flush' }); // bumps the write generation
      await pending; // must return promptly, not after the realtime drain
      const elapsed = performance.now() - started;
      assert(
        // The full drain would take ~4 s of realtime pacing; abandonment
        // returns in a few hundred ms. 3 s keeps the discrimination under
        // shared-host load.
        elapsed < 3000,
        `the flush abandoned the parked write (took ${elapsed}ms)`,
      );
      // The transport itself stays usable: only the stale call was cut.
      await transport.send({ cmd: 'volume', volume: 40 });
      await transport.send({ cmd: 'teardown' });
      await until(
        'stopped',
        () => events.some(([e, v]) => e === 'state' && v === 'stopped'),
      );
    } finally {
      await transport.close().catch(() => {});
      fake.close();
    }
  },
});

Deno.test({
  name: 'FFI transport: close abandons a backpressured in-flight pcm write',
  ignore: !HAVE_LIB,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const fake = await startFakeRaop();
    const events: [string, string | undefined][] = [];
    const transport = createFfiSpawn()((event, value) =>
      events.push([event, value])
    );
    try {
      await transport.send({
        cmd: 'start',
        host: '127.0.0.1',
        port: fake.port,
        name: 'writegen-close',
        volume: 80,
      });
      await until(
        'connected',
        () => events.some(([e, v]) => e === 'state' && v === 'connected'),
      );
      const started = performance.now();
      const pending = transport.pcm(new Uint8Array(4 * 176400));
      await new Promise((resolve) => setTimeout(resolve, 150));
      const closing = transport.close(); // bumps the write generation first
      await pending;
      const elapsed = performance.now() - started;
      assert(
        elapsed < 3000, // ~4 s would be a full realtime drain; see above
        `the close abandoned the parked write (took ${elapsed}ms)`,
      );
      await closing; // native cleanup still proven
      assertEquals(
        fake.sessions[0]?.teardowns,
        1,
        'close tore the session down',
      );
    } finally {
      fake.close();
    }
  },
});

Deno.test({
  name:
    'FFI cancelPcm fences parked writes while preserving connection, feed and no-FLUSH peer state',
  ignore: !HAVE_LIB,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const fake = await startFakeRaop();
    let connected = false;
    const transport = createFfiSpawn()((event, value) => {
      if (event === 'state' && value === 'connected') connected = true;
    });
    try {
      await transport.send({
        cmd: 'start',
        host: '127.0.0.1',
        port: fake.port,
        volume: 50,
      });
      await until('connected', () => connected);
      let settled = false;
      const pending = transport.pcm(new Uint8Array(4 * 176400)).then(() =>
        settled = true
      );
      await until(
        'actual feed with RTP and parked write',
        () =>
          transport.ownsSharedFeed() &&
          (fake.sessions[0]?.audioPackets ?? 0) > 5 && !settled,
      );
      transport.cancelPcm();
      await until('canceled parked write settles', () => settled, 1000);
      await pending;
      assert(
        transport.ownsSharedFeed(),
        'cancellation does not optimistically release token',
      );
      assertEquals(fake.sessions.length, 1);
      assertEquals(fake.sessions[0].flushes, 0);
      assertEquals(fake.sessions[0].teardowns, 0);
      await transport.send({ cmd: 'volume', volume: 40 });
      await until(
        'retained connection observes new command',
        () =>
          fake.sessions[0].volumeParams.some((v) =>
            v.startsWith('volume: -18.')
          ),
      );
    } finally {
      await transport.close();
      fake.close();
    }
  },
});
