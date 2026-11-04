import { assert, assertEquals } from '@std/assert';
import {
  createFfiSpawn,
  shutdownNativeLogging,
} from '../src/boots/raop-ffi.ts';
import { createSpeakerCredentials } from '../src/speaker-credentials.ts';
import { createOutputs } from '../src/player.ts';
import { createSecrets } from '../src/secrets.ts';
import type { Store } from '../src/store/index.ts';
import { NATIVE_CHANGED } from './helpers/native-changes.ts';
import { appLogger, installLogger } from '../src/logging.ts';
import { captureLogs } from './helpers/logging.ts';

const symbols = {
  raop_new: { parameters: [], result: 'pointer' },
  raop_free: { parameters: ['pointer'], result: 'i32', nonblocking: true },
  raop_teardown: { parameters: ['pointer'], result: 'i32' },
  raop_credential_poll: {
    parameters: ['pointer', 'buffer', 'buffer', 'usize'],
    result: 'i32',
  },
  raop_credential_ack: { parameters: ['pointer', 'u64'], result: 'i32' },
  raop_log_consumer: { parameters: ['i32'], result: 'i32' },
  raop_log_poll: { parameters: ['buffer', 'usize'], result: 'i32' },
  probe_pairing_change: { parameters: ['buffer'], result: 'i32' },
  probe_pairing_clear: { parameters: ['i32'], result: 'i32' },
  probe_pairing_verify: { parameters: ['i32', 'i32'], result: 'i32' },
  probe_pairing_pending: { parameters: [], result: 'u64' },
  probe_pairing_overflow_events: { parameters: [], result: 'i32' },
} as const;
const encoder = new TextEncoder();
const key = () =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(64)),
    (n) => n.toString(16).padStart(2, '0'),
  ).join('');
const cstr = (value: string) => encoder.encode(value + '\0');

async function buildProbe() {
  const dir = await Deno.makeTempDir({ prefix: 'pairing-export-' });
  try {
    const pc = await new Deno.Command('pkg-config', {
      args: [
        '--cflags',
        '--libs',
        'libevent',
        'libavcodec',
        'libavformat',
        'libavfilter',
        'libavutil',
        'json-c',
        'libsodium',
        'libplist-2.0',
        'libgcrypt',
        'uuid',
        'libcurl',
      ],
    }).output();
    assertEquals(pc.code, 0, 'native package flags');
    const sources = [
      'test/probe_pairing_export.c',
      'player.c',
      'stub/stubs.c',
      'vendor/outputs/rtp_common.c',
      'vendor/evrtsp/rtsp.c',
      'vendor/pair_ap/pair.c',
      'vendor/pair_ap/pair_fruit.c',
      'vendor/pair_ap/pair_homekit.c',
      'vendor/pair_ap/pair-tlv.c',
      'vendor/transcode.c',
      'vendor/misc.c',
    ];
    const path = `${dir}/probe.so`;
    const result = await new Deno.Command('cc', {
      cwd: new URL('../helper/raop/', import.meta.url),
      args: [
        '-shared',
        '-fPIC',
        '-O1',
        '-g',
        '-DHAVE_CONFIG_H',
        '-D_GNU_SOURCE',
        '-DCONFIG_GCRYPT=1',
        '-I',
        'stub',
        '-I',
        'vendor',
        '-I',
        'vendor/outputs',
        '-I',
        'vendor/evrtsp',
        '-Wl,-z,nodelete',
        '-o',
        path,
        ...sources,
        ...new TextDecoder().decode(pc.stdout).trim().split(/\s+/),
        '-levent_pthreads',
        '-lgpg-error',
        '-lunistring',
        '-lpthread',
        '-lm',
      ],
    }).output();
    // Build output contains source names, never runtime credentials.
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    const lib = Deno.dlopen(path, symbols);
    return {
      lib,
      path,
      async close() {
        lib.close();
        await Deno.remove(dir, { recursive: true });
      },
    };
  } catch (error) {
    await Deno.remove(dir, { recursive: true });
    throw error;
  }
}

