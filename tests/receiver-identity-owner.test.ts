import { assert, assertEquals } from '@std/assert';
import { concurrentFixture, until } from './helpers/concurrent-playback.ts';
import { receiver } from './helpers/speaker-consumer.ts';

for (const path of ['address', 'prepare', 'announcement', 'restore'] as const) {
  Deno.test({
    name:
      `receiver identity: ${path} resolves adopted aliases to one entry and stream`,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const f = await concurrentFixture();
      try {
        await f.initialize();
        const service = receiver(1, f.receivers[0].port, { md: '0,1,2' });
        f.devices.register(f.outputs.get('1')!, undefined, service);
        await f.outputs.adopt('1');
        const alias = {
          id: '11',
          name: 'Address alias',
          type: 'AirPlay',
          host: 'localhost',
          port: service.port,
          selected: false,
          playerId: 2,
          volume: 37,
          connectionStrategy: 'owntone' as const,
        };
        f.outputs.restore({
          ...alias,
          id: '90',
          host: 'unknown.local',
          playerId: null,
          port: undefined,
        });
        await f.outputs.adopt('90');
        if (path === 'restore') {
          await f.restart((store) =>
            store.speakers.saveAdopted({
              ...alias,
              receiverIdentity: '1',
            })
          );
        } else {
          f.outputs.restore(alias);
          await f.outputs.adopt(alias.id);
          if (path === 'address') {
            const row = await f.devices.registerAddress({
              host: alias.host,
              port: service.port,
            });
            assertEquals(row?.id, '1');
          } else if (path === 'prepare') {
            await f.devices.preparePlayback(
              alias.id,
              new AbortController().signal,
            );
          } else {
            assertEquals(f.devices.register(alias, undefined, service), '1');
            assertEquals(f.devices.observationId(service), '1');
          }
        }
        assertEquals(f.outputs.get(alias.id), null);
        assertEquals(
          f.outputs.list().filter((row) => row.receiverIdentity === '1').map((
            row,
          ) => row.id),
          ['1'],
        );
        assertEquals(f.outputs.get('1')!.volume, 80);
        assertEquals(f.outputs.get('90')!.receiverIdentity, undefined);
        await f.persistence.drain();
        assertEquals(
          (await f.server.f.store.speakers.loadAdopted()).filter((row) =>
            row.receiverIdentity === '1'
          ).map((row) => row.id),
          ['1'],
        );
        await f.players.setSpeakers(2, ['1']);
        await Promise.all(
          [1, 2].map((id) => f.server.call(`/players/${id}/play`, 'POST', {})),
        );
        await until(() => f.receivers[0].sessions[0]?.audioPackets > 0);
        await until(() =>
          [1, 2].every((id) => f.players.get(id).playerView().state === 'stop')
        );
        assertEquals(f.receivers[0].sessions.length, 1);
        assertEquals(
          f.traces.filter((trace) => trace.ports.has(f.receivers[0].port))
            .length,
          1,
        );
        assert(f.outputs.get('90'), 'unidentified address-only entry survives');
        await f.libraryProof();
      } finally {
        await f.close();
      }
    },
  });
}
