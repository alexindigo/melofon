import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { createState, StateRevisionError } from '../src/state.ts';
import { SettingsValidationError } from '../src/settings-schema.ts';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { loadLayers } from '../src/layers.ts';
import { captureLogs } from './helpers/logging.ts';

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-declarations-' });
  const store = await openStore(dir);
  return {
    dir,
    store,
    state: createState(store),
    close: async () => {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('state declarations: typed defaults, idempotent schemas, defensive copies and validated writes', async () => {
  const s = await setup();
  try {
    const schema = {
      type: 'array',
      items: { type: 'integer', minimum: 1 },
      default: [60, 600],
    };
    s.state.declare('fixture.delays', schema);
    s.state.declare('fixture.delays', {
      default: [60, 600],
      items: { minimum: 1, type: 'integer' },
      type: 'array',
    });
    assertThrows(
      () => s.state.declare('fixture.delays', { type: 'string' }),
      SettingsValidationError,
    );
    schema.default[0] = 0;
    const first = await s.state.getTyped('fixture.delays') as number[];
    assertEquals(first, [60, 600]);
    first[0] = 0;
    assertEquals(await s.state.getTyped('fixture.delays'), [60, 600]);
    assertEquals(await s.state.get('fixture.delays'), null);
    assertEquals(await s.state.list(), {});
    await assertRejects(
      () => s.state.set('fixture.delays', '0'),
      SettingsValidationError,
    );
    await assertRejects(
      () => s.state.seedIfUnset('fixture.delays', 'bad'),
      SettingsValidationError,
    );
    assertEquals(await s.state.seedIfUnset('fixture.delays', '1, 2'), true);
    assertEquals(await s.state.getTyped('fixture.delays'), [1, 2]);
    assertEquals(await s.state.seedIfUnset('fixture.delays', '3'), false);
    await s.state.set('arbitrary', 'still raw');
    assertEquals(await s.state.getTyped('arbitrary'), 'still raw');
    assertEquals(await s.state.getTyped('absent'), undefined);
  } finally {
    await s.close();
  }
});

Deno.test('state declarations: config PUT validates generically and notifies a live typed consumer', async () => {
  const s = await setup();
  try {
    s.state.declare('fixture.limit', {
      type: 'integer',
      minimum: 5,
      maximum: 600,
      default: 60,
    });
    const { log, records } = captureLogs();
    const core = await pathfinder({
      roots: ['core/'],
      app: { state: s.state, log },
    });
    const seen: unknown[] = [];
    s.state.onChange((key, value) => seen.push([key, value]));
    const put = (value: string) =>
      core(
        new Request('http://x/config/fixture.limit', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value }),
        }),
      );
    const bad = await put('4');
    assertEquals(bad.status, 400);
    assertEquals(typeof (await bad.json()).error, 'string');
    assertEquals(await s.state.getTyped('fixture.limit'), 60);
    assertEquals(seen, []);
    assertEquals(records(), []);
    assertEquals((await put('120')).status, 200);
    assertEquals(await s.state.getTyped('fixture.limit'), 120);
    assertEquals(seen, [['fixture.limit', '120']]);
    assertEquals(
      (await core(new Request('http://x/config')).then((r) => r.json())).config,
      { 'fixture.limit': '120' },
    );
  } finally {
    await s.close();
  }
});

Deno.test('state revisions: atomic stale refusal, monotone writes and seed no-ops', async () => {
  const s = await setup();
  try {
    assertEquals(await s.state.getWithRevision('key'), {
      value: null,
      revision: 0,
    });
    await s.state.set('key', 'first', { expectedRevision: 0 });
    const results = await Promise.allSettled(
      ['second', 'third'].map((value) =>
        s.state.set('key', value, { expectedRevision: 1 })
      ),
    );
    assertEquals(results.filter((r) => r.status === 'fulfilled').length, 1);
    const failure = results.find((r) =>
      r.status === 'rejected'
    ) as PromiseRejectedResult;
    assertEquals(failure.reason instanceof StateRevisionError, true);
    assertEquals(await s.state.getWithRevision('key'), {
      value: 'second',
      revision: 2,
    });
    assertEquals(await s.state.seedIfUnset('key', 'ignored'), false);
    assertEquals((await s.state.getWithRevision('key')).revision, 2);
    await s.state.set('key', 'second');
    assertEquals((await s.state.getWithRevision('key')).revision, 3);
    await assertRejects(() =>
      s.state.set('key', 'bad', { expectedRevision: -1 })
    );
    assertEquals((await s.state.getWithRevision('key')).revision, 3);
  } finally {
    await s.close();
  }
});