async function until(predicate: () => boolean) {
  const deadline = performance.now() + 10000;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error('Pairing receipt timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

Deno.test({
  name:
    'native pairing mailbox retains full keys and tombstones across overflow delayed drain and exact ack',
  ignore: !NATIVE_CHANGED,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const probe = await buildProbe();
    const s = probe.lib.symbols;
    const debug = Deno.env.get('MELOFON_RAOP_DEBUG');
    Deno.env.set('MELOFON_RAOP_DEBUG', '1');
    assertEquals(s.raop_log_consumer(1), 0);
    const a = s.raop_new();
    const b = s.raop_new();
    assert(a && b);
    const keys = [key(), key(), key()];
    const revision = new BigUint64Array(1), bytes = new Uint8Array(129);
    const poll = (handle = b, cap = 129) =>
      s.raop_credential_poll(handle, revision, bytes, BigInt(cap));
    let complete = false;
    try {
      assertEquals(poll(), 0);
      assertEquals(s.probe_pairing_change(cstr(keys[0])), 0);
      assertEquals(s.probe_pairing_overflow_events(), 0);
      await new Promise((resolve) => setTimeout(resolve, 75));
      bytes.fill(0x5a);
      assertEquals(poll(b, 128), -2);
      assert(bytes.every((n) => n === 0x5a));
      assertEquals(poll(a), 0, 'per-handle isolation');
      assertEquals(poll(), 1);
      const first = revision[0];
      assert(first > 0n);
      assert(new TextDecoder().decode(bytes.subarray(0, 128)) === keys[0]);
      assertEquals(bytes[128], 0);
      assertEquals(s.probe_pairing_change(cstr('invalid')), -1);
      // Producer copies before returning. Later updates never overwrite a lease.
      const copied = cstr(keys[1]);
      assertEquals(s.probe_pairing_change(copied), 0);
      copied.fill(0);
      assertEquals(poll(), 1);
      assertEquals(revision[0], first);
      assert(new TextDecoder().decode(bytes.subarray(0, 128)) === keys[0]);
      assertEquals(s.raop_credential_ack(b, first + 1n), 0);
      assertEquals(s.raop_credential_ack(b, first), 1);
      assertEquals(poll(), 1);
      assert(revision[0] > first);
      assert(new TextDecoder().decode(bytes.subarray(0, 128)) === keys[1]);
      const second = revision[0];
      for (let i = 0; i < 100; i++) {
        assertEquals(s.probe_pairing_change(cstr(keys[2])), 0);
      }
      assertEquals(s.probe_pairing_change(null), 0);
      assertEquals(s.raop_credential_ack(b, first), 0);
      assertEquals(s.raop_credential_ack(b, second), 1);
      assertEquals(poll(b, 1), 2);
      assert(revision[0] > second + 100n);
      assertEquals(bytes[0], 0);
      assertEquals(s.raop_credential_ack(b, revision[0]), 1);
      assertEquals(poll(), 0);
      for (const step of [1, 2]) {
        for (const code of [0, 500, 403]) {
          assertEquals(
            s.probe_pairing_verify(step, code),
            code === 403 ? 1 : 0,
          );
          assertEquals(poll(), code === 403 ? 2 : 0);
          if (code === 403) {
            assertEquals(s.raop_credential_ack(b, revision[0]), 1);
          }
        }
      }
      assertEquals(
        s.probe_pairing_verify(3, 0),
        1,
        'malformed local key clears',
      );
      assertEquals(poll(), 2);
      assertEquals(s.raop_credential_ack(b, revision[0]), 1);
      for (const code of [200, 401, 403, 500]) {
        assertEquals(s.probe_pairing_clear(code), code === 500 ? 0 : 1);
        assertEquals(poll(), code === 500 ? 0 : 2);
        if (code !== 500) {
          assertEquals(s.raop_credential_ack(b, revision[0]), 1);
        }
      }
      assertEquals(s.probe_pairing_change(cstr(keys[2])), 0);
      assertEquals(s.raop_teardown(b), 0);
      await new Promise((resolve) => setTimeout(resolve, 75));
      assertEquals(poll(), 1, 'teardown does not erase unacknowledged state');
      assert(new TextDecoder().decode(bytes.subarray(0, 128)) === keys[2]);
      const log = new Uint8Array(32768);
      for (;;) {
        const n = s.raop_log_poll(log, BigInt(log.length));
        assert(n >= 0);
        if (!n) break;
        const record = new TextDecoder().decode(log.subarray(0, n));
        assert(
          keys.every((value) => !record.includes(value)),
          'no native diagnostic leak',
        );
      }
      complete = true;
    } finally {
      bytes.fill(0);
      assertEquals(await s.raop_free(b), 0);
      assertEquals(await s.raop_free(a), 0);
      if (complete) {
        assertEquals(
          s.probe_pairing_change(null),
          -1,
          'released handle cannot receive updates',
        );
      }
      s.raop_log_consumer(0);
      if (debug === undefined) Deno.env.delete('MELOFON_RAOP_DEBUG');
      else Deno.env.set('MELOFON_RAOP_DEBUG', debug);
      await probe.close();
    }
  },
});

Deno.test({
  name:
    'FFI pairing receipt retries failures reaches private core and fences close and forget races',
  ignore: !NATIVE_CHANGED,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    shutdownNativeLogging();
    const probe = await buildProbe();
    const prior = Deno.env.get('MELOFON_RAOP_LIB');
    Deno.env.set('MELOFON_RAOP_LIB', probe.path);
    const previousLogger = appLogger();
    const logs = captureLogs();
    installLogger(logs.log);
    const outputs = createOutputs();
    const credentials = createSpeakerCredentials({
      store: {} as Store['speakers'],
      secrets: createSecrets(undefined),
      current: (id) =>
        outputs.get(id)
          ? { revision: outputs.revision(id), adopted: false }
          : null,
    });
    outputs.register({
      id: 'stable-speaker',
      name: 'Private',
      type: 'AirPlay',
      selected: false,
      volume: 50,
    });
    const events: unknown[] = [];
    let attempts = 0, accepted = 0, release!: () => void;
    let held = new Promise<void>((resolve) => release = resolve);
    const values = [key(), key()];
    const spawn = createFfiSpawn();
    let driver = spawn((...event) => events.push(event), async (change) => {
      attempts++;
      if (attempts === 1) throw new Error(change.key ?? 'private failure');
      await held;
      assert(change.isCurrent());
      await credentials.set('stable-speaker', 'pairing-key', change.key);
      accepted++;
    });
    const s = probe.lib.symbols;
    try {
      assertEquals(s.probe_pairing_change(cstr(values[0])), 0);
      await until(() => attempts === 2);
      assertEquals(accepted, 0);
      assert(
        s.probe_pairing_pending() > 0n,
        'failed or held receipt is not acknowledged',
      );
      assertEquals(
        await credentials.get('stable-speaker', 'pairing-key'),
        null,
      );
      assertEquals(s.probe_pairing_change(cstr(values[1])), 0);
      assertEquals(s.probe_pairing_overflow_events(), 0);
      release();
      await until(() => accepted === 2 && s.probe_pairing_pending() === 0n);
      assert(
        await credentials.get('stable-speaker', 'pairing-key') === values[1],
      );
      assertEquals(s.probe_pairing_change(null), 0);
      await until(() => accepted === 3 && s.probe_pairing_pending() === 0n);
      assertEquals(
        await credentials.get('stable-speaker', 'pairing-key'),
        null,
      );
      assert(!JSON.stringify(events).includes(values[0]));
      assert(!JSON.stringify(events).includes(values[1]));
      await driver.transport.close();
      // A late asynchronous consumer cannot ack a freed handle or recreate a
      // forgotten stable speaker. The core lifetime fence is independent of FFI.
      let entered = false, late = false;
      held = new Promise<void>((resolve) => release = resolve);
      driver = spawn(() => {}, async (change) => {
        entered = true;
        await held;
        assert(!change.isCurrent());
        try {
          await credentials.set('stable-speaker', 'pairing-key', change.key);
        } catch {
          late = true;
        }
      });
      assertEquals(s.probe_pairing_change(cstr(values[0])), 0);
      await until(() => entered);
      outputs.unregister('stable-speaker');
      credentials.release('stable-speaker');
      const closing = driver.transport.close();
      release();
      await closing;
      await until(() => late);
      assertEquals(s.probe_pairing_pending(), 0n);
      assertEquals(outputs.get('stable-speaker'), null);
    } finally {
      release();
      await driver.transport.close();
      shutdownNativeLogging();
      await logs.log.flush();
      assert(values.every((value) => !logs.lines.join('\n').includes(value)));
      assert(values.every((value) => !logs.log.text().includes(value)));
      installLogger(previousLogger);
      if (prior === undefined) Deno.env.delete('MELOFON_RAOP_LIB');
      else Deno.env.set('MELOFON_RAOP_LIB', prior);
      await probe.close();
    }
  },
});
