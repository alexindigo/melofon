import { assert, assertEquals, assertRejects } from '@std/assert';
import { apiFixture, error } from './helpers/api.ts';
import type { Setting } from '../layers/melofon/types.ts';
import { createLookupRunner } from '../src/lookups/runner.ts';
import { findHats } from '../src/layers.ts';
import { createState } from '../src/state.ts';
import { createSettings } from '../src/settings.ts';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { UserError } from '../src/user-errors.ts';
import { captureLogs } from './helpers/logging.ts';
import { appLogger, installLogger } from '../src/logging.ts';
import { createLibrary } from '../src/library.ts';
import { createLibraries } from '../src/libraries.ts';
import { createScan } from '../src/scan.ts';
import { createReference } from '../src/reference.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { tagged } from './helpers/tagged.ts';
import { seedFirstUser } from '../src/users.ts';

const base = '/api/v1/admin/settings';
type Fixture = Awaited<ReturnType<typeof apiFixture>>;
async function list(f: Fixture, credential: string): Promise<Setting[]> {
  const response = await f.get(base, credential);
  assertEquals(response.status, 200, await response.clone().text());
  return (await response.json()).settings;
}
async function item(
  f: Fixture,
  credential: string,
  key: string,
): Promise<Setting> {
  const response = await f.get(`${base}/${key}`, credential);
  assertEquals(response.status, 200, await response.clone().text());
  return response.json();
}
async function change(f: Fixture, credential: string, changes: unknown) {
  return await f.json(base, 'PATCH', { changes }, credential);
}
async function settingError(
  response: Response,
  status: number,
  code: string,
  key?: string,
) {
  const body = await response.json();
  assertEquals(response.status, status, JSON.stringify(body));
  assertEquals(body.code, code);
  assertEquals(typeof body.message, 'string');
  if (key !== undefined) assertEquals(body.key, key);
  return body;
}
function declare(f: Fixture) {
  f.state.declare('fixture.limit', {
    type: 'integer',
    minimum: 1,
    maximum: 20,
    default: 5,
    description: 'A bounded limit',
  });
  f.state.declare('fixture.flag', { type: 'boolean', default: false });
  f.state.declare('fixture.words', {
    type: 'array',
    items: { type: 'string' },
    default: [],
  });
  f.state.declare('fixture.ratio', {
    type: 'number',
    minimum: 0,
    maximum: 2,
    default: 1,
  });
  f.state.declare('fixture.text', {
    type: 'string',
    minLength: 2,
    maxLength: 8,
    pattern: '^[a-z]+$',
    default: 'hello',
  });
}

