// Native settings → output/cache/DB → reopen → native settings consumer.
import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { createNotify } from '../src/notify.ts';
import { createOutputs } from '../src/player.ts';
import { createSpeakers } from '../src/speakers.ts';
import { createPersistence } from '../src/persistence.ts';
import { createState } from '../src/state.ts';
import { createAirplayDiscovery } from '../src/boots/airplay-mdns.ts';
import type { MdnsService } from '../src/mdns.ts';
import { createTestAirplayDevices } from './helpers/airplay-devices.ts';
import { captureLogs } from './helpers/logging.ts';

const KEY = 'airplay.connectionStrategy.default';
const source = { kind: 'internal' as const, via: 'strategy-test' };
const registration = (id: string) => ({
  id,
  name: id,
  type: 'AirPlay',
  host: '192.0.2.200',
  selected: false,
  volume: 100,
});
const strategy = (value: unknown) =>
  (value as { connectionStrategy: string }).connectionStrategy;
async function ready(outputs: ReturnType<typeof createOutputs>) {
  await (outputs as unknown as { ready?: () => Promise<void> }).ready?.();
}

async function setup(dir?: string) {
  const data = dir ?? await Deno.makeTempDir({ prefix: 'melofon-strategy-' });
  const store = await openStore(data);
  const db = store;
  const persistence = createPersistence(store);
  const state = createState(store);
  const notify = createNotify();
  const deps = { persistence, state, notify };
  const outputs = createOutputs(deps);
  await ready(outputs);
  await persistence.loadOutputs();
  const devices = createTestAirplayDevices(outputs);
  const core = await pathfinder({
    roots: ['core/'],
    app: {
      log: captureLogs().log,
      outputs,
      state,
      airplay: devices,
      speakers: createSpeakers({
        outputs,
        registerAddress: devices.registerAddress,
        adapterView: (id) => ({ preparation: devices.admission.describe(id) }),
      }),
      outputAdmission: devices.admission,
    },
  });
  return { data, db, persistence, outputs, state, core };
}

Deno.test('strategies: normalized default and explicit choice survive same-ID registration/gaps', () => {
  const outputs = createOutputs();
  outputs.register(registration('1'), source);
  assertEquals(strategy(outputs.get('1')), 'melofon');
  const explicit = {
    ...registration('1'),
    connectionStrategy: 'owntone' as const,
  };
  outputs.register(explicit, source);
  assertEquals(strategy(outputs.get('1')), 'owntone');
  outputs.register({ ...registration('1'), host: '192.0.2.201' }, source);
  assertEquals(strategy(outputs.get('1')), 'owntone');
});

Deno.test('strategies: invalid mixed strategy command has zero state/save/PIN/notify effects', () => {
  const notify = createNotify();
  let saves = 0, pins = 0, emits = 0;
  const outputs = createOutputs({
    notify,
    persistence: { saveOutput: () => saves++ },
  });
  outputs.register(registration('1'), source);
  outputs.onCommand(() => pins++);
  notify.subscribe(() => emits++);
  const before = outputs.get('1');
  const invalid = {
    connectionStrategy: 'TYPO',
    selected: true,
    volume: 7,
    pin: '1234',
  };
  assertThrows(() =>
    outputs.update(
      '1',
      invalid as unknown as Parameters<typeof outputs.update>[1],
      source,
    )
  );
  assertEquals(outputs.get('1'), before);
  assertEquals([saves, pins, emits], [0, 0, 0]);
});

Deno.test('strategies: invalid known state value is rejected before SQL or onChange', async () => {
  const s = await setup();
  try {
    let changes = 0;
    s.state.onChange(() => changes++);
    const before = await s.state.get(KEY);
    await assertRejects(() => s.state.set(KEY, 'OwnTone'));
    await assertRejects(() => s.state.seedIfUnset(KEY, 'bad'));
    assertEquals(await s.state.get(KEY), before);
    assertEquals(changes, 0);
  } finally {
    await s.db.close();
    await Deno.remove(s.data, { recursive: true });
  }
});

