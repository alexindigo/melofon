import { assert, assertEquals, assertRejects } from '@std/assert';
import { createOutputs } from '../src/player.ts';
import { createAirplayDevices } from '../src/boots/airplay-device.ts';
import {
  createSpeakerCredentials,
  type SpeakerCredentials,
} from '../src/speaker-credentials.ts';
import { createSecrets } from '../src/secrets.ts';
import type { Store } from '../src/store/index.ts';
import type { AirplaySpawn } from '../src/boots/airplay-profile.ts';
import { airplayStartFields } from '../src/boots/airplay-profile.ts';
import { createFfiSpawn } from '../src/boots/raop-ffi.ts';
import { startFakeRaop } from './helpers/fake-raop.ts';
import { NATIVE_CHANGED } from './helpers/native-changes.ts';

const input = {
  volume: 80,
  positionMs: 0,
  lengthMs: 1000,
  title: '',
  artist: '',
};
const canary = () => crypto.randomUUID();
function fixture(
  port: number,
  spawn?: AirplaySpawn,
  session?: SpeakerCredentials['session'],
) {
  const outputs = createOutputs();
  outputs.register({
    id: '1',
    name: 'Private receiver',
    type: 'AirPlay',
    host: '127.0.0.1',
    port,
    selected: true,
    volume: 80,
  });
  const credentials = createSpeakerCredentials({
    store: {} as Store['speakers'], // Temporary credentials must never call a store.
    secrets: createSecrets(undefined),
    current: (id) =>
      outputs.get(id)
        ? { revision: outputs.revision(id), adopted: false }
        : null,
  });
  const devices = createAirplayDevices({
    outputs,
    credentials: { session: session ?? credentials.session },
    ...(spawn ? { spawn } : {}),
    resolver: {
      resolve: () =>
        Promise.resolve({
          name: '001122334455@Private receiver._raop._tcp.local',
          host: 'fixture.local',
          address: '127.0.0.1',
          port,
          ttlMs: 120000,
          txt: { tp: 'UDP', pw: 'true', am: 'AppleTV3,1' },
        }),
      close() {},
    },
  });
  const prepare = () =>
    devices.protocol.prepare({
      id: '1',
      targetRevision: devices.admission.describe('1').targetRevision,
      signal: new AbortController().signal,
      isCurrent: () => outputs.get('1')?.selected === true,
    });
  return { outputs, credentials, devices, prepare };
}