Deno.test('API settings: complete declaration inventory, schemas and owners include unset keys and inactive hats', async () => {
  let runner: Awaited<ReturnType<typeof createLookupRunner>> | undefined;
  const f = await apiFixture({
    services: async (f) => {
      runner = await createLookupRunner({
        store: f.store,
        state: f.state,
        dataDir: f.dir,
      });
      const root = `${f.dir}/inactive`;
      await Deno.mkdir(`${root}/sleeping`, { recursive: true });
      await Deno.writeTextFile(
        `${root}/sleeping/manifest.json`,
        JSON.stringify({
          settings: {
            'sleeping.message': {
              type: 'string',
              default: 'asleep',
              title: 'Message',
              description: 'Inactive hat setting',
            },
          },
        }),
      );
      const [hat] = await findHats({
        app: { state: f.state },
        layersRoot: root,
      });
      assertEquals(hat.errors, []);
      await f.state.set('undeclared.internal', 'not a setting');
      return {};
    },
  });
  try {
    const { credential } = await f.login();
    const settings = await list(f, credential);
    assertEquals(
      settings.map((s) => s.key).sort(),
      (await f.state.describe()).map((s) => s.key).sort(),
    );
    assert(!settings.some((s) => s.key === 'undeclared.internal'));
    const core = settings.find((s) => s.key === 'auth.signInFailures')!;
    assertEquals([
      core.owner,
      core.category,
      core.schema.type,
      core.default,
      core.value,
      core.source,
      core.revision,
      core.writeOnly,
    ], ['core', 'auth', 'integer', 10, 10, 'default', 0, false]);
    assertEquals(core.schema.minimum, 1);
    const sleeping = settings.find((s) => s.key === 'sleeping.message')!;
    assertEquals([
      sleeping.owner,
      sleeping.category,
      sleeping.schema.title,
      sleeping.schema.description,
      sleeping.value,
    ], [
      'hat:sleeping',
      'sleeping',
      'Message',
      'Inactive hat setting',
      'asleep',
    ]);
    assertEquals(
      settings.find((s) => s.key === 'opensubsonic.similarSongsMax')!.owner,
      'hat:opensubsonic',
    );
    for (const key of ['enabled', 'hosts', 'settings.countries']) {
      const plugin = settings.find((s) =>
        s.key === `lookups.plugin.itunes-covers.${key}`
      );
      assert(plugin, key);
      assertEquals(plugin.owner, 'plugin:itunes-covers');
      assertEquals(plugin.category, 'lookups');
    }
    assertEquals(await item(f, credential, sleeping.key), sleeping);
    await settingError(
      await f.get(`${base}/unknown.key`, credential),
      404,
      'unknown_setting',
      'unknown.key',
    );
    const sorted = [...settings].sort((a, b) =>
      a.owner.localeCompare(b.owner) || a.key.localeCompare(b.key)
    );
    assertEquals(settings, sorted);
  } finally {
    await runner?.close();
    await f.close();
  }
});

Deno.test('API settings: admin placement, fresh core authorization, JSON and Origin rules', async () => {
  const f = await apiFixture();
  try {
    declare(f);
    const regular = await f.auth.users.create(f.admin.id, {
      username: 'reader',
      password: 'reader-password',
      role: 'user',
    });
    const { credential } = await f.login('cookie', 'reader', 'reader-password');
    for (const path of [base, `${base}/fixture.limit`]) {
      await error(await f.get(path), 401, 'unauthenticated');
      await error(await f.get(path, credential), 403, 'forbidden');
    }
    await error(
      await change(f, credential, [{ key: 'fixture.limit', value: 7 }]),
      403,
      'forbidden',
    );
    const settings = createSettings(f.store, f.state);
    await assertRejects(() => settings.describe(regular.id), UserError);
    await assertRejects(() => settings.change(regular.id, []), UserError);
    await assertRejects(() => settings.change('missing', []), UserError);
    const admin = await f.login();
    const bearer = await f.login('bearer');
    for (const login of [admin, bearer]) {
      for (const origin of ['http://foreign.home', 'null']) {
        await error(
          await f.json(
            base,
            'PATCH',
            { changes: [{ key: 'fixture.limit', value: 9 }] },
            login.credential,
            origin,
          ),
          403,
          'origin',
        );
      }
    }
    await error(
      await f.json(base, 'PATCH', { changes: [] }, admin.credential, null),
      403,
      'origin',
    );
    const noOrigin = await f.json(
      base,
      'PATCH',
      { changes: [] },
      bearer.credential,
      null,
    );
    assertEquals(noOrigin.status, 200);
    assertEquals(await noOrigin.json(), { settings: [] });
    await error(
      await f.request(base, {
        method: 'PATCH',
        headers: {
          Cookie: admin.credential,
          Origin: f.origin,
          'Content-Type': 'application/json',
        },
        body: '{bad',
      }),
      400,
      'not_json',
    );
    await error(
      await f.request(base, {
        method: 'PATCH',
        headers: {
          Cookie: admin.credential,
          Origin: f.origin,
          'Content-Type': 'text/plain',
        },
        body: '{}',
      }),
      415,
      'unsupported_media_type',
    );
    assertEquals((await item(f, admin.credential, 'fixture.limit')).value, 5);
    await f.auth.users.update(f.admin.id, regular.id, { role: 'admin' });
    assertEquals((await settings.describe(regular.id)).length > 0, true);
    await f.auth.users.update(f.admin.id, regular.id, { role: 'user' });
    await assertRejects(() => settings.change(regular.id, []), UserError);
  } finally {
    await f.close();
  }
});

