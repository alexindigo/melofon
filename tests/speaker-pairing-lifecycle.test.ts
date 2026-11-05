import { assert, assertEquals } from '@std/assert';
import { apiFixture } from './helpers/api.ts';
import { createOutputs } from '../src/player.ts';
import { createSpeakers, SpeakerError } from '../src/speakers.ts';
import { createOutputAdmission } from '../src/output-admission.ts';
import { createFfiSpawn } from '../src/boots/raop-ffi.ts';
import type { AirplaySpawn } from '../src/boots/airplay-profile.ts';
import { startFakeRaop } from './helpers/fake-raop.ts';
import {
  receiver,
  sleep,
  speakerConsumer,
  speakerMedia,
  until,
} from './helpers/speaker-consumer.ts';

const pin = () =>
  String(1000 + crypto.getRandomValues(new Uint16Array(1))[0] % 9000);
async function status(response: Response, expected: number) {
  assertEquals(response.status, expected);
  return await response.json();
}

Deno.test('operator PIN HTTP normalizes input and preserves coded versus internal failures', async () => {
  const outputs = createOutputs();
  outputs.register({
    id: '1',
    name: 'Receiver',
    type: 'AirPlay',
    selected: false,
    volume: 50,
  });
  let failure: unknown, submitted = false;
  const value = pin();
  const admission = createOutputAdmission({ endpoint: () => null });
  const f = await apiFixture({
    services: () =>
      Promise.resolve({
        outputs,
        speakers: createSpeakers({
          outputs,
          adapterView: (id) => ({ preparation: admission.describe(id) }),
          submitPin: (_id, input) => {
            if (failure) return Promise.reject(failure);
            submitted = input === value;
            return Promise.resolve({ state: 'pairing', saved: false });
          },
        }),
      }),
  });
  const send = (value: string, id = '1') =>
    f.json(
      `/_/outputs/${id}/pin`,
      'POST',
      { pin: value },
      undefined,
      null,
      true,
    );
  try {
    await status(await send(' ' + value + ' '), 200);
    assert(submitted, 'Normalized PIN must reach the lifecycle consumer');
    assertEquals(await status(await send('bad'), 400), {
      error: 'PIN must contain four digits',
    });
    assertEquals(await status(await send(value, 'missing'), 404), {
      error: 'unknown output id',
    });
    for (
      const [code, expected] of [['pairing_required', 409], [
        'speaker_busy',
        409,
      ], ['pairing_unavailable', 400]] as const
    ) {
      failure = new SpeakerError(code, 'Safe pairing failure');
      assertEquals(await status(await send(value), expected), {
        error: 'Safe pairing failure',
      });
    }
    for (
      const error of [
        new Error('Internal pairing failure'),
        'Internal pairing failure',
      ]
    ) {
      failure = error;
      const r = await send(value);
      assertEquals(r.status, 500);
      await r.text();
    }
  } finally {
    admission.close();
    await f.close();
  }
});

for (const operation of ['pair', 'pin'] as const) {
  Deno.test({
    name:
      `${operation} settings failure releases ownership before HTTP retry reaches native fake receiver`,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const dir = await Deno.makeTempDir({ prefix: 'pairing-settings-' });
      await speakerMedia(dir);
      const fake = await startFakeRaop();
      const service = receiver(1, fake.port, { sf: '200' });
      let t: Awaited<ReturnType<typeof speakerConsumer>> | undefined;
      try {
        t = await speakerConsumer(dir, [service]);
        t.discover(service);
        if (operation === 'pin') {
          await t.play('1');
          await until(() =>
            t!.devices.describe('1').session?.authentication ===
              'authentication_required'
          );
        }
        const get = t.f.state.getTyped;
        let failures = 1;
        t.f.state.getTyped = (key) =>
          key === 'airplay.pairingSeconds' && failures-- > 0
            ? Promise.reject(new Error('Settings unavailable'))
            : get(key);
        const body = operation === 'pin' ? { pin: pin() } : {};
        const failed = await t.write('1', operation, 'POST', body);
        assertEquals(
          failed.status,
          500,
          'Original settings failure must reach the server error boundary',
        );
        await failed.text();
        if (operation === 'pair') {
          assertEquals((await t.read('1')).state.pairing, {
            state: 'failed',
            saved: false,
            error: {
              code: 'pairing_unavailable',
              message: 'Speaker pairing did not complete',
            },
          });
        }
        await status(await t.write('1', operation, 'POST', body), 202);
        await until(() =>
          fake.sessions.some((s) => s.requests.some((r) => r.method === 'POST'))
        );
        if (operation === 'pair') {
          await until(() =>
            t!.devices.describe('1').session?.pairing?.state === 'awaiting_pin'
          );
          await t.own('/player/stop', 'PUT');
          await status(await t.write('1', 'pair'), 202);
        } else {
          // The fake rejects fruit setup. Seeing a new RTSP session proves the
          // retry passed both the HTTP facade and the native PIN command queue.
          await until(() => fake.sessions.length >= 2);
        }
        assert(fake.sessions.every((s) => s.audioPackets === 0));
      } finally {
        await t?.close();
        fake.close();
        await Deno.remove(dir, { recursive: true });
      }
    },
  });
}

