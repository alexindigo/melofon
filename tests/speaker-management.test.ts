import { assert, assertEquals } from '@std/assert';
import { apiFixture, error } from './helpers/api.ts';
import { createOutputs } from '../src/player.ts';
import { createPersistence } from '../src/persistence.ts';
import { createSpeakers } from '../src/speakers.ts';
import { createAirplayDevices } from '../src/boots/airplay-device.ts';
import { createAirplayDiscovery } from '../src/boots/airplay-mdns.ts';
import type { MdnsService } from '../src/mdns.ts';

const receiver: MdnsService = {
  name: '001122334455@Kitchen._raop._tcp.local',
  host: 'kitchen.local',
  address: '192.0.2.10',
  port: 7000,
  ttlMs: 120000,
  txt: { tp: 'UDP', am: 'AppleTV3,1' },
};

async function fixture(dir?: string) {
  let devices!: ReturnType<typeof createAirplayDevices>;
  let discovery!: ReturnType<typeof createAirplayDiscovery>;
  let outputs!: ReturnType<typeof createOutputs>;
  let persistence!: ReturnType<typeof createPersistence>;
  let announce!: (event: 'up' | 'down', service: MdnsService) => void;
  let answer: MdnsService | Promise<MdnsService> | null = null;
  let lookups = 0, starts = 0;
  let failSave = false;
  const f = await apiFixture({
    storeDir: dir,
    hats: {
      layersRoot: 'layers',
      extraPorts: 1,
      env: ([port]) => ({ MELOFON_LISTEN_owntone: `${port},${port}` }),
    },
    services: async (f) => {
      persistence = createPersistence(f.store);
      outputs = createOutputs({
        persistence: {
          ...persistence,
          adoptOutput: (row) =>
            failSave
              ? Promise.reject(new Error('private store fault'))
              : persistence.adoptOutput!(row),
        },
        notify: f.notify,
      });
      const saved = await persistence.loadOutputs();
      devices = createAirplayDevices({
        outputs,
        resolver: {
          resolve() {
            lookups++;
            return answer
              ? Promise.resolve(answer)
              : Promise.reject(new Error('offline'));
          },
          close() {},
        },
        spawn() {
          starts++;
          throw new Error('configuration cannot start playback');
        },
      });
      for (const row of saved) devices.register(row);
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
        airplay: devices,
        outputAdmission: devices.admission,
        speakers: createSpeakers({
          outputs,
          adapterView: (id) => ({
            preparation: devices.admission.describe(id),
          }),
          registerAddress: devices.registerAddress,
        }),
      };
    },
  });
  if (!(await f.store.users.credentials({ username: 'member' }))) {
    await f.auth.users.create(f.admin.id, {
      username: 'member',
      password: 'password-member',
      role: 'user',
    });
  }
  const { credential } = await f.login('bearer', 'member', 'password-member');
  const read = async () => {
    const r = await f.get('/api/v1/speakers', credential);
    assertEquals(r.status, 200);
    return (await r.json()).speakers;
  };
  const write = (path: string, method: string, body: unknown) =>
    f.json(`/api/v1/speakers${path}`, method, body, credential);
  const speaker = async (response: Response, status = 200) => {
    assertEquals(response.status, status, await response.clone().text());
    return (await response.json()).speaker;
  };
  return {
    f,
    outputs,
    devices,
    persistence,
    credential,
    read,
    write,
    speaker,
    answer: (value: MdnsService | Promise<MdnsService> | null) => {
      answer = value;
    },
    announce: (value = receiver) => announce('up', value),
    effects: () => ({ lookups, starts }),
    failSave: (value: boolean) => {
      failSave = value;
    },
    async close() {
      discovery.close();
      devices.close();
      await persistence.drain();
      await f.close();
    },
  };
}

