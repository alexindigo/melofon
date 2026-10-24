import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore, type Store } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { encryptPassword, seedFirstUser } from '../src/users.ts';
import { createUserService } from '../src/user.ts';
import { createRadio } from '../src/radio.ts';
import { createLibraries } from '../src/libraries.ts';
import { createScan } from '../src/scan.ts';
import { createState } from '../src/state.ts';
import { loadLayers } from '../src/layers.ts';
import { facade } from '../src/facade.ts';

interface Station {
  id: string;
  name: string;
  streamUrl: string;
  homePageUrl?: string;
}
const cfg = (dir: string) => ({
  dataDir: dir,
  user: 'admin',
  password: 'test',
  secret: 'radio-secret',
  listen: undefined,
  version: 'radio-test',
});

async function api(store: Store, dir: string, radio = createRadio(store)) {
  const config = cfg(dir);
  const core = await pathfinder({
    roots: ['core/'],
    app: { store, cfg: config },
  });
  const handler = facade(
    core,
    await loadLayers({
      app: {
        cfg: config,
        state: createState(store),
        user: createUserService(store, config),
        radio,
      },
    }),
  );
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    handler,
  );
  const request = (
    op: string,
    params: Record<string, string> = {},
    user = 'admin',
    post = false,
  ) => {
    const p = new URLSearchParams({
      u: user,
      p: 'test',
      v: '1.16.1',
      c: 'radio-test',
      f: 'json',
      ...params,
    });
    const url = `http://127.0.0.1:${server.addr.port}/rest/${op}.view`;
    return fetch(
      post ? url : `${url}?${p}`,
      post ? { method: 'POST', body: p } : undefined,
    );
  };
  const json = async (
    op: string,
    params: Record<string, string> = {},
    user = 'admin',
    post = false,
  ) => {
    const res = await request(op, params, user, post);
    assertEquals(res.status, 200);
    return (await res.json())['subsonic-response'];
  };
  const ok = async (
    op: string,
    params: Record<string, string> = {},
    user = 'admin',
    post = false,
  ) => {
    const result = await json(op, params, user, post);
    assertEquals(result.status, 'ok', JSON.stringify(result));
    return result;
  };
  const list = async (post = false): Promise<Station[]> =>
    (await ok('getInternetRadioStations', {}, 'listener', post))
      .internetRadioStations.internetRadioStation;
  return { request, json, ok, list, close: () => server.shutdown() };
}

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-radio-' });
  const store = await openStore(dir);
  await seedFirstUser(store, cfg(dir));
  const password = (await encryptPassword(cfg(dir).secret, 'test')).replaceAll(
    "'",
    "''",
  );
  await rawSql(store).run(
    `INSERT INTO users (id, name, password_enc, created_at)
    VALUES ('listener', 'listener', '${password}', now())`,
  );
  const coreCalls: string[] = [];
  const radio = createRadio(store);
  const client = await api(store, dir, {
    ...radio,
    create(...args) {
      coreCalls.push('create');
      return radio.create(...args);
    },
    update(...args) {
      coreCalls.push('update');
      return radio.update(...args);
    },
    delete(...args) {
      coreCalls.push('delete');
      return radio.delete(...args);
    },
  });
  return {
    dir,
    store,
    coreCalls,
    ...client,
    async close() {
      await client.close();
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('internet radio HTTP: shared sorted stations, XML escaping, GET/form CRUD and rescan', async () => {
  const s = await setup();
  try {
    assertEquals(await s.list(), []);
    const z = {
      name: '  Zulu & "Friends"  ',
      streamUrl: 'https://radio.example/live?a=1&b=2',
      homepageUrl: 'https://radio.example/?x=1&y=2',
    };
    const created = await s.ok('createInternetRadioStation', z);
    assertEquals(Object.keys(created).sort(), [
      'openSubsonic',
      'serverVersion',
      'status',
      'type',
      'version',
    ]);
    await s.ok(
      'createInternetRadioStation',
      {
        name: 'alpha',
        streamUrl: 'http://radio.example/alpha',
        homePageUrl: 'https://ignored.example/',
      },
      'admin',
      true,
    );
    const rows = await s.list(true);
    assertEquals(rows.map((r) => r.name), ['alpha', 'Zulu & "Friends"']);
    assert(rows.every((r) => /^radio-[0-9a-f-]{36}$/.test(r.id)));
    const [alpha, zulu] = rows;
    assertEquals(alpha, {
      id: alpha.id,
      name: 'alpha',
      streamUrl: 'http://radio.example/alpha',
    });
    assertEquals(zulu, {
      id: zulu.id,
      name: 'Zulu & "Friends"',
      streamUrl: z.streamUrl,
      homePageUrl: z.homepageUrl,
    });
    for (const post of [false, true]) {
      const xml = await (await s.request(
        'getInternetRadioStations',
        { f: 'xml' },
        'listener',
        post,
      )).text();
      assertStringIncludes(
        xml,
        `<internetRadioStation id="${alpha.id}" name="alpha" streamUrl="http://radio.example/alpha"/>`,
      );
      assertStringIncludes(xml, 'name="Zulu &amp; &quot;Friends&quot;"');
      assertStringIncludes(
        xml,
        'streamUrl="https://radio.example/live?a=1&amp;b=2"',
      );
      assertStringIncludes(
        xml,
        'homePageUrl="https://radio.example/?x=1&amp;y=2"',
      );
      assertEquals(xml.includes('coverArt'), false);
    }
    await s.ok(
      'updateInternetRadioStation',
      {
        id: zulu.id,
        name: ' Beta ',
        streamUrl: 'https://new.example/live',
        homepageUrl: 'https://new.example/',
      },
      'admin',
      true,
    );
    assertEquals((await s.list())[1], {
      id: zulu.id,
      name: 'Beta',
      streamUrl: 'https://new.example/live',
      homePageUrl: 'https://new.example/',
    });
    await s.ok('updateInternetRadioStation', {
      id: zulu.id,
      name: 'Beta',
      streamUrl: 'https://new.example/live',
    });
    assertEquals((await s.list())[1], {
      id: zulu.id,
      name: 'Beta',
      streamUrl: 'https://new.example/live',
    });
    const libraries = createLibraries(s.store);
    await libraries.add('Music', await Deno.realPath('tests/fixtures/library'));
    await createScan(s.store).run();
    assertEquals((await s.list()).length, 2);
    // Stations are not catalog songs and cannot alias their identities.
    assertEquals(await s.store.catalog.getSong(zulu.id), null);
    await s.ok('deleteInternetRadioStation', { id: alpha.id });
    assertEquals((await s.list()).map((r) => r.id), [zulu.id]);
    const deleted = await s.request(
      'deleteInternetRadioStation',
      { id: zulu.id, f: 'xml' },
      'admin',
      true,
    );
    const xml = await deleted.text();
    assertStringIncludes(xml, 'status="ok"');
    assertEquals(xml.includes('internetRadioStation'), false);
    assertEquals(await s.list(), []);
  } finally {
    await s.close();
  }
});

Deno.test('internet radio HTTP: admin policy, required fields and validation never mutate on failure', async () => {
  const s = await setup();
  try {
    const fields = {
      name: 'Kept',
      streamUrl: 'https://radio.example/keep',
      homepageUrl: 'https://radio.example/',
    };
    await s.ok('createInternetRadioStation', fields);
    const before = await s.list();
    const id = before[0].id;
    const error = async (
      code: number,
      op: string,
      params: Record<string, string>,
      user = 'admin',
      post = false,
    ) => {
      const callsBefore = s.coreCalls.length;
      const result = await s.json(op, params, user, post);
      assertEquals(
        [result.status, result.error?.code],
        ['failed', code],
        JSON.stringify({ op, params, result }),
      );
      assertEquals(await s.list(), before);
      if (code === 50) assertEquals(s.coreCalls.length, callsBefore);
    };
    for (const post of [false, true]) {
      for (const user of ['listener']) {
        await error(50, 'createInternetRadioStation', fields, user, post);
        for (const target of [id, 'unknown']) {
          await error(
            50,
            'updateInternetRadioStation',
            { ...fields, id: target },
            user,
            post,
          );
          await error(
            50,
            'deleteInternetRadioStation',
            { id: target },
            user,
            post,
          );
        }
      }
      for (
        const op of ['createInternetRadioStation', 'updateInternetRadioStation']
      ) {
        const base: Record<string, string> = {
          ...fields,
          ...(op.startsWith('update') ? { id } : {}),
        };
        for (
          const key of op.startsWith('update')
            ? ['id', 'name', 'streamUrl']
            : ['name', 'streamUrl']
        ) {
          const missing = { ...base };
          delete missing[key];
          await error(10, op, missing, 'admin', post);
        }
        for (const key of ['streamUrl', 'homepageUrl']) {
          for (
            const value of [
              'ftp://radio.example/a',
              '/relative',
              'javascript:alert(1)',
              'https://',
            ]
          ) {
            await error(0, op, { ...base, [key]: value }, 'admin', post);
          }
        }
        for (const name of ['', '   ']) {
          await error(0, op, { ...base, name }, 'admin', post);
        }
      }
      await error(10, 'deleteInternetRadioStation', {}, 'admin', post);
      await error(
        70,
        'deleteInternetRadioStation',
        { id: 'unknown' },
        'admin',
        post,
      );
      await error(
        70,
        'updateInternetRadioStation',
        { ...fields, id: 'unknown' },
        'admin',
        post,
      );
    }
    const xml = await (await s.request('updateInternetRadioStation', {
      ...fields,
      id,
      streamUrl: 'ftp://invalid',
      f: 'xml',
    })).text();
    assertStringIncludes(
      xml,
      '<error code="0" message="streamUrl must be an absolute http or https URL"/>',
    );
    const unauth = await s.json(
      'getInternetRadioStations',
      { p: 'wrong' },
      'listener',
    );
    assertEquals(unauth.error.code, 40);
    // Data validity stays in core, independent of the hat's admin-only limit.
    const radio = createRadio(s.store);
    const invalid = await radio.create({
      name: ' ',
      streamUrl: 'https://valid.example/',
      homePageUrl: null,
    });
    assert(typeof invalid === 'object' && 'invalid' in invalid);
    assertEquals(await s.list(), before);
  } finally {
    await s.close();
  }
});

Deno.test('internet radio core: validates and persists CRUD without any user or role', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-radio-core-' });
  const store = await openStore(dir);
  try {
    assertEquals(await store.users.count(), 0);
    const radio = createRadio(store);
    const input = {
      name: '  Shared station  ',
      streamUrl: 'https://radio.example/live',
      homePageUrl: 'https://radio.example/',
    };
    const created = await radio.create(input);
    assert(!('invalid' in created));
    assertEquals(await store.radio.get(created.id), created);
    assertEquals(created.name, 'Shared station');
    assertEquals(await radio.list(), [created]);
    const replacement = {
      name: ' Changed ',
      streamUrl: 'http://radio.example/new',
      homePageUrl: null,
    };
    const updated = await radio.update(created.id, replacement);
    assert(updated && !('invalid' in updated));
    assertEquals(updated.id, created.id);
    assertEquals(updated.name, 'Changed');
    assertEquals(updated.homePageUrl, null);
    assertEquals(await store.radio.get(created.id), updated);
    for (
      const invalid of [
        { ...replacement, name: ' ' },
        { ...replacement, streamUrl: 'ftp://radio.example/live' },
        { ...replacement, homePageUrl: '/relative' },
      ]
    ) {
      assert('invalid' in await radio.create(invalid));
      const rejected = await radio.update(created.id, invalid);
      assert(rejected && 'invalid' in rejected);
      assertEquals(await store.radio.get(created.id), updated);
      assertEquals(await radio.list(), [updated]);
    }
    assertEquals(await radio.update('unknown', replacement), null);
    assertEquals(await radio.delete('unknown'), false);
    assertEquals(await radio.delete(created.id), true);
    assertEquals(await store.radio.get(created.id), null);
    assertEquals(await radio.list(), []);
    assertEquals(await store.users.count(), 0);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('internet radio HTTP: upgrade adds shared table and station facts survive store reopen', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-radio-upgrade-' });
  let store = await openStore(dir);
  let client: Awaited<ReturnType<typeof api>> | undefined;
  try {
    await seedFirstUser(store, cfg(dir));
    const enc = (await encryptPassword(cfg(dir).secret, 'test')).replaceAll(
      "'",
      "''",
    );
    await rawSql(store).run(
      `INSERT INTO users (id, name, password_enc, created_at) VALUES ('listener', 'listener', '${enc}', now())`,
    );
    // Existing install has all its state, but no station table.
    await store.state.set('radio-upgrade-proof', 'kept');
    await rawSql(store).run('DROP TABLE radio_stations');
    await store.close();
    store = await openStore(dir);
    client = await api(store, dir);
    assertEquals(await client.list(), []);
    assertEquals(await store.state.get('radio-upgrade-proof'), 'kept');
    await client.ok('createInternetRadioStation', {
      name: "Radio O'Clock",
      streamUrl: 'https://radio.example/live',
      homepageUrl: 'https://radio.example/',
    });
    const [created] = await store.radio.list();
    assert(created.createdAtMs > 0 && created.updatedAtMs > 0);
    assertEquals(await store.radio.get(created.id), created);
    await client.ok('updateInternetRadioStation', {
      id: created.id,
      name: 'Updated',
      streamUrl: 'https://radio.example/new',
    });
    const changed = await store.radio.get(created.id);
    assert(changed);
    assertEquals(changed.createdAtMs, created.createdAtMs);
    assert(changed.updatedAtMs >= created.updatedAtMs);
    const before = await client.list();
    await client.close();
    client = undefined;
    await store.close();
    store = await openStore(dir);
    client = await api(store, dir);
    assertEquals(await client.list(), before);
    assertEquals(await store.radio.get(created.id), changed);
    await client.ok(
      'deleteInternetRadioStation',
      { id: created.id },
      'admin',
      true,
    );
    assertEquals(await client.list(), []);
  } finally {
    await client?.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