Deno.test('strategies: native API, new-ID default, saved-cache gap and reopen preserve choices', async () => {
  const s = await setup();
  let next: Awaited<ReturnType<typeof setup>> | undefined;
  const jsonPut = (url: string, body: unknown) =>
    s.core(
      new Request(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  try {
    assertEquals(await s.state.get(KEY), null);
    assertEquals(await s.state.getTyped(KEY), 'melofon');
    s.outputs.register(registration('1'), source);
    await s.outputs.adopt('1');
    let result = await jsonPut('http://x/outputs/1', {
      connectionStrategy: 'audiostation',
    });
    assertEquals(result.status, 200);
    assertEquals(strategy((await result.json()).output), 'audiostation');
    result = await jsonPut(`http://x/config/${KEY}`, { value: 'owntone' });
    assertEquals(result.status, 200);
    assertEquals(strategy(s.outputs.get('1')), 'audiostation');
    s.outputs.register(registration('2'), source);
    await s.outputs.adopt('2');
    assertEquals(strategy(s.outputs.get('2')), 'owntone');
    s.outputs.update('1', { selected: true, volume: 42 }, source);
    s.outputs.unregister('1', source);
    s.outputs.register(registration('1'), source);
    assertEquals(strategy(s.outputs.get('1')), 'audiostation');
    assertEquals(strategy(s.persistence.savedOutput('1')), 'audiostation');
    for (const bad of ['OWNTONE', '', null, 1]) {
      assertEquals(
        (await jsonPut('http://x/outputs/1', { connectionStrategy: bad }))
          .status,
        400,
      );
    }
    assertEquals(
      (await jsonPut('http://x/outputs/999', { connectionStrategy: 'melofon' }))
        .status,
      404,
    );
    await s.persistence.drain();
    await s.db.close();
    next = await setup(s.data);
    const rows = await next.persistence.loadOutputs();
    for (const row of rows) next.outputs.register(row, source);
    assertEquals(strategy(next.outputs.get('1')), 'audiostation');
    assertEquals(strategy(next.outputs.get('2')), 'owntone');
    next.outputs.register(registration('3'), source);
    assertEquals(strategy(next.outputs.get('3')), 'owntone');
    const get = await next.core(new Request('http://x/outputs'));
    assertEquals((await get.json()).outputs.map(strategy), [
      'audiostation',
      'owntone',
      'owntone',
    ]);
  } finally {
    await (next?.persistence ?? s.persistence).drain();
    await (next?.db ?? s.db).close();
    await Deno.remove(s.data, { recursive: true });
  }
});

Deno.test('strategies: invalid POST rejected before host resolution', async () => {
  const outputs = createOutputs();
  let resolves = 0;
  const core = await pathfinder({
    roots: ['core/'],
    app: {
      outputs,
      airplay: {
        resolve: () => {
          resolves++;
          return Promise.resolve(null);
        },
      },
    },
  });
  const res = await core(
    new Request('http://x/outputs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...registration('1'),
        connectionStrategy: 'invalid',
      }),
    }),
  );
  assertEquals(res.status, 400);
  assertEquals(resolves, 0);
  assertEquals(outputs.list(), []);
});

Deno.test('strategies: migration backfills legacy Melofon, does not overwrite saved choice; corrupt values fail visibly', async () => {
  const s = await setup();
  try {
    await rawSql(s.db).run(
      'ALTER TABLE output_state DROP COLUMN IF EXISTS connection_strategy',
    );
    await rawSql(s.db).run(
      "INSERT INTO output_state (id,name,type,player_id,volume,adopted) VALUES ('legacy','old','AirPlay',NULL,100,true)",
    );
    await s.state.set(KEY, 'owntone');
    await s.db.close();
    const store = await openStore(s.data);
    const db = store;
    try {
      const p = createPersistence(store);
      assertEquals(strategy((await p.loadOutputs())[0]), 'melofon');
      await rawSql(db).run(
        "UPDATE output_state SET connection_strategy='corrupt' WHERE id='legacy'",
      );
      await assertRejects(() => p.loadOutputs());
    } finally {
      await db.close();
    }
  } finally {
    await Deno.remove(s.data, { recursive: true });
  }
});

