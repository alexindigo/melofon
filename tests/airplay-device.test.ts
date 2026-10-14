import { assert, assertEquals, assertThrows } from '@std/assert';
import { createOutputs } from '../src/player.ts';
import { createAirplayDevices } from '../src/boots/airplay-device.ts';
import { profileFromService } from '../src/boots/airplay-profile.ts';
import { PreparationError } from '../src/output-admission.ts';
import type { MdnsService } from '../src/mdns.ts';

const service = (
  txt: Record<string, string> = { tp: 'UDP', am: 'AppleTV3,1', md: '0,1,2' },
): MdnsService => ({
  name: '001122334455@test._raop._tcp.local',
  host: 'test.local',
  address: '127.0.0.1',
  port: 7000,
  ttlMs: 120000,
  txt,
});

Deno.test('AirPlay profiles distinguish acquired missing-md from absent/incompatible capabilities', () => {
  assertEquals(profileFromService(service()).wantedMetadata, 7);
  assertEquals(profileFromService(service({ tp: 'UDP' })).wantedMetadata, 0);
  assertEquals(
    profileFromService(service({ tp: 'UDP', am: 'UnknownVendor' })).devtype,
    'other',
  );
  assertThrows(() => profileFromService(service({})), PreparationError);
  assertThrows(
    () => profileFromService(service({ tp: 'UDP', sr: '48000' })),
    PreparationError,
  );
  assertThrows(
    () => profileFromService(service({ tp: 'UDP', ch: '1' })),
    PreparationError,
  );
  assertThrows(
    () => profileFromService(service({ tp: 'UDP', pw: 'true' })),
    PreparationError,
  );
});

Deno.test('AirPlay registration without facts remains recorded but cannot activate', async () => {
  const outputs = createOutputs();
  let creates = 0;
  const devices = createAirplayDevices({
    outputs,
    resolver: {
      resolve: () =>
        Promise.reject(new PreparationError('timeout', 'fixture timeout')),
      close() {},
    },
    spawn: () => {
      creates++;
      throw new Error('unreachable');
    },
  });
  try {
    const row = await devices.registerAddress({
      name: 'saved',
      host: '127.0.0.1',
    });
    assert(row);
    assertEquals(devices.admission.describe(row.id).state, 'failed');
    outputs.update(row.id, { selected: true });
    const prepared = await devices.protocol.prepare({
      id: row.id,
      targetRevision: devices.admission.describe(row.id).targetRevision,
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    assert(!prepared.ok);
    assertEquals(outputs.get(row.id)!.selected, true);
    assertEquals(creates, 0);
  } finally {
    devices.close();
  }
});

Deno.test('AirPlay POST-shaped preparation and explicit-id restore share validated profile activation', async () => {
  const outputs = createOutputs();
  const received: number[] = [];
  let lookups = 0;
  const devices = createAirplayDevices({
    outputs,
    resolver: {
      resolve: () => {
        lookups++;
        return Promise.resolve(service());
      },
      close() {},
    },
    spawn: () => ({
      transport: {
        send: () => Promise.resolve(),
        pcm: () => Promise.resolve(),
        close: () => Promise.resolve(),
        ownsSharedFeed: () => false,
        cancelPcm() {},
      },
      start(profile) {
        received.push(profile.wantedMetadata);
        return Promise.resolve();
      },
    }),
  });
  try {
    const row = await devices.registerAddress({
      name: 'test',
      host: '127.0.0.1',
    });
    assert(row);
    assertEquals(row.model, 'AppleTV3,1');
    assertEquals(devices.admission.describe(row.id).state, 'ready');
    devices.register({ ...row, selected: true });
    const permit = await devices.protocol.prepare({
      id: row.id,
      targetRevision: devices.admission.describe(row.id).targetRevision,
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    assert(permit.ok);
    const active = await devices.protocol.activate(permit.value, {
      volume: 65,
      positionMs: 0,
      lengthMs: 1000,
      title: 'test',
      artist: 'test',
    }, { publish() {}, onEvent() {} });
    assert(active.ok);
    assertEquals(received, [7]);
    assertEquals(lookups, 1);
    await active.value.close();
  } finally {
    devices.close();
  }
});