Deno.test('API settings: typed batches validate completely before writing or announcing', async () => {
  const f = await apiFixture();
  try {
    declare(f);
    const { credential } = await f.login('bearer');
    const before = await list(f, credential);
    const seen: unknown[] = [];
    f.state.onChange((key, value) => seen.push([key, value]));
    for (
      const bad of [
        { key: 'fixture.limit', value: 0 },
        { key: 'fixture.limit', value: '7' },
        { key: 'fixture.limit', value: null },
        { key: 'fixture.limit', value: 2, reset: true },
        { key: 'fixture.limit', reset: false },
        { key: 'fixture.limit', value: 2, revision: -1 },
        { key: 'fixture.limit', value: 2, extra: true },
        { key: 'fixture.words', value: ['silently,split'] },
        { key: 'fixture.ratio', value: '1.5' },
        { key: 'fixture.text', value: '1' },
      ]
    ) {
      const failure = await settingError(
        await change(f, credential, [
          { key: 'fixture.flag', value: true },
          bad,
        ]),
        400,
        'invalid_value',
        bad.key,
      );
      if (bad.value === 0) assertEquals(failure.message, 'must be at least 1');
      assertEquals(await list(f, credential), before);
    }
    await settingError(
      await change(f, credential, [{ key: 'fixture.limit', value: 8 }, {
        key: 'not.declared',
        value: 3,
      }]),
      400,
      'unknown_setting',
      'not.declared',
    );
    await settingError(
      await change(f, credential, [{ key: 'fixture.limit', value: 8 }, {
        key: 'fixture.limit',
        value: 9,
      }]),
      400,
      'invalid_value',
      'fixture.limit',
    );
    for (const bad of [null, {}, [null], [{ value: 1 }]]) {
      await settingError(
        await change(f, credential, bad),
        400,
        'invalid_value',
      );
    }
    assertEquals(await list(f, credential), before);
    assertEquals(seen, []);
    assertEquals(f.settingNotifications, []);
    const response = await change(f, credential, [
      { key: 'fixture.flag', value: true },
      { key: 'fixture.limit', value: 8 },
      { key: 'fixture.words', value: ['alpha', 'beta'] },
    ]);
    assertEquals(response.status, 200);
    const changed = (await response.json()).settings as Setting[];
    assertEquals(changed.map((s) => [s.key, s.value, s.revision, s.source]), [
      ['fixture.flag', true, 1, 'stored'],
      ['fixture.limit', 8, 1, 'stored'],
      ['fixture.words', ['alpha', 'beta'], 1, 'stored'],
    ]);
    assertEquals(seen, [['fixture.flag', 'true'], ['fixture.limit', '8'], [
      'fixture.words',
      'alpha,beta',
    ]]);
    assertEquals(f.settingNotifications, [{
      settings: ['fixture.flag', 'fixture.limit', 'fixture.words'],
    }]);
    for (const setting of changed) {
      assertEquals(await item(f, credential, setting.key), setting);
    }
    const scalarResponse = await change(f, credential, [{
      key: 'fixture.ratio',
      value: 1.5,
    }, { key: 'fixture.text', value: 'world' }]);
    assertEquals(scalarResponse.status, 200);
    assertEquals(
      (await scalarResponse.json()).settings.map((s: Setting) => s.value),
      [1.5, 'world'],
    );
    assertEquals((await item(f, credential, 'fixture.ratio')).value, 1.5);
    assertEquals((await item(f, credential, 'fixture.text')).value, 'world');
  } finally {
    await f.close();
  }
});