Deno.test('strategies: late initial default read cannot undo a newer live write', async () => {
  const listeners = new Set<(key: string, value: string) => void>();
  let release!: (value: string) => void;
  let reading = false;
  const state = {
    declare() {},
    get: () => Promise.resolve(null),
    getWithRevision: () => Promise.resolve({ value: null, revision: 0 }),
    getTyped: () => {
      reading = true;
      return new Promise<string>((resolve) => release = resolve);
    },
    seedIfUnset: () => Promise.resolve(false),
    set: (key: string, value: string) => {
      for (const fn of listeners) fn(key, value);
      return Promise.resolve();
    },
    list: () => Promise.resolve({}),
    onChange: (fn: (key: string, value: string) => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  const outputs = createOutputs({ state });
  assertThrows(() => outputs.register(registration('1')));
  await Promise.resolve();
  assert(reading);
  await state.set(KEY, 'owntone');
  release('melofon');
  await ready(outputs);
  outputs.register(registration('1'));
  assertEquals(strategy(outputs.get('1')), 'owntone');
});

Deno.test('strategies: failed or invalid initial read never assigns an irreversible default', async () => {
  for (const value of ['corrupt', null]) {
    const state = {
      declare() {},
      get: () => Promise.resolve(null),
      getWithRevision: () => Promise.resolve({ value: null, revision: 0 }),
      getTyped: () =>
        value === null
          ? Promise.reject(new Error('read failed'))
          : Promise.resolve(value),
      seedIfUnset: () => Promise.resolve(false),
      set: () => Promise.resolve(),
      list: () => Promise.resolve({}),
      onChange: () => () => {},
    };
    const outputs = createOutputs({ state });
    await assertRejects(() => ready(outputs));
    assertThrows(() => outputs.register(registration('1')));
    assertEquals(outputs.list(), []);
  }
});

Deno.test('all three native choices survive real discovery registration gaps, unrelated writes and disk reopen', async () => {
  const s = await setup();
  let next: Awaited<ReturnType<typeof setup>> | undefined;
  let announce:
    | ((event: 'up' | 'down', service: MdnsService) => void)
    | undefined;
  const discovery = createAirplayDiscovery({
    devices: createTestAirplayDevices(s.outputs),
    outputs: s.outputs,
    state: s.state,
    savedOutput: (id) => s.persistence.savedOutput(id),
    createBrowser: (callback) => {
      announce = callback;
      return { close() {}, resolve() {} };
    },
    log: { event() {} },
  });
  const choices = ['melofon', 'owntone', 'audiostation'];
  const service = (id: number, fresh = false): MdnsService => ({
    name: `${id.toString(16).padStart(12, '0')}@choice-${id}._raop._tcp.local`,
    host: `choice-${id}.local`,
    address: `127.0.0.${id + (fresh ? 20 : 10)}`,
    port: 7000,
    ttlMs: 120000,
    txt: { tp: 'UDP', am: fresh ? 'AppleTV5,3' : 'AppleTV3,1' },
  });
  try {
    const deadline = performance.now() + 2000;
    while (!announce) {
      assert(performance.now() < deadline);
      await new Promise((ok) => setTimeout(ok, 1));
    }
    for (let i = 1; i <= 3; i++) {
      announce('up', service(i));
      await s.outputs.adopt(String(i));
      const put = await s.core(
        new Request(`http://x/outputs/${i}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ connectionStrategy: choices[i - 1] }),
        }),
      );
      assertEquals(put.status, 200);
      await put.json();
      s.outputs.update(String(i), { selected: true, volume: 42 });
    }
    await s.state.set(KEY, 'audiostation');
    for (let i = 1; i <= 3; i++) {
      announce('down', service(i));
      assertEquals(s.outputs.lifetime(String(i)), {
        adopted: true,
        discovered: false,
      });
      announce('up', service(i, true));
      assertEquals(
        s.outputs.get(String(i))?.connectionStrategy,
        choices[i - 1],
      );
      assertEquals(s.outputs.get(String(i))?.volume, 42);
      assertEquals(s.outputs.get(String(i))?.selected, true);
      assertEquals(s.outputs.get(String(i))?.model, 'AppleTV5,3');
    }
    discovery.close();
    await s.persistence.drain();
    await s.db.close();
    next = await setup(s.data);
    for (const row of await next.persistence.loadOutputs()) {
      next.outputs.register(row);
    }
    const get = await next.core(new Request('http://x/outputs'));
    const rows = (await get.json()).outputs;
    assertEquals(rows.map(strategy), choices);
    assert(
      rows.every((row: { volume: number; selected: boolean }) =>
        row.volume === 42 && row.selected
      ),
    );
  } finally {
    discovery.close();
    await (next?.persistence ?? s.persistence).drain();
    await (next?.db ?? s.db).close();
    await Deno.remove(s.data, { recursive: true });
  }
});