Deno.test('speaker writes enforce login, Origin and core input validity for cookie/Bearer members', async () => {
  const t = await fixture();
  try {
    const input = { protocol: 'AirPlay', address: '192.0.2.20' };
    await error(
      await t.f.json('/api/v1/speakers', 'POST', input),
      401,
      'unauthenticated',
    );
    await error(
      await t.f.json(
        '/api/v1/speakers',
        'POST',
        input,
        t.credential,
        'http://other.home',
      ),
      403,
      'origin',
    );
    for (const body of [null, [], 'x']) {
      await error(await t.write('', 'POST', body), 400, 'not_json');
    }
    for (
      const body of [
        {},
        { ...input, protocol: 'Chromecast' },
        { ...input, address: '' },
        { ...input, address: 'http://room.home/audio' },
        { ...input, address: 'bad host' },
        { ...input, port: 0 },
        { ...input, port: 65536 },
        { ...input, port: 1.5 },
        { ...input, name: '' },
        { ...input, name: 7 },
        { ...input, connectionStrategy: 'OwnTone' },
      ]
    ) {
      await error(
        await t.write('', 'POST', body),
        400,
        'protocol' in body && body.protocol === 'Chromecast'
          ? 'unsupported_protocol'
          : 'invalid_field',
      );
    }
    await error(
      await t.write('', 'POST', { ...input, selected: true }),
      400,
      'unknown_field',
    );
    for (const mode of ['cookie', 'bearer'] as const) {
      const { credential } = await t.f.login(mode, 'member', 'password-member');
      const row = await t.speaker(
        await t.f.json('/api/v1/speakers', 'POST', input, credential),
        201,
      );
      assertEquals(row.adopted, true);
      assertEquals(row.selected, false);
      assertEquals(row.state.preparation.state, 'failed');
    }
    await error(await t.write('/missing/adopt', 'POST', {}), 404, 'not_found');
    await error(
      await t.write('/missing', 'PATCH', { connectionStrategy: 'melofon' }),
      404,
      'not_found',
    );
    assertEquals((await t.read()).length, 1);
    assertEquals(t.effects().starts, 0);
  } finally {
    await t.close();
  }
});