Deno.test('API settings: events drain interval rejects timer overflow and accepts the maximum', async () => {
  const f = await apiFixture();
  try {
    for (const mode of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(mode);
      const key = 'melofon.eventsDrainMs';
      const before = await item(f, credential, key);
      await settingError(
        await change(f, credential, [{ key, value: 2147483648 }]),
        400,
        'invalid_value',
        key,
      );
      assertEquals(await item(f, credential, key), before);
      const accepted = await change(f, credential, [{
        key,
        value: 2147483647,
      }]);
      assertEquals(accepted.status, 200);
      await accepted.json();
      assertEquals((await item(f, credential, key)).value, 2147483647);
    }
  } finally {
    await f.close();
  }
});

Deno.test('API settings: concurrent admins conflict atomically; reset retains rising revisions and current default', async () => {
  const f = await apiFixture();
  try {
    declare(f);
    await f.auth.users.create(f.admin.id, {
      username: 'second',
      password: 'second-password',
      role: 'admin',
    });
    const first = await f.login();
    const second = await f.login('bearer', 'second', 'second-password');
    const results = await Promise.all(
      [first, second].map((login, index) =>
        change(f, login.credential, [{
          key: 'fixture.limit',
          value: index + 10,
          revision: 0,
        }])
      ),
    );
    assertEquals(results.map((r) => r.status).sort(), [200, 409]);
    const winner = results.find((r) => r.status === 200)!;
    const current = (await winner.json()).settings[0] as Setting;
    const conflict = await settingError(
      results.find((r) => r.status === 409)!,
      409,
      'revision_conflict',
    );
    assertEquals(conflict.revisions, { 'fixture.limit': 1 });
    assertEquals(await item(f, first.credential, 'fixture.limit'), current);
    await settingError(
      await change(f, first.credential, [{ key: 'fixture.flag', value: true }, {
        key: 'fixture.limit',
        value: 20,
        revision: 0,
      }]),
      409,
      'revision_conflict',
    );
    assertEquals((await item(f, first.credential, 'fixture.flag')).revision, 0);
    const seen: unknown[] = [];
    f.state.onChange((key, value) => seen.push([key, value]));
    const reset = await change(f, second.credential, [{
      key: 'fixture.limit',
      reset: true,
      revision: 1,
    }]);
    assertEquals(reset.status, 200);
    const setting = (await reset.json()).settings[0];
    assertEquals([
      setting.value,
      setting.default,
      setting.revision,
      setting.source,
    ], [5, 5, 2, 'default']);
    assertEquals(seen, [['fixture.limit', '5']]);
    assertEquals(await f.state.getTyped('fixture.limit'), 5);
    assertEquals(await f.state.seedIfUnset('fixture.limit', '19'), false);
    assertEquals(
      (await item(f, first.credential, 'fixture.limit')).revision,
      2,
    );
    const stale = await settingError(
      await change(f, first.credential, [{
        key: 'fixture.limit',
        value: 12,
        revision: 1,
      }]),
      409,
      'revision_conflict',
    );
    assertEquals(stale.revisions, { 'fixture.limit': 2 });
    const newer = createState(f.store);
    newer.declare('fixture.limit', { type: 'integer', default: 6 });
    assertEquals(
      await newer.getTyped('fixture.limit'),
      6,
      'reset resolves the declaration, not a frozen stored default',
    );
    const resetAgain = await change(f, first.credential, [{
      key: 'fixture.limit',
      reset: true,
      revision: 2,
    }]);
    assertEquals(resetAgain.status, 200);
    assertEquals((await resetAgain.json()).settings[0].revision, 3);
  } finally {
    await f.close();
  }
});