for (const scenario of ['demand', 'challenge', 'timer', 'send'] as const) {
  Deno.test({
    name:
      `playback PIN ${scenario} exits cannot block or steal a successor attempt`,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const dir = await Deno.makeTempDir({ prefix: 'pairing-attempts-' });
      await speakerMedia(dir);
      const fake = await startFakeRaop();
      const service = receiver(1, fake.port, { sf: '200' });
      const native = createFfiSpawn();
      let challenge!: () => void, calls = 0;
      let pinSend = () => Promise.resolve();
      // Real native start/receiver challenge. Only fruit setup is replaced so
      // dependency, reentrancy and timer races can be scheduled deterministically.
      const spawn: AirplaySpawn = (event, credential) => {
        challenge = () => event('state', 'password');
        const d = native(event, credential);
        return {
          ...d,
          transport: {
            ...d.transport,
            pcm: (chunk) => d.transport.pcm(chunk),
            close: () => d.transport.close(),
            cancelPcm: () => d.transport.cancelPcm(),
            ownsSharedFeed: () => d.transport.ownsSharedFeed(),
            send: (command) =>
              command.cmd === 'pin'
                ? (calls++, pinSend())
                : d.transport.send(command),
          },
        };
      };
      let t: Awaited<ReturnType<typeof speakerConsumer>> | undefined;
      let release = () => {};
      try {
        t = await speakerConsumer(dir, [service], { spawn });
        t.discover(service);
        await t.play('1');
        await until(() =>
          t!.devices.describe('1').session?.authentication ===
            'authentication_required'
        );
        assert(fake.sessions.some((s) => s.requests.length > 0));
        const get = t.f.state.getTyped;
        const send = () => t!.write('1', 'pin', 'POST', { pin: pin() });
        if (scenario === 'demand' || scenario === 'challenge') {
          let entered = false;
          const held = new Promise<number>((resolve) =>
            release = () => resolve(5)
          );
          t.f.state.getTyped = (key) => {
            if (key !== 'airplay.pairingSeconds') return get(key);
            entered = true;
            return held;
          };
          const pending = send();
          await until(() => entered);
          t.f.state.getTyped = (key) =>
            key === 'airplay.pairingSeconds' ? Promise.resolve(5) : get(key);
          if (scenario === 'demand') {
            await t.own('/outputs/1', 'PUT', { selected: true });
            release();
            await status(await pending, 409);
            await status(await send(), 202);
          } else {
            challenge();
            await status(await send(), 202);
            release();
            await status(await pending, 409);
          }
          // Old finally must not clear the newer PIN attempt's reservation.
          await status(await send(), 409);
          challenge();
        }
        if (scenario === 'timer') {
          let reads = 0;
          t.f.state.getTyped = (key) =>
            key === 'airplay.pairingSeconds'
              ? Promise.resolve(++reads === 1 ? 0.3 : 5)
              : get(key);
          await status(await send(), 202);
          challenge();
          await status(await send(), 202);
          const before = calls;
          await sleep(450);
          assertEquals(
            (await t.read('1')).state.authentication,
            'authentication_required',
          );
          assertEquals((await t.read('1')).state.connection, 'connecting');
          await status(await send(), 409);
          assertEquals(calls, before);
          challenge();
          await status(await send(), 202);
          assertEquals(calls, before + 1);
        }
        if (scenario === 'send') {
          let reject!: (error: Error) => void;
          pinSend = () => new Promise<void>((_resolve, no) => reject = no);
          const pending = send();
          await until(() => calls === 1);
          release = () => reject(new Error('PIN transport unavailable'));
          challenge();
          pinSend = () => Promise.resolve();
          await status(await send(), 202);
          release();
          await status(await pending, 400);
          assertEquals((await t.read('1')).state.connection, 'connecting');
          await status(await send(), 409);
          challenge();
          await status(await send(), 202);
        }
      } finally {
        release();
        await t?.close();
        fake.close();
        await Deno.remove(dir, { recursive: true });
      }
    },
  });
}

