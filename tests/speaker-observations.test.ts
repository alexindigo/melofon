import { assert, assertEquals } from '@std/assert';
import { apiFixture } from './helpers/api.ts';
import { createOutputs } from '../src/player.ts';
import { createPersistence } from '../src/persistence.ts';
import { createSpeakers } from '../src/speakers.ts';
import { createAirplayDevices } from '../src/boots/airplay-device.ts';
import { createAirplayDiscovery } from '../src/boots/airplay-mdns.ts';
import type { MdnsService } from '../src/mdns.ts';
import { openStore } from '../src/store/index.ts';

const service: MdnsService = {
  name: '001122334455@Kitchen._raop._tcp.local',
  host: 'kitchen.local',
  address: '192.0.2.10',
  port: 7000,
  ttlMs: 120000,
  txt: { tp: 'UDP', am: 'AppleTV3,1' },
};
const id = BigInt('0x001122334455').toString();

async function fixture(dir: string) {
  let announce!: (event: 'up' | 'down', svc: MdnsService) => void;
  let devices!: ReturnType<typeof createAirplayDevices>;
  let discovery!: ReturnType<typeof createAirplayDiscovery>;
  let persistence!: ReturnType<typeof createPersistence>;
  let outputs!: ReturnType<typeof createOutputs>;
  const f = await apiFixture({
    storeDir: dir,
    hats: {
      layersRoot: 'layers',
      extraPorts: 1,
      env: ([port]) => ({ MELOFON_LISTEN_owntone: `${port},${port}` }),
    },
    services: async (f) => {
      persistence = createPersistence(f.store);
      outputs = createOutputs({ persistence, notify: f.notify });
      const saved = await persistence.loadOutputs();
      devices = createAirplayDevices({
        outputs,
        resolver: {
          resolve: () => Promise.reject(new Error('offline')),
          close() {},
        },
        spawn: () => {
          throw new Error('no playback in observation test');
        },
      });
      // Same restore path as the server: saved preferences, no service facts.
      for (const row of saved) {
        devices.register(row, { kind: 'internal', via: 'restore' });
      }
      discovery = createAirplayDiscovery({
        outputs,
        devices,
        state: f.state,
        savedOutput: (id) => persistence.savedOutput(id),
        createBrowser(callback) {
          announce = callback;
          return { resolve() {}, close() {} };
        },
      });
      await f.state.getTyped('airplay.mdns');
      return {
        outputs,
        speakers: createSpeakers({
          outputs,
          registerAddress: devices.registerAddress,
          adapterView: (id) => ({
            preparation: devices.admission.describe(id),
          }),
        }),
      };
    },
  });
  const { credential } = await f.login('bearer');
  const read = async () => {
    const response = await f.get('/api/v1/speakers', credential);
    assertEquals(response.status, 200);
    return (await response.json()).speakers;
  };
  const own = async (path = '', method = 'GET', body?: unknown) => {
    const response = await fetch(
      `http://melofon.home:${f.extraPorts[0]}/api/outputs${path}`,
      {
        method,
        signal: AbortSignal.timeout(5000),
        ...(body === undefined ? {} : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      },
    );
    const text = await response.text();
    assert(response.ok, text);
    return text ? JSON.parse(text) : undefined;
  };
  return {
    f,
    outputs,
    devices,
    persistence,
    read,
    own,
    announce: (event: 'up' | 'down') => announce(event, service),
    async close() {
      discovery.close();
      devices.close();
      await persistence.drain();
      await f.close();
    },
  };
}

Deno.test('discovery and every control save path stay temporary across HTTP reads and reopen', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'speaker-observations-' });
  try {
    const t = await fixture(dir);
    try {
      t.announce('up');
      assertEquals((await t.read())[0].adopted, false);
      assertEquals((await t.own()).outputs[0].id, id);
      await t.own('/set', 'PUT', { outputs: [id] });
      await t.own(`/${id}/toggle`, 'PUT');
      await t.own(`/${id}`, 'PUT', { selected: true, volume: 37 });
      t.outputs.update(id, { connectionStrategy: 'owntone' });
      t.announce('up');
      await t.persistence.drain();
      const row = (await t.read())[0];
      assertEquals(row.selected, true);
      assertEquals(row.volume, 37);
      assertEquals(row.connectionStrategy, 'owntone');
      assertEquals(row.adopted, false);
      assertEquals(await t.f.store.playback.loadOutputs(), []);
      assertEquals(t.persistence.savedOutput(id), undefined);
    } finally {
      await t.close();
    }
    const next = await fixture(dir);
    try {
      assertEquals(await next.read(), []);
      assertEquals((await next.own()).outputs, []);
      next.announce('up');
      assertEquals((await next.read())[0].selected, false);
      assertEquals((await next.read())[0].volume, 100);
    } finally {
      await next.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('adopted discovery withdrawal keeps configuration but no live readiness across reopen', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'speaker-adopted-' });
  try {
    const store = await openStore(dir);
    await store.speakers.saveAdopted({
      id,
      name: 'Kitchen',
      type: 'AirPlay',
      host: service.address,
      port: 7000,
      selected: true,
      volume: 43,
      connectionStrategy: 'melofon',
    });
    await store.close();
    const t = await fixture(dir);
    try {
      let row = (await t.read())[0];
      assertEquals(row.adopted, true);
      assertEquals(row.state.preparation.state, 'unresolved');
      t.announce('up');
      assertEquals((await t.read())[0].state.preparation.state, 'ready');
      t.announce('down');
      row = (await t.read())[0];
      assertEquals(row.adopted, true);
      assertEquals(row.discovered, false);
      assertEquals(row.selected, true);
      assertEquals(row.state.preparation.state, 'unresolved');
      assertEquals((await t.own()).outputs[0].volume, 43);
      t.announce('up');
      await t.f.state.set('airplay.mdns', 'off');
      assertEquals((await t.read())[0].discovered, false);
      assertEquals((await t.read())[0].state.preparation.state, 'unresolved');
    } finally {
      await t.close();
    }
    const next = await fixture(dir);
    try {
      const row = (await next.read())[0];
      assertEquals(row.adopted, true);
      assertEquals(row.selected, true);
      assertEquals(row.state.preparation.state, 'unresolved');
    } finally {
      await next.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('manual and environment address configuration is adopted even offline; compatibility snapshots are not restored', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'speaker-addresses-' });
  try {
    const store = await openStore(dir);
    const temporary = {
      id: '77',
      name: 'Old observation',
      type: 'AirPlay',
      selected: true,
      volume: 42,
      host: '192.0.2.77',
      connectionStrategy: 'melofon' as const,
    };
    // S2's compatibility rows have no adoption authority.
    await store.playback.saveOutput(temporary);
    await store.speakers.saveAdopted({
      ...temporary,
      id: '88',
      name: 'No endpoint',
      host: undefined,
    });
    await store.close();
    const t = await fixture(dir);
    const ids: string[] = [];
    try {
      assertEquals((await t.read()).map((row: { id: string }) => row.id), [
        '88',
      ]);
      // Even a caller bypassing the registry cannot persist a temporary row.
      t.persistence.saveOutput({ ...temporary, id: '99' });
      for (
        const [index, via] of ['operator-post', 'airplay-host-env'].entries()
      ) {
        const row = await t.devices.registerAddress({
          name: via,
          host: `192.0.2.${90 + index}`,
          connectionStrategy: 'owntone',
        }, { kind: 'internal', via });
        assert(row);
        ids.push(row.id);
        const view = (await t.read()).find((view: { id: string }) =>
          view.id === row.id
        );
        assertEquals(view.adopted, true);
        assertEquals(view.discovered, false);
        assertEquals(view.state.preparation.state, 'failed');
      }
      await t.persistence.drain();
      assertEquals(
        (await t.f.store.playback.loadOutputs()).some((row) => row.id === '99'),
        false,
      );
    } finally {
      await t.close();
    }
    const next = await fixture(dir);
    try {
      const rows = await next.read();
      assertEquals(rows.length, 3);
      for (const id of ids) {
        const row = rows.find((row: { id: string }) => row.id === id);
        assertEquals(row.adopted, true);
        assertEquals(row.discovered, false);
        assertEquals(row.connectionStrategy, 'owntone');
        assertEquals(row.state.preparation.state, 'unresolved');
      }
    } finally {
      await next.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

for (const entry of ['discovery', 'address'] as const) {
  Deno.test(`invalid saved hosts cannot interrupt ${entry} matching or hide a valid alias`, async () => {
    const dir = await Deno.makeTempDir({ prefix: 'speaker-legacy-host-' });
    try {
      const store = await openStore(dir);
      for (
        const [id, host] of [['77', 'living_room.local'], ['88', '192.0.2.10.']]
      ) {
        await store.speakers.saveAdopted({
          id,
          host,
          name: 'Saved receiver',
          type: 'AirPlay',
          selected: false,
          volume: 43,
          connectionStrategy: 'melofon',
        });
      }
      await store.close();
      const t = await fixture(dir);
      try {
        if (entry === 'discovery') {
          t.announce('down');
          t.announce('up');
          const row = (await t.read()).find((r: { id: string }) =>
            r.id === '88'
          );
          assertEquals(row.discovered, true);
          assertEquals(row.state.preparation.state, 'ready');
          t.announce('down');
          assertEquals(
            (await t.read()).find((r: { id: string }) => r.id === '88')
              .discovered,
            false,
          );
          t.announce('up');
          assertEquals((await t.read()).length, 2);
        } else {
          const { credential } = await t.f.login('cookie');
          for (let i = 0; i < 2; i++) {
            const response = await t.f.json('/api/v1/speakers', 'POST', {
              protocol: 'AirPlay',
              address: '192.0.2.10',
            }, credential);
            assertEquals(response.status, 201);
            assertEquals((await response.json()).speaker.id, '88');
          }
          const invalid = await t.f.json('/api/v1/speakers', 'POST', {
            protocol: 'AirPlay',
            address: 'invalid_host.local',
          }, credential);
          assertEquals(invalid.status, 400);
          await invalid.text();
          assertEquals((await t.read()).length, 2);
        }
        const legacy = (await t.read()).find((r: { id: string }) =>
          r.id === '77'
        );
        assertEquals(legacy.address, 'living_room.local');
        assertEquals(legacy.adopted, true);
        assertEquals(legacy.discovered, false);
      } finally {
        await t.close();
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}