Deno.test('API settings: write-only values never enter read responses, change results, notifications, listeners or logs', async () => {
  const previous = appLogger();
  const capture = captureLogs();
  installLogger(capture.log);
  const f = await apiFixture();
  const secret = 'a6-write-only-secret-59791';
  const replacement = 'a6-replacement-secret-78317';
  const fallback = 'a6-default-secret-33857';
  try {
    f.state.declare('fixture.secret', { type: 'string', writeOnly: true });
    f.state.declare('fixture.secretDefault', {
      type: 'string',
      writeOnly: true,
      default: fallback,
    });
    const { credential } = await f.login();
    const seen: unknown[] = [];
    f.state.onChange((key, value) => seen.push([key, value]));
    const responses: unknown[] = [];
    const read = async (isSet: boolean) => {
      const settings = await list(f, credential);
      const value = settings.find((s) => s.key === 'fixture.secret')!;
      assertEquals(value.isSet, isSet);
      assertEquals(value.writeOnly, true);
      assert(!('value' in value));
      assert(!('default' in value));
      assertEquals(await item(f, credential, 'fixture.secret'), value);
      const config = await (await f.request('/_/config', {}, true)).json();
      assertEquals(config.config['fixture.secret'], { isSet });
      responses.push(settings, value, config);
    };
    await read(false);
    for (const value of [secret, replacement]) {
      const response = await change(f, credential, [{
        key: 'fixture.secret',
        value,
      }]);
      assertEquals(response.status, 200);
      responses.push(await response.json());
      await read(true);
      capture.log.event('state_listener_failed', {
        error: new Error(`A consumer included ${value}`),
      });
    }
    // The legacy writer shares the same secrecy boundary.
    const legacy = await f.json(
      '/_/config/fixture.secret',
      'PUT',
      {
        value: secret,
      },
      undefined,
      f.origin,
      true,
    );
    assertEquals(legacy.status, 200);
    responses.push(await legacy.json());
    await read(true);
    const cleared = await change(f, credential, [{
      key: 'fixture.secret',
      reset: true,
    }]);
    assertEquals(cleared.status, 200);
    responses.push(await cleared.json());
    await read(false);
    capture.log.event('state_listener_failed', {
      error: new Error(`still redact ${secret} ${replacement} ${fallback}`),
    });
    await capture.log.flush();
    const evidence = JSON.stringify([
      responses,
      f.settingNotifications,
      seen,
      capture.lines,
    ]);
    for (const value of [secret, replacement, fallback]) {
      assert(!evidence.includes(value), 'secret left server');
    }
    assert(capture.lines.some((line) => line.includes('[redacted]')));
    assertEquals(seen, Array.from({ length: 4 }, () => ['fixture.secret', '']));
    assertEquals(
      f.settingNotifications,
      Array.from({ length: 4 }, () => ({ settings: ['fixture.secret'] })),
    );
  } finally {
    await f.close();
    installLogger(previous);
  }
});