async function until(fn: () => boolean) {
  const deadline = performance.now() + 15000;
  while (!fn()) {
    if (performance.now() > deadline) {
      throw new Error('Credential consumer timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

Deno.test({
  name:
    'private core password reaches native digest receiver without entering facts or diagnostics',
  ignore: !NATIVE_CHANGED,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const password = canary();
    const fake = await startFakeRaop({ digest: { password } });
    const f = fixture(fake.port);
    let connected = false;
    let transport:
      | Awaited<ReturnType<typeof f.devices.protocol.activate>>
      | undefined;
    try {
      await f.credentials.set('1', 'password', password);
      const permit = await f.prepare();
      assert(permit.ok);
      const facts = f.devices.protocol.facts('1')!;
      assert(facts.hasPassword);
      assert(f.devices.describe('1').abilities?.password);
      assert(
        !JSON.stringify([
          facts,
          airplayStartFields(facts, input),
          f.outputs.list(),
          f.devices.describe('1'),
        ]).includes(password),
      );
      transport = await f.devices.protocol.activate(permit.value, input, {
        publish() {},
        onEvent(e) {
          if (e.value === 'connected') connected = true;
        },
      });
      assert(transport.ok);
      await until(() => connected);
      await transport.value.pcm(new Uint8Array(176400));
      await until(() => (fake.sessions[0]?.audioPackets ?? 0) > 100);
      assert(fake.sessions[0].acceptedRequests.includes('RECORD'));
      assert(fake.sessions[0].authChallenges > 0);
    } finally {
      if (transport?.ok) await transport.value.close();
      f.devices.close();
      fake.close();
    }
  },
});

Deno.test('private credential snapshots fence replacements and registry incarnations', async () => {
  const f = fixture(7000, () => {
    throw new Error('unused');
  });
  try {
    await f.credentials.set('1', 'password', canary());
    await f.credentials.set('1', 'pairing-key', 'a'.repeat(128));
    const first = await f.credentials.session('1');
    assert(first.isCurrent());
    assert(first.password !== null && first.pairingKey?.length === 128);
    const replacing = f.credentials.set('1', 'password', canary());
    assert(
      !first.isCurrent(),
      'replacement request fences before persistence completes',
    );
    await replacing;
    const next = await f.credentials.session('1');
    assert(next.isCurrent());
    f.outputs.unregister('1');
    f.outputs.register({
      id: '1',
      name: 'New incarnation',
      type: 'AirPlay',
      selected: true,
      volume: 80,
      host: '127.0.0.1',
    });
    assert(!next.isCurrent());
  } finally {
    f.devices.close();
  }
});

Deno.test('private adapter checks current credentials after publish and before native start', async () => {
  let starts = 0, closes = 0;
  const f = fixture(7000, () => ({
    transport: {
      send: () => Promise.resolve(),
      pcm: () => Promise.resolve(),
      close() {
        closes++;
        return Promise.resolve();
      },
      ownsSharedFeed: () => false,
      cancelPcm() {},
    },
    start() {
      starts++;
      return Promise.resolve();
    },
  }));
  try {
    await f.credentials.set('1', 'password', canary());
    const permit = await f.prepare();
    assert(permit.ok);
    let replacement: Promise<void> | undefined;
    const result = await f.devices.protocol.activate(permit.value, input, {
      publish() {
        replacement = f.credentials.set('1', 'password', canary());
      },
      onEvent() {},
    });
    await replacement;
    assert(!result.ok);
    assertEquals(starts, 0);
    assertEquals(closes, 1);
  } finally {
    f.devices.close();
  }
});

Deno.test({
  name:
    'FFI rejects invalid credentials before native start and preserves an empty password',
  ignore: !NATIVE_CHANGED,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const fake = await startFakeRaop({ digest: { password: '' } });
    const f = fixture(fake.port);
    const driver = createFfiSpawn()(() => {});
    try {
      const permit = await f.prepare();
      assert(permit.ok);
      const facts = f.devices.protocol.facts('1')!;
      for (const value of [canary() + '\0suffix', 'p'.repeat(4097)]) {
        await assertRejects(
          () =>
            driver.start(facts, input, { password: value, pairingKey: null }),
          Error,
          'Invalid RAOP credential input',
        );
      }
      for (
        const value of [
          'a'.repeat(127),
          'z'.repeat(128),
          'a'.repeat(64) + '\0' + 'b'.repeat(63),
        ]
      ) {
        await assertRejects(
          () =>
            driver.start(facts, input, { password: null, pairingKey: value }),
          Error,
          'Invalid RAOP credential input',
        );
      }
      assertEquals(fake.sessions.length, 0);
      await driver.start(facts, input, { password: '', pairingKey: null });
      await until(() =>
        fake.sessions[0]?.acceptedRequests.includes('RECORD') ?? false
      );
      await driver.transport.pcm(new Uint8Array(176400));
      await until(() => (fake.sessions[0]?.audioPackets ?? 0) > 100);
    } finally {
      await driver.transport.close();
      f.devices.close();
      fake.close();
    }
  },
});

Deno.test('delayed credential resolution cannot cross revoked intent endpoint or lifetime and failures stay safe', async () => {
  for (
    const mode of ['selection', 'endpoint', 'lifetime', 'replacement', 'error']
  ) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => release = resolve);
    let loading!: () => void;
    const entered = new Promise<void>((resolve) => loading = resolve);
    let creates = 0;
    const secret = canary();
    const f = fixture(7000, () => {
      creates++;
      throw new Error('revoked start');
    }, async (id) => {
      const snapshot = await f.credentials.session(id);
      loading();
      await held;
      if (mode === 'error') throw new Error(secret);
      return snapshot;
    });
    try {
      await f.credentials.set('1', 'password', secret);
      const permit = await f.prepare();
      assert(permit.ok);
      const pending = f.devices.protocol.activate(permit.value, input, {
        publish() {},
        onEvent() {},
      });
      await entered;
      if (mode === 'selection') f.outputs.update('1', { selected: false });
      if (mode === 'endpoint') {
        f.outputs.register({ ...f.outputs.get('1')!, host: '127.0.0.2' });
      }
      if (mode === 'lifetime') {
        f.outputs.unregister('1');
        f.outputs.register({
          id: '1',
          name: 'New incarnation',
          type: 'AirPlay',
          selected: true,
          volume: 80,
          host: '127.0.0.1',
          port: 7000,
        });
      }
      if (mode === 'replacement') {
        await f.credentials.set('1', 'password', canary());
      }
      release();
      const result = await pending;
      assert(!result.ok);
      assertEquals(creates, 0);
      assert(!String(result.error).includes(secret));
      if (mode === 'error') {
        assertEquals(result.error.message, 'Speaker credentials unavailable');
      }
    } finally {
      release();
      f.devices.close();
    }
  }
});