Deno.test('state declarations: removed declarations stay persisted and hidden across reopen, then return', async () => {
  const s = await setup();
  try {
    await s.state.set('fixture.old', '7');
    s.state.declare('fixture.old', { type: 'integer' });
    assertEquals(await s.state.getTyped('fixture.old'), 7);
    s.state.declare('fixture.new', { type: 'boolean', default: false });
    await s.state.set('fixture.new', 'true');
    await s.state.set('never-declared', 'raw');
    await s.store.close();
    const reopened = await openStore(s.dir);
    try {
      const state = createState(reopened);
      assertEquals(await state.get('fixture.old'), '7');
      assertEquals(await state.get('fixture.new'), 'true');
      assertEquals(await state.list(), { 'never-declared': 'raw' });
      await state.set('fixture.old', '8');
      assertEquals(await state.list(), { 'never-declared': 'raw' });
      state.declare('fixture.old', { type: 'integer' });
      assertEquals(await state.list(), {
        'fixture.old': '8',
        'never-declared': 'raw',
      });
      assertEquals(await state.getTyped('fixture.old'), 8);
    } finally {
      await reopened.close();
    }
  } finally {
    await s.close();
  }
});

Deno.test('state revisions: legacy table gains revision and declared columns without losing values', async () => {
  const s = await setup();
  try {
    await rawSql(s.store).run('DROP TABLE state');
    await rawSql(s.store).run(
      'CREATE TABLE state (key VARCHAR PRIMARY KEY, value VARCHAR NOT NULL)',
    );
    await rawSql(s.store).run("INSERT INTO state VALUES ('legacy', 'kept')");
    await s.store.close();
    const reopened = await openStore(s.dir);
    try {
      const state = createState(reopened);
      assertEquals(await state.getWithRevision('legacy'), {
        value: 'kept',
        revision: 0,
      });
      assertEquals(
        await rawSql(reopened).all(
          "SELECT declared FROM state WHERE key = 'legacy'",
        ),
        [{ declared: false }],
      );
      assertEquals(await state.list(), { legacy: 'kept' });
      await state.set('legacy', 'next', { expectedRevision: 0 });
      assertEquals(await state.getWithRevision('legacy'), {
        value: 'next',
        revision: 1,
      });
    } finally {
      await reopened.close();
    }
  } finally {
    await s.close();
  }
});

Deno.test('layer settings: manifest declarations are reserved, validated and registered before requests', async () => {
  const s = await setup();
  try {
    const root = `${s.dir}/layers`, layer = `${root}/fixture`;
    await Deno.mkdir(`${layer}/routes`, { recursive: true });
    await Deno.writeTextFile(
      `${layer}/manifest.json`,
      JSON.stringify({
        routes: '/fixture',
        settings: { 'fixture.toggle': { type: 'boolean', default: false } },
      }),
    );
    const layers = await loadLayers({
      app: { state: s.state },
      layersRoot: root,
    });
    assertEquals(layers[0].mounts.map((m) => m.prefix), ['/fixture']);
    assertEquals(await s.state.getTyped('fixture.toggle'), false);
    await assertRejects(
      () => s.state.set('fixture.toggle', 'on'),
      SettingsValidationError,
    );
    await Deno.writeTextFile(
      `${layer}/manifest.json`,
      JSON.stringify({
        settings: { 'fixture.bad': { type: 'string', unknown: true } },
      }),
    );
    await assertRejects(
      () => loadLayers({ app: { state: s.state }, layersRoot: root }),
      SettingsValidationError,
    );
  } finally {
    await s.close();
  }
});