Deno.test('OwnTone PIN HTTP preserves every typed refusal and propagates unexpected failures', async () => {
  const outputs = createOutputs();
  outputs.register({
    id: '1',
    name: 'Receiver',
    type: 'AirPlay',
    selected: false,
    volume: 50,
  });
  const admission = createOutputAdmission({ endpoint: () => null });
  const value = pin();
  let failure: unknown, submitted = false;
  const f = await apiFixture({
    hats: {
      layersRoot: 'layers',
      extraPorts: 1,
      env: ([port]) => ({ MELOFON_LISTEN_owntone: `${port},${port}` }),
    },
    services: () =>
      Promise.resolve({
        outputs,
        speakers: createSpeakers({
          outputs,
          adapterView: (id) => ({ preparation: admission.describe(id) }),
          submitPin: (_id, input) => {
            if (failure !== undefined) return Promise.reject(failure);
            submitted = input === value;
            return Promise.resolve({ state: 'pairing', saved: false });
          },
        }),
      }),
  });
  const url = `http://melofon.home:${f.extraPorts[0]}/api/outputs/1`;
  const send = () =>
    fetch(url, {
      method: 'PUT',
      signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: value, selected: true, volume: 37 }),
    });
  const refusals = {
    not_found: 400,
    invalid_field: 400,
    unknown_field: 400,
    unsupported_protocol: 400,
    not_adopted: 400,
    already_adopted: 400,
    speaker_in_use: 400,
    speaker_busy: 400,
    pairing_required: 400,
    pairing_unavailable: 400,
    persistence_failed: 400,
  } satisfies Record<SpeakerError['code'], number>;
  try {
    for (const code of Object.keys(refusals) as SpeakerError['code'][]) {
      failure = new SpeakerError(code, 'Safe speaker refusal');
      const response = await send();
      assertEquals(response.status, refusals[code]);
      assertEquals(await response.text(), '');
    }
    for (
      const unexpected of [
        new Error('Settings unavailable'),
        Object.assign(new Error('Dependency failed'), {
          code: 'invalid_field',
        }),
        'Unexpected rejection',
        { name: 'SpeakerError', code: 'pairing_required' },
      ]
    ) {
      failure = unexpected;
      const response = await send();
      assertEquals(response.status, 500);
      await response.text();
    }
    assertEquals(outputs.get('1')!.selected, false);
    assertEquals(outputs.get('1')!.volume, 50);
    failure = undefined;
    const accepted = await send();
    assertEquals(accepted.status, 204);
    assertEquals(await accepted.text(), '');
    assert(submitted, 'PIN reaches the core lifecycle port unchanged');
    const read = await fetch(url, { signal: AbortSignal.timeout(5000) });
    assertEquals(read.status, 200);
    const output = await read.json();
    assertEquals(output.selected, true);
    assertEquals(output.volume, 37);
  } finally {
    admission.close();
    await f.close();
  }
});

Deno.test({
  name:
    'OwnTone PIN settings rejection is HTTP 500 and retry reaches the native fake receiver',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: 'owntone-pin-settings-' });
    await speakerMedia(dir);
    const fake = await startFakeRaop();
    const service = receiver(1, fake.port, { sf: '200' });
    let t: Awaited<ReturnType<typeof speakerConsumer>> | undefined;
    try {
      t = await speakerConsumer(dir, [service]);
      t.discover(service);
      await t.play('1');
      await until(() =>
        t!.devices.describe('1').session?.authentication ===
          'authentication_required'
      );
      const get = t.f.state.getTyped;
      let failures = 1;
      t.f.state.getTyped = (key) =>
        key === 'airplay.pairingSeconds' && failures-- > 0
          ? Promise.reject(new Error('Settings unavailable'))
          : get(key);
      const body = { pin: pin() };
      const rejected = await t.ownResponse('/outputs/1', 'PUT', body);
      assertEquals(rejected.status, 500);
      await rejected.text();
      const accepted = await t.ownResponse('/outputs/1', 'PUT', body);
      assertEquals(accepted.status, 204);
      assertEquals(await accepted.text(), '');
      await until(() =>
        fake.sessions.length >= 2 &&
        fake.sessions[1].requests.some((r) => r.method === 'POST')
      );
      assert(fake.sessions.every((s) => s.audioPackets === 0));
    } finally {
      await t?.close();
      fake.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
