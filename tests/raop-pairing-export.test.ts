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
import {
  pairingKey,
  receiver,
  sleep,
  speakerConsumer,
  speakerMedia,
  until as consumerUntil,
} from './helpers/speaker-consumer.ts';
import { startFakeRaop } from './helpers/fake-raop.ts';
import type { AirplaySpawn } from '../src/boots/airplay-profile.ts';
import { createSecrets as secretsForPairing } from '../src/secrets.ts';

const symbols = {
  raop_new: { parameters: [], result: 'pointer' },
  raop_free: { parameters: ['pointer'], result: 'i32', nonblocking: true },
  raop_teardown: { parameters: ['pointer'], result: 'i32' },
  raop_pin: { parameters: ['pointer', 'buffer'], result: 'i32' },
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
  probe_pairing_restored: { parameters: ['buffer'], result: 'i32' },
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
      for (const pin of ['', '123', '12345', 'abcd']) {
        assertEquals(s.raop_pin(a, cstr(pin)), -1);
      }
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
    'HTTP pair and both PIN entry paths persist acknowledged native keys restore real native input and clear rejected keys',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    shutdownNativeLogging();
    const probe = await buildProbe(),
      oldPath = Deno.env.get('MELOFON_RAOP_LIB');
    Deno.env.set('MELOFON_RAOP_LIB', probe.path);
    const previous = appLogger(), logs = captureLogs();
    installLogger(logs.log);
    const dir = await Deno.makeTempDir({ prefix: 'pairing-consumer-' });
    await speakerMedia(dir);
    const root = crypto.randomUUID(), values = [pairingKey(), pairingKey()];
    let verifyEntered = false, releaseVerify!: () => void;
    const verifyBarrier = new Promise<void>((resolve) =>
      releaseVerify = resolve
    );
    const fake = await startFakeRaop({
      beforePairVerify: () => {
        verifyEntered = true;
        return verifyBarrier;
      },
    });
    const service = receiver(1, fake.port, { sf: '200' });
    let t: Awaited<ReturnType<typeof speakerConsumer>> | undefined;
    const visible: string[] = [];
    let submitted = 0;
    let releaseSave = () => {};
    // Product probe/native mailbox are real. Only fruit setup is replaced at
    // the test seam: this fake is not a cryptographic Apple pairing receiver.
    const native = createFfiSpawn();
    const seam: AirplaySpawn = (event, credential) => {
      const driver = native(event, credential);
      return {
        ...driver,
        transport: {
          ...driver.transport,
          pcm: (chunk) => driver.transport.pcm(chunk),
          close: () => driver.transport.close(),
          cancelPcm: () => driver.transport.cancelPcm(),
          ownsSharedFeed: () => driver.transport.ownsSharedFeed(),
          send: (cmd) =>
            cmd.cmd === 'pin'
              ? (submitted++, Promise.resolve())
              : driver.transport.send(cmd),
        },
      };
    };
    const open = async (useSeam = true) => {
      t = await speakerConsumer(dir, [service], {
        root,
        ...(useSeam ? { spawn: seam } : {}),
      });
    };
    const close = async () => {
      await t?.close();
      t = undefined;
    };
    const response = async (r: Response, code: number) => {
      assertEquals(r.status, code);
      visible.push(await r.text());
    };
    const pair = async (admin = false) => {
      const before = t!.playback.playerView();
      if (admin) {
        const login = await t!.f.login('cookie', 'admin', 'password-admin');
        await response(
          await t!.f.json(
            '/_melofon/api/v1/speakers/1/pair',
            'POST',
            {},
            login.credential,
          ),
          202,
        );
      } else await response(await t!.write('1', 'pair'), 202);
      await consumerUntil(() =>
        t!.devices.describe('1').session?.pairing?.state === 'awaiting_pin'
      );
      const after = t!.playback.playerView();
      assertEquals(after.state, before.state);
      assertEquals(after.current?.id, before.current?.id);
      assertEquals(after.itemProgressMs, before.itemProgressMs);
      assert(
        fake.sessions.every((s) =>
          !s.requests.some((r) =>
            ['ANNOUNCE', 'SETUP', 'RECORD'].includes(r.method)
          ) && s.audioPackets === 0
        ),
      );
    };
    try {
      await open();
      t!.discover(service);
      const noOperation = await t!.write('1', 'pin', 'POST', { pin: '2468' });
      await response(noOperation, 409);
      await response(await t!.write('1', 'adopt'), 200);
      await pair();
      const bearer = await t!.f.login('bearer', 'member', 'password-member');
      await response(
        await t!.f.json(
          '/api/v1/speakers/1/pin',
          'POST',
          { pin: '2468' },
          bearer.credential,
        ),
        202,
      );
      assertEquals(submitted, 1);
      const store = t!.f.store.speakers, save = store.saveCredential;
      let writes = 0;
      const heldSave = new Promise<void>((resolve) => releaseSave = resolve);
      store.saveCredential = async (...args) => {
        if (++writes === 1) throw new Error('Private persistence failure');
        await heldSave;
        return await save(...args);
      };
      assertEquals(probe.lib.symbols.probe_pairing_change(cstr(values[0])), 0);
      assertEquals(probe.lib.symbols.probe_pairing_overflow_events(), 0);
      await consumerUntil(() => writes >= 2);
      assert(probe.lib.symbols.probe_pairing_pending() > 0n);
      assertEquals(await store.loadCredential('1', 'pairing-key'), null);
      assertEquals((await t!.read('1')).state.pairing.state, 'pairing');
      releaseSave();
      store.saveCredential = save;
      await consumerUntil(() =>
        t!.devices.describe('1').session?.pairing?.state === 'complete'
      );
      assertEquals((await t!.read('1')).state.pairing.saved, true);
      assert(await t!.credentials.get('1', 'pairing-key') === values[0]);
      assertEquals(probe.lib.symbols.probe_pairing_pending(), 0n);
      await close();
      assert(
        !new TextDecoder().decode(
          await Deno.readFile(`${dir}/db/melofon.duckdb`),
        ).includes(values[0]),
      );
      await open(false);
      assert(await t!.credentials.get('1', 'pairing-key') === values[0]);
      await t!.play('1');
      await consumerUntil(() => verifyEntered);
      assertEquals(
        probe.lib.symbols.probe_pairing_restored(cstr(values[0])),
        1,
        'Full key restored on actual native device before verification',
      );
      releaseVerify();
      await consumerUntil(() =>
        t!.devices.describe('1').session?.authentication ===
          'authentication_required'
      );
      // Fake's empty verification response is deliberately invalid. The native
      // tombstone must delete durable state, never resurrect the stale key.
      await consumerUntil(() =>
        probe.lib.symbols.probe_pairing_pending() === 0n
      );
      assertEquals(await t!.credentials.get('1', 'pairing-key'), null);
      await t!.own('/player/stop', 'PUT');
      await close();
      await open();
      assertEquals(await t!.credentials.get('1', 'pairing-key'), null);
      // OwnTone's existing PIN field routes through exactly the same operation.
      await pair(true);
      await response(
        await t!.ownResponse('/outputs/1', 'PUT', { pin: '1357' }),
        204,
      );
      assertEquals(submitted, 2);
      assertEquals(probe.lib.symbols.probe_pairing_change(cstr(values[1])), 0);
      assertEquals(probe.lib.symbols.probe_pairing_overflow_events(), 0);
      await consumerUntil(() =>
        t!.devices.describe('1').session?.pairing?.state === 'complete'
      );
      assert(await t!.credentials.get('1', 'pairing-key') === values[1]);
      visible.push(
        JSON.stringify(await t!.read('1')),
        JSON.stringify(await t!.own('/outputs')),
      );
      await close();
      await open();
      assert(await t!.credentials.get('1', 'pairing-key') === values[1]);
      await response(await t!.write('1', '', 'DELETE'), 204);
      await close();
      await open();
      assertEquals(t!.outputs.list(), []);
      assertEquals(
        await t!.f.store.speakers.loadCredential('1', 'pairing-key'),
        null,
      );
      await logs.log.flush();
      visible.push(logs.lines.join('\n'), logs.log.text());
      assert(
        [root, ...values].every((value) =>
          visible.every((text) => !text.includes(value))
        ),
        'Pairing credential escaped public/log boundary',
      );
      // Four digits can also occur in timestamps/UUIDs emitted before entry.
      assert(
        visible.every((text) =>
          !/(?:"pin"\s*:\s*"(?:2468|1357)"|pin=(?:2468|1357))/.test(text)
        ),
        'PIN field escaped public/log boundary',
      );
    } finally {
      releaseSave();
      releaseVerify();
      await close();
      fake.close();
      shutdownNativeLogging();
      installLogger(previous);
      if (oldPath === undefined) Deno.env.delete('MELOFON_RAOP_LIB');
      else Deno.env.set('MELOFON_RAOP_LIB', oldPath);
      await probe.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    'pairing operation bounds permissions durability temporary adoption and late-result lifecycle fencing',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: 'pairing-lifecycle-' });
    await speakerMedia(dir);
    const root = crypto.randomUUID(), value = pairingKey();
    const secrets = secretsForPairing(root);
    let hold = false, entered = false, release!: () => void;
    let barrier = Promise.resolve();
    const slowSecrets = {
      ...secrets,
      async encrypt(...args: Parameters<typeof secrets.encrypt>) {
        if (hold) {
          entered = true;
          await barrier;
        }
        return await secrets.encrypt(...args);
      },
    };
    const drivers: {
      event: Parameters<AirplaySpawn>[0];
      credential: Parameters<AirplaySpawn>[1];
      closed: boolean;
      writes: number;
    }[] = [];
    const spawn: AirplaySpawn = (event, credential) => {
      const owned = { event, credential, closed: false, writes: 0 };
      drivers.push(owned);
      return {
        transport: {
          send: () => Promise.resolve(),
          close: () => {
            owned.closed = true;
            return Promise.resolve();
          },
          pcm: () => {
            owned.writes++;
            return Promise.resolve();
          },
          cancelPcm() {},
          ownsSharedFeed: () => false,
        },
        start: () => {
          event('state', 'password');
          return Promise.resolve();
        },
      };
    };
    const service = receiver(1, 7000, { sf: '200' });
    let t: Awaited<ReturnType<typeof speakerConsumer>> | undefined;
    const close = async () => {
      await t?.close();
      t = undefined;
    };
    const open = async (seconds = 10) => {
      t = await speakerConsumer(dir, [service], {
        root,
        spawn,
        secrets: slowSecrets,
        pairingSeconds: seconds,
      });
    };
    const code = async (r: Response, expected: number) => {
      assertEquals(r.status, expected);
      await r.text();
    };
    const pair = async () => {
      await code(await t!.write('1', 'pair'), 202);
      await code(await t!.write('1', 'pin', 'POST', { pin: '8642' }), 202);
      return drivers.at(-1)!;
    };
    const receipt = (d: typeof drivers[number]) =>
      d.credential!({ revision: 1n, key: value, isCurrent: () => !d.closed });
    try {
      await open();
      t!.discover(service);
      for (const operation of ['pair', 'pin']) {
        await code(
          await t!.f.json(
            `/api/v1/speakers/1/${operation}`,
            'POST',
            {},
            undefined,
          ),
          401,
        );
        await code(
          await t!.f.json(
            `/api/v1/speakers/1/${operation}`,
            'POST',
            {},
            t!.credential,
            'http://other.home',
          ),
          403,
        );
      }
      for (const pin of ['', '123', '12345', 'abcd', '12\u000034']) {
        await code(await t!.write('1', 'pin', 'POST', { pin }), 400);
      }
      await code(await t!.write('1', 'pair', 'POST', { selected: true }), 400);
      await code(await t!.write('missing', 'pair'), 404);
      let d = await pair();
      await receipt(d);
      d.event('credential', 'saved');
      d.event('state', 'stopped');
      assert(await t!.credentials.get('1', 'pairing-key') === value);
      assertEquals(
        await t!.f.store.speakers.loadCredential('1', 'pairing-key'),
        null,
      );
      await close();
      await open();
      assertEquals(t!.outputs.list(), []);
      t!.discover(service);
      assertEquals(await t!.credentials.get('1', 'pairing-key'), null);
      d = await pair();
      await receipt(d);
      d.event('credential', 'saved');
      d.event('state', 'stopped');
      await code(await t!.write('1', 'adopt'), 200);
      await close();
      await open();
      assert(await t!.credentials.get('1', 'pairing-key') === value);
      // Failed persistence cannot report complete or acknowledge the private receipt.
      const store = t!.f.store.speakers, save = store.saveCredential;
      store.saveCredential = () => Promise.reject(new Error('private failure'));
      d = await pair();
      let rejected = false;
      try {
        await receipt(d);
      } catch {
        rejected = true;
      }
      assert(rejected);
      assertEquals((await t!.read('1')).state.pairing.state, 'pairing');
      store.saveCredential = save;
      await receipt(d);
      d.event('state', 'stopped');
      d.event('credential', 'saved');
      assertEquals((await t!.read('1')).state.pairing.state, 'complete');
      // Every late producer loses its original lifetime, including same-id rediscovery.
      for (
        const action of [
          'pause',
          'stop',
          'deselect',
          'endpoint',
          'replace',
          'forget',
        ]
      ) {
        await close();
        await open();
        t!.discover(service);
        if (!t!.outputs.get('1')) {
          t!.discover(service);
          await code(await t!.write('1', 'adopt'), 200);
        }
        d = await pair();
        hold = true;
        entered = false;
        barrier = new Promise<void>((resolve) => release = resolve);
        const pending = receipt(d).then(() => false, () => true);
        let replacing: Promise<unknown> | undefined;
        await consumerUntil(() => entered);
        if (action === 'pause' || action === 'stop') {
          await t!.own(`/player/${action}`, 'PUT');
        } else if (action === 'deselect') {
          await t!.own('/outputs/set', 'PUT', { outputs: [] });
        } else if (action === 'endpoint') {
          t!.outputs.register({ ...t!.outputs.get('1')!, host: '192.0.2.99' });
        } else if (action === 'replace') {
          replacing = t!.write('1', 'password', 'PUT', {
            password: crypto.randomUUID(),
          }).then((r) => r.text());
          await consumerUntil(() => d.closed);
        } else {
          await code(await t!.write('1', '', 'DELETE'), 204);
          t!.discover(service);
        }
        release();
        hold = false;
        assert(await pending, 'Late receipt must reject after authority ends');
        await replacing;
        d.event('credential', 'saved');
        d.event('state', 'stopped');
        assertEquals(d.writes, 0);
        assert(t!.playback.playerView().state !== 'play');
        if (action === 'forget') {
          assertEquals(
            await t!.f.store.speakers.loadCredential('1', 'pairing-key'),
            null,
          );
        }
      }
      await close();
      await open(0.05);
      t!.discover(service);
      await code(await t!.write('1', 'pair'), 202);
      const last = drivers.at(-1)!;
      await consumerUntil(() => last.closed);
      assertEquals(
        (await t!.read('1')).state.pairing.error.code,
        'pairing_timeout',
      );
      await code(await t!.write('1', 'pin', 'POST', { pin: '8642' }), 409);
    } finally {
      release?.();
      hold = false;
      await close();
      await Deno.remove(dir, { recursive: true });
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

Deno.test({
  name:
    'playback PIN completion recreates a keyed handle only under current intent and pause wins',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: 'pairing-playback-' });
    await speakerMedia(dir);
    const value = pairingKey();
    const drivers: {
      event: Parameters<AirplaySpawn>[0];
      credential: Parameters<AirplaySpawn>[1];
      closed: boolean;
      keyed: boolean;
      writes: number;
    }[] = [];
    const spawn: AirplaySpawn = (event, credential) => {
      const d = { event, credential, closed: false, keyed: false, writes: 0 };
      drivers.push(d);
      return {
        transport: {
          send: () => Promise.resolve(),
          close: () => {
            d.closed = true;
            return Promise.resolve();
          },
          pcm: () => {
            d.writes++;
            return Promise.resolve();
          },
          cancelPcm() {},
          ownsSharedFeed: () => false,
        },
        start(_profile, _input, credentials) {
          d.keyed = credentials?.pairingKey === value;
          // FFI events are polled after activation returns, never inline.
          setTimeout(
            () => event('state', d.keyed ? 'connected' : 'password'),
            0,
          );
          return Promise.resolve();
        },
      };
    };
    const service = receiver(1, 7000, { sf: '200' });
    let t: Awaited<ReturnType<typeof speakerConsumer>> | undefined;
    try {
      t = await speakerConsumer(dir, [service], {
        root: crypto.randomUUID(),
        spawn,
      });
      t.discover(service);
      await t.play('1');
      await consumerUntil(() =>
        t!.devices.describe('1').session?.authentication ===
          'authentication_required'
      );
      const d = drivers[0];
      const pin = await t.ownResponse('/outputs/1', 'PUT', { pin: '9753' });
      assertEquals(pin.status, 204);
      await pin.text();
      await d.credential!({
        revision: 1n,
        key: value,
        isCurrent: () => !d.closed,
      });
      d.event('credential', 'saved');
      d.event('state', 'stopped');
      await consumerUntil(() =>
        drivers.some((row) => row.keyed && row.writes > 0)
      );
      assertEquals(t.playback.playerView().state, 'play');
      await t.own('/player/stop', 'PUT');
      await t.credentials.set('1', 'pairing-key', null);
      await t.play('1');
      await consumerUntil(() =>
        drivers.at(-1)!.keyed === false &&
        t!.devices.describe('1').session?.authentication ===
          'authentication_required'
      );
      const late = drivers.at(-1)!;
      const pendingPin = await t.write('1', 'pin', 'POST', { pin: '9753' });
      assertEquals(pendingPin.status, 202);
      await pendingPin.text();
      await t.own('/player/pause', 'PUT');
      const count = drivers.length;
      let rejected = false;
      try {
        await late.credential!({
          revision: 1n,
          key: value,
          isCurrent: () => !late.closed,
        });
      } catch {
        rejected = true;
      }
      assert(rejected);
      late.event('credential', 'saved');
      late.event('state', 'stopped');
      await sleep(50);
      assertEquals(drivers.length, count);
      assertEquals(t.playback.playerView().state, 'pause');
      assertEquals(late.writes, 0);
    } finally {
      await t?.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