Deno.test('settings upgrade: BASE rows and revisions survive ledger migration; reset and write-only markers survive reopen', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-settings-upgrade-' });
  let store = await openStore(dir);
  const previous = appLogger();
  const capture = captureLogs();
  installLogger(capture.log);
  try {
    const cfg = {
      dataDir: dir,
      secret: 'upgrade-secret',
      user: 'admin',
      password: 'upgrade-password',
      listen: undefined,
    };
    await seedFirstUser(store, cfg);
    const admin = (await store.users.credentials({ username: 'admin' }))!.user;
    await rawSql(store).run('DROP TABLE state');
    await rawSql(store).run(
      'CREATE TABLE state (key VARCHAR PRIMARY KEY, value VARCHAR NOT NULL, revision BIGINT DEFAULT 0, declared BOOLEAN DEFAULT false)',
    );
    await rawSql(store).run(
      "INSERT INTO state VALUES ('fixture.kept', '12', 41, true)",
    );
    await rawSql(store).run("DELETE FROM migrations WHERE id = 'settings-001'");
    await store.close();
    store = await openStore(dir);
    const state = createState(store);
    state.declare('fixture.kept', { type: 'integer', default: 9 });
    assertEquals(await state.getWithRevision('fixture.kept'), {
      value: '12',
      revision: 41,
    });
    await state.set('fixture.kept', '13', { expectedRevision: 41 });
    assertEquals((await state.getWithRevision('fixture.kept')).revision, 42);
    await state.change(admin.id, [{
      key: 'fixture.kept',
      reset: true,
      revision: 42,
    }]);
    state.declare('fixture.retiredSecret', { type: 'string', writeOnly: true });
    await state.set('fixture.retiredSecret', 'boot-only-secret-94851');
    await store.close();
    // A fresh logger proves boot registration, without a declaration or setter.
    const bootCapture = captureLogs();
    installLogger(bootCapture.log);
    store = await openStore(dir);
    const reopened = createState(store);
    assertEquals(await reopened.list(), {});
    bootCapture.log.event('state_listener_failed', {
      error: new Error('boot-only-secret-94851'),
    });
    await bootCapture.log.flush();
    assert(!bootCapture.lines.join('\n').includes('boot-only-secret-94851'));
    assertEquals(
      await rawSql(store).all(
        "SELECT id FROM migrations WHERE id = 'settings-001'",
      ),
      [{ id: 'settings-001' }],
    );
    assertEquals(await reopened.getWithRevision('fixture.kept'), {
      value: null,
      revision: 43,
    });
    reopened.declare('fixture.kept', { type: 'integer', default: 10 });
    assertEquals(await reopened.getTyped('fixture.kept'), 10);
    assertEquals(await reopened.seedIfUnset('fixture.kept', '20'), false);
    reopened.declare('fixture.retiredSecret', { type: 'string' });
    const secretDescription = (await reopened.describe()).find((s) =>
      s.key === 'fixture.retiredSecret'
    )!;
    assertEquals(secretDescription.writeOnly, true);
    assert(!('value' in secretDescription));
    await reopened.set('fixture.retiredSecret', 'sticky-secret-91729');
    bootCapture.log.event('state_listener_failed', {
      error: new Error('sticky-secret-91729'),
    });
    await bootCapture.log.flush();
    assert(!bootCapture.lines.join('\n').includes('sticky-secret-91729'));
  } finally {
    await store.close();
    installLogger(previous);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('API settings: changed real hat setting reaches the /rest consumer over non-loopback HTTP', async () => {
  let seed = '';
  const f = await apiFixture({
    allLayers: true,
    services: async (f) => {
      const root = `${f.dir}/music`;
      await Deno.mkdir(root);
      const libraries = createLibraries(f.store);
      await libraries.add('Music', root);
      for (let n = 0; n < 4; n++) {
        await tagged(`${root}/song-${n}.mp3`, {
          TIT2: `Song ${n}`,
          TALB: 'Album',
          TPE1: 'Artist',
          TPE2: 'Artist',
          TCON: 'Jazz',
          TRCK: String(n + 1),
        });
      }
      await createScan(f.store, undefined, { state: f.state }).run();
      seed = (await f.store.catalog.listSongs({ offset: 0, size: 10 }))[0].id;
      return {
        library: createLibrary(f.store),
        libraries,
        annotation: createAnnotation(f.store),
        listens: createListens(f.store),
        reference: createReference({
          store: f.store,
          state: f.state,
          providers: () => Promise.resolve([]),
          enqueue: () => Promise.resolve(),
        }),
      };
    },
  });
  try {
    const { credential } = await f.login('bearer');
    const songs = async () => {
      const params = new URLSearchParams({
        u: 'admin',
        p: 'password-admin',
        v: '1.16.1',
        c: 'a6',
        f: 'json',
        id: seed,
        count: '3',
      });
      const response = await f.get(`/rest/getSimilarSongs2?${params}`);
      assertEquals(response.status, 200);
      const body = (await response.json())['subsonic-response'];
      assertEquals(body.status, 'ok');
      return body.similarSongs2.song as { id: string }[];
    };
    assertEquals((await songs()).length, 3);
    const changed = await change(f, credential, [{
      key: 'opensubsonic.similarSongsMax',
      value: 1,
      revision: 0,
    }]);
    assertEquals(changed.status, 200);
    await changed.json();
    const limited = await songs();
    assertEquals(limited.length, 1);
    assert(limited[0].id !== seed);
    const reset = await change(f, credential, [{
      key: 'opensubsonic.similarSongsMax',
      reset: true,
      revision: 1,
    }]);
    assertEquals(reset.status, 200);
    await reset.json();
    assertEquals((await songs()).length, 3);
  } finally {
    await f.close();
  }
});