Deno.test('speaker HTTP address/adopt/strategy configuration is durable without selecting or adopting temporary edits', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'speaker-management-' });
  let configuredId = '', discoveredId = '';
  try {
    const t = await fixture(dir);
    try {
      await t.f.state.set('airplay.mdns', 'off');
      t.answer(receiver);
      const configured = await t.speaker(
        await t.write('', 'POST', {
          protocol: 'AirPlay',
          address: ' KITCHEN.local. ',
          name: 'My Kitchen',
          connectionStrategy: 'owntone',
        }),
        201,
      );
      configuredId = configured.id;
      assertEquals(configured.address, 'kitchen.local');
      assertEquals(configured.name, 'My Kitchen');
      assertEquals(configured.adopted, true);
      assertEquals(configured.selected, false);
      assertEquals(configured.state.preparation.state, 'ready');
      assertEquals(
        t.effects().lookups > 0,
        true,
        'target-only lookup works with browsing off',
      );
      const repeated = await t.speaker(
        await t.write('', 'POST', {
          protocol: 'AirPlay',
          address: 'kitchen.local',
        }),
        201,
      );
      assertEquals(repeated.id, configuredId);
      assertEquals(repeated.name, 'My Kitchen');
      assertEquals(repeated.connectionStrategy, 'owntone');
      await t.speaker(
        await t.write(`/${configuredId}`, 'PATCH', {
          connectionStrategy: 'melofon',
        }),
      );
      await t.f.state.set('airplay.mdns', 'on');
      t.announce({
        ...receiver,
        name: '001122334466@Office._raop._tcp.local',
        address: '192.0.2.11',
      });
      const temporary = (await t.read()).find((r: { adopted: boolean }) =>
        !r.adopted
      );
      discoveredId = temporary.id;
      const edited = await t.speaker(
        await t.write(`/${discoveredId}`, 'PATCH', {
          connectionStrategy: 'owntone',
        }),
      );
      assertEquals(edited.adopted, false);
      assertEquals(
        await t.f.store.speakers.loadAdopted().then((rows) => rows.length),
        1,
      );
      for (const body of [{ selected: true }, { volume: 50 }, { name: 'x' }]) {
        await error(
          await t.write(`/${discoveredId}`, 'PATCH', body),
          400,
          'unknown_field',
        );
      }
      await error(
        await t.write(`/${discoveredId}`, 'PATCH', {}),
        400,
        'invalid_field',
      );
      await error(
        await t.write(`/${discoveredId}`, 'PATCH', {
          connectionStrategy: 'bad',
        }),
        400,
        'invalid_field',
      );
      for (let i = 0; i < 2; i++) {
        const adopted = await t.speaker(
          await t.write(`/${discoveredId}/adopt`, 'POST', {}),
        );
        assertEquals(adopted.adopted, true);
        assertEquals(adopted.selected, false);
      }
      assertEquals(t.effects().starts, 0);
    } finally {
      await t.close();
    }
    const next = await fixture(dir);
    try {
      const rows = await next.read();
      assertEquals(rows.length, 2);
      for (const row of rows) {
        assertEquals(row.adopted, true);
        assertEquals(row.selected, false);
        assertEquals(row.state.preparation.state, 'unresolved');
      }
      assertEquals(
        rows.find((r: { id: string }) => r.id === configuredId)
          .connectionStrategy,
        'melofon',
      );
      assertEquals(
        rows.find((r: { id: string }) => r.id === discoveredId)
          .connectionStrategy,
        'owntone',
      );
      const own = await fetch(
        `http://melofon.home:${next.f.extraPorts[0]}/api/outputs`,
      );
      assertEquals(
        (await own.json()).outputs.map((r: { id: string }) => r.id).sort(),
        rows.map((r: { id: string }) => r.id).sort(),
      );
    } finally {
      await next.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('manual and mDNS receiver identity reconcile without transferring configuration to a reused address', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'speaker-identities-' });
  let manualId = '';
  try {
    const t = await fixture(dir);
    try {
      // Offline configuration has an address identity until a receiver is acquired.
      const manual = await t.speaker(
        await t.write('', 'POST', {
          protocol: 'AirPlay',
          address: receiver.address,
          name: 'Saved room',
        }),
        201,
      );
      manualId = manual.id;
      t.answer(receiver);
      await t.speaker(
        await t.write('', 'POST', {
          protocol: 'AirPlay',
          address: receiver.address,
        }),
        201,
      );
      t.announce();
      assertEquals((await t.read()).length, 1);
      assertEquals((await t.read())[0].id, manualId);
      const alias = await t.speaker(
        await t.write('', 'POST', {
          protocol: 'AirPlay',
          address: 'kitchen.local',
        }),
        201,
      );
      assertEquals(alias.id, manualId);
      assertEquals((await t.read()).length, 1);
      t.outputs.update(manualId, { volume: 29 });
      t.announce({ ...receiver, address: '192.0.2.12' });
      assertEquals((await t.read()).length, 1);
      assertEquals((await t.read())[0].address, '192.0.2.12');
      assertEquals((await t.read())[0].volume, 29);
    } finally {
      await t.close();
    }
    const next = await fixture(dir);
    try {
      // Reopen must retain the receiver binding, not only its most recent IP.
      const stranger = {
        ...receiver,
        name: '001122334477@Stranger._raop._tcp.local',
        address: '192.0.2.12',
      };
      next.answer(stranger);
      const refused = await next.speaker(
        await next.write('', 'POST', {
          protocol: 'AirPlay',
          address: '192.0.2.12',
        }),
        201,
      );
      assertEquals(refused.id, manualId);
      assertEquals(refused.state.preparation.state, 'failed');
      next.announce(stranger);
      const rows = await next.read();
      assertEquals(rows.length, 2);
      const other = rows.find((r: { id: string }) => r.id !== manualId);
      assertEquals(other.adopted, false);
      assertEquals(other.volume, 100);
      assertEquals(other.selected, false);
      assertEquals(
        rows.find((r: { id: string }) => r.id === manualId).name,
        'Saved room',
      );
      next.announce({ ...stranger, txt: { ...stranger.txt, pw: 'true' } });
      assertEquals(
        (await next.read()).length,
        2,
        'password advertisements obey the same identity boundary',
      );
      assertEquals(next.effects().starts, 0);
    } finally {
      await next.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('speaker HTTP adoption reports a safe durability failure and remains retryable', async () => {
  const t = await fixture();
  try {
    t.announce();
    const id = (await t.read())[0].id;
    t.failSave(true);
    const failure = await error(
      await t.write(`/${id}/adopt`, 'POST', {}),
      500,
      'persistence_failed',
    );
    assert(!JSON.stringify(failure).includes('private store fault'));
    assertEquals((await t.read())[0].adopted, false);
    assertEquals(await t.f.store.speakers.loadAdopted(), []);
    t.failSave(false);
    assertEquals(
      (await t.speaker(await t.write(`/${id}/adopt`, 'POST', {}))).adopted,
      true,
    );
    assertEquals((await t.f.store.speakers.loadAdopted()).length, 1);
  } finally {
    await t.close();
  }
});

Deno.test('speaker HTTP forget is durable across queued preferences, discovery and reopen', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'speaker-forget-' });
  try {
    const t = await fixture(dir);
    try {
      t.announce();
      const id = (await t.read())[0].id;
      await error(
        await t.write(`/${id}`, 'DELETE', undefined),
        409,
        'not_adopted',
      );
      await t.speaker(await t.write(`/${id}/adopt`, 'POST', {}));
      t.outputs.update(id, {
        selected: true,
        volume: 24,
        connectionStrategy: 'owntone',
      });
      const response = await t.write(`/${id}`, 'DELETE', undefined);
      assertEquals(response.status, 204, await response.text());
      assertEquals(t.persistence.savedOutput(id), undefined);
      t.announce();
      const row = (await t.read())[0];
      assertEquals(row.adopted, false);
      assertEquals(row.selected, false);
      assertEquals(row.volume, 100);
      assertEquals(row.connectionStrategy, 'melofon');
      t.outputs.update(id, { selected: true, volume: 17 });
      await t.persistence.drain();
      assertEquals(await t.f.store.speakers.loadAdopted(), []);
      assertEquals(await t.f.store.playback.loadOutputs(), []);
      assertEquals(await t.f.store.speakers.loadIgnored(), []);
    } finally {
      await t.close();
    }
    const next = await fixture(dir);
    try {
      assertEquals(await next.read(), []);
      next.announce();
      assertEquals((await next.read())[0].adopted, false);
    } finally {
      await next.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('speaker forget enforces auth and Origin and shares durable operator deletion', async () => {
  const t = await fixture();
  try {
    t.announce();
    const id = (await t.read())[0].id;
    await t.speaker(await t.write(`/${id}/adopt`, 'POST', {}));
    await error(
      await t.f.json(`/api/v1/speakers/${id}`, 'DELETE', undefined),
      401,
      'unauthenticated',
    );
    await error(
      await t.f.json(
        `/api/v1/speakers/${id}`,
        'DELETE',
        undefined,
        t.credential,
        'http://other.home',
      ),
      403,
      'origin',
    );
    await error(
      await t.write('/missing', 'DELETE', undefined),
      404,
      'not_found',
    );
    const response = await t.f.json(
      `/_/outputs/${id}`,
      'DELETE',
      undefined,
      undefined,
      null,
      true,
    );
    assertEquals(response.status, 200, await response.clone().text());
    await response.json();
    assertEquals(t.persistence.savedOutput(id), undefined);
    assertEquals(await t.f.store.speakers.loadAdopted(), []);
    t.announce();
    const conflict = await t.f.json(
      `/_/outputs/${id}`,
      'DELETE',
      undefined,
      undefined,
      null,
      true,
    );
    assertEquals(conflict.status, 409);
    await conflict.body?.cancel();
    await error(
      await t.write(`/${id}`, 'DELETE', undefined),
      409,
      'not_adopted',
    );
    const { credential } = await t.f.login(
      'cookie',
      'member',
      'password-member',
    );
    await t.speaker(await t.write(`/${id}/adopt`, 'POST', {}));
    const gone = await t.f.json(
      `/api/v1/speakers/${id}`,
      'DELETE',
      undefined,
      credential,
    );
    assertEquals(gone.status, 204);
  } finally {
    await t.close();
  }
});

Deno.test('forget fences an in-flight adoption and advertisements during its durable write', async () => {
  const t = await fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    t.announce();
    const id = (await t.read())[0].id;
    await t.speaker(await t.write(`/${id}/adopt`, 'POST', {}));
    const save = t.f.store.speakers.saveAdopted;
    const entered = Promise.withResolvers<void>();
    t.f.store.speakers.saveAdopted = async (row) => {
      entered.resolve();
      await held;
      await save(row);
    };
    const adopting = t.write(`/${id}/adopt`, 'POST', {});
    await entered.promise;
    const deleting = t.write(`/${id}`, 'DELETE', undefined);
    // GET is ordered after the DELETE reached core, without a timing sleep.
    for (let i = 0; (await t.read()).length; i++) {
      assert(i < 100, 'forget removes the runtime entry before awaiting disk');
    }
    t.announce();
    assertEquals(await t.read(), []);
    release();
    await error(await adopting, 404, 'not_found');
    const deleted = await deleting;
    assertEquals(deleted.status, 204, await deleted.text());
    t.announce();
    assertEquals((await t.read())[0].adopted, false);
    await t.persistence.drain();
    assertEquals(t.persistence.savedOutput(id), undefined);
    assertEquals(await t.f.store.playback.loadOutputs(), []);
  } finally {
    release();
    await t.close();
  }
});

Deno.test('forget defeats a late address lookup even when the same receiver is rediscovered', async () => {
  const t = await fixture();
  const reply = Promise.withResolvers<MdnsService>();
  try {
    t.announce();
    const id = (await t.read())[0].id;
    await t.speaker(await t.write(`/${id}/adopt`, 'POST', {}));
    t.answer(reply.promise);
    const before = t.effects().lookups;
    const adding = t.write('', 'POST', {
      protocol: 'AirPlay',
      address: receiver.address,
      port: receiver.port,
    });
    for (let i = 0; t.effects().lookups === before; i++) {
      assert(i < 100, 'address lookup starts');
      await t.read();
    }
    const deleted = await t.write(`/${id}`, 'DELETE', undefined);
    assertEquals(deleted.status, 204, await deleted.text());
    t.announce();
    reply.resolve(receiver);
    await error(await adding, 404, 'not_found');
    assertEquals((await t.read())[0].adopted, false);
    await t.persistence.drain();
    assertEquals(await t.f.store.playback.loadOutputs(), []);
  } finally {
    reply.resolve(receiver);
    await t.close();
  }
});

Deno.test('speaker HTTP forget reports delete failure safely and permits a durable retry', async () => {
  const t = await fixture();
  try {
    t.announce();
    const id = (await t.read())[0].id;
    await t.speaker(await t.write(`/${id}/adopt`, 'POST', {}));
    t.outputs.update(id, { selected: true });
    await t.persistence.drain();
    const remove = t.f.store.speakers.deleteAdopted;
    t.f.store.speakers.deleteAdopted = () =>
      Promise.reject(new Error('private delete fault'));
    const failure = await error(
      await t.write(`/${id}`, 'DELETE', undefined),
      500,
      'persistence_failed',
    );
    assert(!JSON.stringify(failure).includes('private delete fault'));
    assertEquals((await t.read())[0].adopted, true);
    assertEquals((await t.read())[0].selected, false);
    assertEquals((await t.f.store.speakers.loadAdopted()).length, 1);
    t.f.store.speakers.deleteAdopted = remove;
    const deleted = await t.write(`/${id}`, 'DELETE', undefined);
    assertEquals(deleted.status, 204, await deleted.text());
    assertEquals(t.persistence.savedOutput(id), undefined);
    assertEquals(await t.f.store.playback.loadOutputs(), []);
  } finally {
    await t.close();
  }
});

Deno.test('an address alias resolving after forget cannot re-adopt the forgotten receiver', async () => {
  const t = await fixture();
  const reply = Promise.withResolvers<MdnsService>();
  try {
    t.announce();
    const id = (await t.read())[0].id;
    await t.speaker(await t.write(`/${id}/adopt`, 'POST', {}));
    t.answer(reply.promise);
    const before = t.effects().lookups;
    const adding = t.write('', 'POST', {
      protocol: 'AirPlay',
      address: 'alias.local',
    });
    for (let i = 0; t.effects().lookups === before; i++) {
      assert(i < 100, 'alias lookup starts');
      await t.read();
    }
    const deleted = await t.write(`/${id}`, 'DELETE', undefined);
    assertEquals(deleted.status, 204, await deleted.text());
    t.announce();
    reply.resolve(receiver);
    await error(await adding, 404, 'not_found');
    const rows = await t.read();
    assertEquals(rows.length, 1);
    assertEquals(rows[0].adopted, false);
    await t.persistence.drain();
    assertEquals(await t.f.store.playback.loadOutputs(), []);
  } finally {
    reply.resolve(receiver);
    await t.close();
  }
});
