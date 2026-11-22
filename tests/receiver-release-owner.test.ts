import { assert, assertEquals, assertRejects } from '@std/assert';
import { createOutputs } from '../src/player.ts';
import { createAirplayDevices } from '../src/boots/airplay-device.ts';
import { recordingSpawn } from './helpers/airplay-devices.ts';
import { receiver } from './helpers/speaker-consumer.ts';

for (const failure of [false, true]) {
  Deno.test(`receiver release: a new row cannot bypass ${failure ? 'failed' : 'pending'} physical teardown`, async () => {
    const outputs = createOutputs();
    const gate = Promise.withResolvers<void>();
    let starts = 0;
    const service = receiver(1, 7000);
    const devices = createAirplayDevices({
      outputs,
      resolver: { resolve: () => Promise.resolve(service), close() {} },
      spawn: recordingSpawn(() => ({
        send: () => {
          starts++;
          return Promise.resolve();
        },
        pcm: () => Promise.resolve(),
        cancelPcm() {},
        ownsSharedFeed: () => false,
        close: () => gate.promise,
      })),
    });
    const row = {
      id: 'first',
      type: 'AirPlay',
      name: 'First',
      host: service.address,
      port: service.port,
      selected: false,
      volume: 50,
    };
    const activate = async (id: string) => {
      const permit = await devices.protocol.prepare({
        id,
        signal: new AbortController().signal,
        targetRevision: devices.admission.describe(id).targetRevision,
        isCurrent: () => true,
      });
      assert(permit.ok);
      return devices.protocol.activate(permit.value, {
        volume: 50,
        positionMs: 0,
        lengthMs: 1000,
        title: '',
        artist: '',
      }, { publish() {}, onEvent() {} });
    };
    try {
      devices.register(row, undefined, service);
      const first = await activate(row.id);
      assert(first.ok);
      const closing = first.value.close();
      void closing.catch(() => {});
      await outputs.forget(row.id);
      devices.register({ ...row, id: 'replacement' }, undefined, service);
      let settled = false;
      const replacement = activate('replacement').then((result) => {
        settled = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      assertEquals(starts, 1);
      assertEquals(settled, false);
      if (failure) {
        gate.reject(new Error('native teardown not proven'));
        await assertRejects(() => closing);
        assertEquals((await replacement).ok, false);
        assertEquals(starts, 1);
        assertEquals((await activate('replacement')).ok, false);
        assertEquals(starts, 1);
      } else {
        gate.resolve();
        await closing;
        const second = await replacement;
        assert(second.ok);
        assertEquals(starts, 2);
        await second.value.close();
      }
    } finally {
      gate.resolve();
      devices.close();
    }
  });
}
