import { assert, assertEquals, assertRejects } from '@std/assert';
import { apiFixture, error } from './helpers/api.ts';
import { eventually, lookupManifest, lookupPlugin } from './helpers/lookup.ts';
import { pictured } from './helpers/pictured.ts';
import { createLookupRunner } from '../src/lookups/runner.ts';
import { createLookupNetwork } from '../src/lookups/net.ts';
import { createPlugins } from '../src/plugins.ts';
import { createSettings } from '../src/settings.ts';
import { createLibraries } from '../src/libraries.ts';
import { createScan } from '../src/scan.ts';
import type { Plugin, PluginDetail } from '../layers/melofon/types.ts';

const base = '/api/v1/admin/plugins';
const prefix = 'lookups.plugin.fixture';
const key = (name: string) => `${prefix}.${name}`;
const code = `export default { async cover(_item, ctx) {
  const response = await ctx.fetch('http://fixture.test/echo', {
    method: 'POST', body: JSON.stringify(ctx.settings),
  });
  await response.text();
  return { candidates: [] };
} };`;
const manifest = lookupManifest({
  name: 'Operator fixture',
  network: {
    hosts: ['fixture.test', '*.images.test'],
    reason: 'Echo the settings in the test VM',
    ratePerMinute: 600000,
  },
  settings: {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        default: 'original',
        title: 'Label',
        description: 'Value echoed by the worker',
      },
      count: { type: 'integer', minimum: 1, maximum: 5, default: 2 },
      token: { type: 'string', writeOnly: true },
      optional: { type: 'string' },
    },
  },
});
type Runner = Awaited<ReturnType<typeof createLookupRunner>>;
async function fixture() {
  let runner: Runner | undefined;
  let plugins: ReturnType<typeof createPlugins> | undefined;
  let builtin = '';
  let albumId = '';
  const echoes: Record<string, unknown>[] = [];
  let block: Promise<void> | undefined;
  const receiver = Deno.serve(
    { hostname: '0.0.0.0', port: 0, onListen() {} },
    async (r) => {
      echoes.push(JSON.parse(await r.text()));
      await block;
      return new Response('received');
    },
  );
  let f: Awaited<ReturnType<typeof apiFixture>>;
  try {
    f = await apiFixture({
      services: async (f) => {
        builtin = `${f.dir}/builtin`;
        await Deno.mkdir(builtin);
        // The actual shipped code/manifests plus a shadowed builtin fixture.
        for (const id of ['deezer', 'itunes-covers']) {
          await Deno.mkdir(`${builtin}/${id}`);
          for await (const entry of Deno.readDir(`lookups/${id}`)) {
            assert(entry.isFile);
            await Deno.copyFile(
              `lookups/${id}/${entry.name}`,
              `${builtin}/${id}/${entry.name}`,
            );
          }
        }
        await lookupPlugin(builtin, undefined, 'fixture');
        await lookupPlugin(
          `${f.dir}/plugins/lookups`,
          code,
          'fixture',
          manifest,
        );
        const broken = await lookupPlugin(
          `${f.dir}/plugins/lookups`,
          undefined,
          'broken',
        );
        await Deno.writeTextFile(`${broken}/manifest.json`, '{}');
        await lookupPlugin(
          `${f.dir}/plugins/lookups`,
          'export default {};',
          'crashed',
        );
        await f.state.set('lookups.maxAttempts', '1');
        const root = `${f.dir}/music`;
        await pictured(`${root}/Album/song.mp3`);
        await createLibraries(f.store).add('Music', root);
        await createScan(f.store).run();
        albumId = (await f.store.catalog.listAlbums({
          sort: 'name',
          size: 1,
          offset: 0,
        }))[0].id;
        runner = await createLookupRunner({
          store: f.store,
          state: f.state,
          dataDir: f.dir,
          builtin,
          notify: f.notify,
          network: createLookupNetwork({
            fixtures: {
              'fixture.test': `http://melofon.home:${receiver.addr.port}`,
            },
          }),
        });
        plugins = createPlugins(
          f.store,
          runner,
          createSettings(f.store, f.state),
        );
        return { plugins };
      },
    });
    await eventually(async () => {
      const { plugins: views } = await plugins!.list(f.admin.id);
      return views.every((p) => ['ready', 'failed'].includes(p.state));
    });
  } catch (e) {
    await runner?.close();
    await receiver.shutdown();
    throw e;
  }
  return {
    ...f,
    runner: runner!,
    plugins: plugins!,
    builtin,
    echoes,
    block(promise?: Promise<void>) {
      block = promise;
    },
    async run() {
      await runner!.request({ type: 'album', id: albumId }, 'all');
    },
    stats: () => f.store.lookups.stats('fixture'),
    async close() {
      await runner!.close();
      await receiver.shutdown();
      await f.close();
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function list(f: Fixture, credential: string): Promise<Plugin[]> {
  const response = await f.get(base, credential, { Origin: f.origin });
  assertEquals(response.status, 200, await response.clone().text());
  return (await response.json()).plugins;
}
async function get(
  f: Fixture,
  credential: string,
  id = 'fixture',
): Promise<PluginDetail> {
  const response = await f.get(`${base}/${id}`, credential, {
    Origin: f.origin,
  });
  assertEquals(response.status, 200, await response.clone().text());
  return response.json();
}
function patch(f: Fixture, credential: string, body: unknown, id = 'fixture') {
  return f.json(`${base}/${id}`, 'PATCH', body, credential);
}
async function changed(
  f: Fixture,
  credential: string,
  body: unknown,
): Promise<PluginDetail> {
  const r = await patch(f, credential, body);
  assertEquals(r.status, 200, await r.clone().text());
  return r.json();
}
async function failure(r: Response, code: string, field?: string) {
  const body = await r.json();
  assertEquals(
    r.status,
    code === 'revision_conflict' ? 409 : 400,
    JSON.stringify(body),
  );
  assertEquals(body.code, code);
  assertEquals(typeof body.message, 'string');
  if (field !== undefined) assertEquals(body.key, field);
  return body;
}
async function ready(f: Fixture, credential: string) {
  await eventually(async () => (await get(f, credential)).state === 'ready');
}
async function member(f: Fixture, role: 'user' | 'admin' = 'user') {
  const user = await f.auth.users.create(f.admin.id, {
    username: `member-${role}`,
    password: 'password-member',
    role,
  });
  return { ...await f.login('bearer', user.username, 'password-member'), user };
}

Deno.test('API plugins: shipped, overridden and broken discovery, truthful state and declared settings forms', async () => {
  const f = await fixture();
  try {
    const { credential } = await f.login();
    const views = await list(f, credential);
    assertEquals(views.map((p) => p.id), [
      'broken',
      'crashed',
      'deezer',
      'fixture',
      'itunes-covers',
    ]);
    for (const id of ['deezer', 'itunes-covers']) {
      const p = views.find((p) => p.id === id)!;
      assertEquals(p.origin, 'builtin');
      assertEquals(p.state, 'ready');
      assertEquals(p.discovery, 'startup');
      assertEquals((await get(f, credential, id)).enabled, true);
      assert(p.capabilities.length > 0);
      assert(p.network.requestedHosts.length > 0);
      assertEquals(p.network.approvedHosts, []);
      assert(!('dir' in p));
    }
    for (const id of ['broken', 'crashed']) {
      const p = views.find((p) => p.id === id)!;
      assertEquals(p.state, 'failed');
      assertEquals(p.origin, 'override');
      assert(
        p.error!.includes(
          id === 'broken'
            ? 'Unsupported lookup contract'
            : 'Missing capability export',
        ),
      );
    }
    const p = await get(f, credential);
    assertEquals(p.name, 'Operator fixture');
    assertEquals(p.origin, 'override');
    assertEquals(p.version, '1.0.0');
    assertEquals(
      p.network.requestedHosts,
      ['fixture.test', '*.images.test'].map((host) => ({
        host,
        reason: 'Echo the settings in the test VM',
        ratePerMinute: 600000,
      })),
    );
    assertEquals(p.settingKeys, [
      key('enabled'),
      key('hosts'),
      ...['label', 'count', 'token', 'optional'].map((s) =>
        key(`settings.${s}`)
      ),
    ]);
    assertEquals(p.settings.schema, {
      type: 'object',
      properties: manifest.settings.properties,
    });
    assertEquals(p.settings.values, {
      label: 'original',
      count: 2,
      token: { isSet: false },
      optional: null,
    });
    assertEquals(p.enabled, true);
    assertEquals(p.hosts, []);
    assertEquals(
      p.settings.revisions,
      Object.fromEntries(p.settingKeys.map((k) => [k, 0])),
    );
    const broken = await get(f, credential, 'broken');
    assertEquals(broken.settings.schema, { type: 'object', properties: {} });
    await lookupPlugin(
      `${f.dir}/plugins/lookups`,
      undefined,
      'added-after-start',
    );
    assertEquals(
      (await list(f, credential)).map((p) => p.id),
      views.map((p) => p.id),
    );
    const rescan = await f.json(`${base}/rescan`, 'POST', {}, credential);
    await error(rescan, 405, 'method_not_allowed');
    assertEquals(rescan.headers.get('allow')?.split(', ').sort(), [
      'GET',
      'PATCH',
    ]);
    for (const id of ['unknown', 'added-after-start']) {
      await error(await f.get(`${base}/${id}`, credential), 404, 'not_found');
      await error(await patch(f, credential, {}, id), 404, 'not_found');
    }
  } finally {
    await f.close();
  }
});

Deno.test('API plugins: admin placement, core role checks, cookie/Bearer and inherited Origin/body guards', async () => {
  const f = await fixture();
  try {
    const user = await member(f);
    for (const credential of [undefined, user.credential]) {
      const status = credential ? 403 : 401;
      const code = credential ? 'forbidden' : 'unauthenticated';
      for (const path of [base, `${base}/fixture`, `${base}/unknown`]) {
        await error(await f.get(path, credential), status, code);
      }
      await error(
        await f.json(
          `${base}/fixture`,
          'PATCH',
          { enabled: false },
          credential,
        ),
        status,
        code,
      );
    }
    for (const caller of ['', user.user.id]) {
      for (
        const call of [
          () => f.plugins.list(caller),
          () => f.plugins.get(caller, 'fixture'),
          () => f.plugins.change(caller, 'fixture', {}),
        ]
      ) {
        await assertRejects(call, Error, 'forbidden');
      }
    }
    const cookie = await f.login();
    const bearer = await f.login('bearer');
    for (const login of [cookie, bearer]) {
      await error(
        await f.json(
          `${base}/fixture`,
          'PATCH',
          {},
          login.credential,
          'http://foreign.home',
        ),
        403,
        'origin',
      );
      await error(
        await f.json(`${base}/fixture`, 'PATCH', {}, login.credential, 'null'),
        403,
        'origin',
      );
    }
    await error(
      await f.json(`${base}/fixture`, 'PATCH', {}, cookie.credential, null),
      403,
      'origin',
    );
    const noOrigin = await f.json(
      `${base}/fixture`,
      'PATCH',
      {},
      bearer.credential,
      null,
    );
    assertEquals(noOrigin.status, 200);
    await noOrigin.json();
    await error(
      await patch(f, cookie.credential, { rescan: true }),
      400,
      'unknown_field',
    );
    for (
      const body of [{ settings: [] }, { settings: null }, { revisions: [] }, {
        revisions: null,
      }]
    ) {
      await failure(await patch(f, cookie.credential, body), 'invalid_value');
    }
    await error(
      await f.request(`${base}/fixture`, {
        method: 'PATCH',
        headers: {
          Cookie: cookie.credential,
          Origin: f.origin,
          'Content-Type': 'application/json',
        },
        body: '{bad',
      }),
      400,
      'not_json',
    );
    assertEquals((await get(f, cookie.credential)).enabled, true);
    await f.auth.users.setRole(f.admin.id, user.user.id, 'admin');
    assertEquals((await f.plugins.list(user.user.id)).plugins.length, 5);
    await f.auth.users.setRole(f.admin.id, user.user.id, 'user');
    await assertRejects(() => f.plugins.list(user.user.id), Error, 'forbidden');
  } finally {
    await f.close();
  }
});

Deno.test('API plugins: disable stops an active worker and its job waits; enable resumes it to ready', async () => {
  const f = await fixture();
  const held = Promise.withResolvers<void>();
  try {
    const { credential } = await f.login();
    await changed(f, credential, { hosts: ['fixture.test'] });
    await ready(f, credential);
    f.block(held.promise);
    await f.run();
    await eventually(() => f.echoes.length === 1);
    const generation = f.runner.hosts.find((h) =>
      h.plugin.id === 'fixture'
    )!.generation;
    assert(generation);
    const disabled = await changed(f, credential, { enabled: false });
    assertEquals(disabled.enabled, false);
    assertEquals(disabled.state, 'disabled');
    assertEquals(
      f.runner.hosts.find((h) => h.plugin.id === 'fixture')!.generation,
      undefined,
    );
    await eventually(async () => (await f.stats()).waiting === 1);
    assertEquals((await f.stats()).active, 0);
    f.block();
    held.resolve();
    const enabled = await changed(f, credential, { enabled: true });
    assertEquals(enabled.enabled, true);
    assert(['starting', 'ready'].includes(enabled.state));
    await ready(f, credential);
    await eventually(async () => (await f.stats()).done === 1);
    assertEquals(f.echoes.length, 2);
    assert(
      f.runner.hosts.find((h) => h.plugin.id === 'fixture')!.generation !==
        generation,
    );
  } finally {
    held.resolve();
    await f.close();
  }
});

Deno.test('API plugins: requested-host subsets only, wildcard narrowing and immediate in-flight revocation', async () => {
  const f = await fixture();
  const held = Promise.withResolvers<void>();
  try {
    const { credential } = await f.login('bearer');
    const before = await get(f, credential);
    for (
      const hosts of [['evil.test'], ['*.test'], ['*.fixture.test'], [
        'images.test',
      ], ['fixture.test', '*.test']]
    ) {
      await failure(
        await patch(f, credential, { enabled: false, hosts }),
        'host_not_requested',
      );
      assertEquals(await get(f, credential), before);
    }
    for (const hosts of [12, ['http://fixture.test'], [1]]) {
      await failure(
        await patch(f, credential, { hosts }),
        'invalid_value',
        key('hosts'),
      );
    }
    const granted = await changed(f, credential, {
      hosts: ['FIXTURE.TEST', 'one.images.test', '*.sub.images.test'],
    });
    assertEquals(granted.network.approvedHosts, [
      '*.sub.images.test',
      'fixture.test',
      'one.images.test',
    ]);
    assertEquals(granted.hosts, [
      'fixture.test',
      'one.images.test',
      '*.sub.images.test',
    ]);
    await ready(f, credential);
    const host = f.runner.hosts.find((h) => h.plugin.id === 'fixture')!;
    const authority = host.authority;
    f.block(held.promise);
    await f.run();
    await eventually(() => f.echoes.length === 1);
    const narrowed = await changed(f, credential, {
      hosts: ['one.images.test'],
    });
    assert(
      authority.signal.aborted,
      'old network authority must already be retired',
    );
    assertEquals(narrowed.network.approvedHosts, ['one.images.test']);
    assertEquals(narrowed.hosts, ['one.images.test']);
    f.block();
    held.resolve();
    await eventually(async () => (await f.stats()).failed === 1);
    assertEquals(
      f.echoes.length,
      1,
      'revoked host must not reach receiver again',
    );
    await changed(f, credential, { hosts: null });
    assertEquals((await get(f, credential)).network.approvedHosts, []);
  } finally {
    held.resolve();
    await f.close();
  }
});

Deno.test('API plugins: one atomic a6 batch, shared revisions, stale conflict, validation and null resets', async () => {
  const f = await fixture();
  try {
    const { credential } = await f.login();
    const before = await get(f, credential);
    const count = f.settingNotifications.length;
    for (
      const [settings, field] of [
        [{ label: 'valid', count: 6 }, 'count'],
        [{ label: 'valid', count: '2' }, 'count'],
        [{ label: 1 }, 'label'],
        [{ missing: true }, 'missing'],
        [{ 'count.other': 1 }, 'count.other'],
      ] as const
    ) {
      await failure(
        await patch(f, credential, {
          enabled: false,
          hosts: ['fixture.test'],
          settings,
        }),
        'invalid_value',
        key(`settings.${field}`),
      );
      assertEquals(await get(f, credential), before);
    }
    assertEquals(f.settingNotifications.length, count);
    const first = await changed(f, credential, {
      enabled: false,
      hosts: ['fixture.test'],
      settings: { label: 'new', count: 5 },
      revisions: Object.fromEntries(
        ['enabled', 'hosts', 'settings.label', 'settings.count'].map((
          k,
        ) => [key(k), 0]),
      ),
    });
    assertEquals(first.state, 'disabled');
    assertEquals(first.settings.values.count, 5);
    assertEquals(f.settingNotifications.slice(count), [{
      settings: [
        key('enabled'),
        key('hosts'),
        key('settings.label'),
        key('settings.count'),
      ],
    }]);
    const generic = await f.get('/api/v1/admin/settings', credential);
    const rows = (await generic.json()).settings;
    for (const [k, revision] of Object.entries(first.settings.revisions)) {
      assertEquals(
        rows.find((s: { key: string }) => s.key === k).revision,
        revision,
      );
    }
    const conflict = await failure(
      await patch(f, credential, {
        enabled: true,
        settings: { label: 'stale' },
        revisions: { [key('enabled')]: 0 },
      }),
      'revision_conflict',
    );
    assertEquals(conflict.revisions[key('enabled')], 1);
    assertEquals(await get(f, credential), first);
    for (
      const revisions of [{ other: 0 }, { [key('settings.count')]: -1 }, {
        [key('settings.count')]: '1',
      }, { [key('settings.count')]: 1.5 }]
    ) {
      await failure(
        await patch(f, credential, { settings: { count: 3 }, revisions }),
        'invalid_value',
      );
    }
    const genericChange = await f.json('/api/v1/admin/settings', 'PATCH', {
      changes: [{ key: key('settings.label'), value: 'generic', revision: 1 }],
    }, credential);
    assertEquals(genericChange.status, 200);
    await genericChange.json();
    assertEquals((await get(f, credential)).settings.values.label, 'generic');
    await failure(
      await patch(f, credential, {
        settings: { label: 'stale' },
        revisions: { [key('settings.label')]: 1 },
      }),
      'revision_conflict',
    );
    const reset = await changed(f, credential, {
      enabled: null,
      hosts: null,
      settings: { label: null, count: null },
    });
    assertEquals(reset.enabled, true);
    assertEquals(reset.hosts, []);
    assertEquals(reset.settings.values.label, 'original');
    assertEquals(reset.settings.values.count, 2);
    assertEquals(reset.settings.revisions[key('settings.label')], 3);
    assertEquals(reset.settings.revisions[key('enabled')], 2);
    await ready(f, credential);
  } finally {
    await f.close();
  }
});

Deno.test('API plugins: setting change reaches the real worker and its HTTP consumer; write-only settings stay server-side', async () => {
  const f = await fixture();
  try {
    const { credential } = await f.login();
    await changed(f, credential, { hosts: ['fixture.test'] });
    await ready(f, credential);
    await f.run();
    await eventually(async () => (await f.stats()).done === 1);
    assertEquals(f.echoes[0], { label: 'original', count: 2 });
    const secret = 'plugin-test-token-837219';
    const result = await changed(f, credential, {
      settings: { label: 'from-api', count: 4, token: secret },
    });
    assertEquals(result.settings.values, {
      label: 'from-api',
      count: 4,
      token: { isSet: true },
      optional: null,
    });
    assert(!JSON.stringify(result).includes(secret));
    assert(!JSON.stringify(await get(f, credential)).includes(secret));
    assert(!JSON.stringify(await list(f, credential)).includes(secret));
    assert(!JSON.stringify(f.settingNotifications).includes(secret));
    await ready(f, credential);
    await f.run();
    await eventually(async () => (await f.stats()).done === 2);
    assertEquals(f.echoes[1], { label: 'from-api', count: 4, token: secret });
    const revision = result.settings.revisions[key('settings.count')];
    await failure(
      await patch(f, credential, { settings: { count: 0 } }),
      'invalid_value',
      key('settings.count'),
    );
    assertEquals(
      (await get(f, credential)).settings.revisions[key('settings.count')],
      revision,
    );
    await changed(f, credential, {
      settings: { label: null, count: null, token: null },
    });
    await ready(f, credential);
    await f.run();
    await eventually(async () => (await f.stats()).done === 3);
    assertEquals(f.echoes[2], f.echoes[0]);
    assertEquals((await get(f, credential)).settings.values.token, {
      isSet: false,
    });
  } finally {
    await f.close();
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function socket(f: Fixture, credential: string) {
  const ws = new WebSocket(
    `${f.origin.replace('http:', 'ws:')}/api/v1/events`,
    {
      headers: {
        Origin: f.origin,
        ...(credential.startsWith('melofon_session=')
          ? { Cookie: credential }
          : { Authorization: `Bearer ${credential}` }),
      },
    },
  );
  const frames: { type: string; events?: Record<string, string[]> }[] = [];
  ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
  return {
    frames,
    async ready() {
      await eventually(() => frames.length > 0);
      assertEquals(frames.shift()!.type, 'hello');
    },
    async close() {
      if (ws.readyState < WebSocket.CLOSING) ws.close();
      await eventually(() => ws.readyState === WebSocket.CLOSED);
    },
  };
}
Deno.test('API plugins: real lifecycle and settings events reach admins only with fresh-role filtering', async () => {
  const f = await fixture();
  const sockets: ReturnType<typeof socket>[] = [];
  try {
    const admin = await f.login();
    const user = await member(f);
    const second = await member(f, 'admin');
    for (const login of [admin, user, second]) {
      const s = socket(f, login.credential);
      sockets.push(s);
      await s.ready();
    }
    const disabled = await changed(f, admin.credential, { enabled: false });
    assertEquals(disabled.state, 'disabled');
    await eventually(() =>
      [sockets[0], sockets[2]].every((s) =>
        s.frames.some((frame) => frame.events?.plugins?.includes('fixture'))
      )
    );
    for (const s of [sockets[0], sockets[2]]) {
      assert(
        s.frames.some((frame) =>
          frame.events?.settings?.includes(key('enabled'))
        ),
      );
      assert(
        s.frames.every((frame) =>
          Object.values(frame.events ?? {}).every((ids) =>
            ids.every((id) => id === 'fixture' || id === key('enabled'))
          )
        ),
      );
    }
    await f.auth.users.setRole(f.admin.id, second.user.id, 'user');
    // Wait for the previous administrative send to drain before a new transition.
    await sleep(100);
    for (const s of sockets) s.frames.length = 0;
    await changed(f, admin.credential, { enabled: true });
    await ready(f, admin.credential);
    await eventually(() =>
      sockets[0].frames.some((frame) =>
        frame.events?.plugins?.includes('fixture')
      )
    );
    // A private preference event is a same-connection processing barrier.
    const r = await f.json('/api/v1/me/preferences', 'PATCH', {
      preferences: { theme: 'dark' },
    }, user.credential);
    assertEquals(r.status, 200);
    await r.json();
    await eventually(() => sockets[1].frames.length > 0);
    await sleep(100);
    assert(
      sockets[1].frames.every((frame) =>
        !frame.events?.plugins && !frame.events?.settings
      ),
    );
    assert(
      sockets[2].frames.every((frame) =>
        !frame.events?.plugins && !frame.events?.settings
      ),
    );
  } finally {
    for (const s of sockets) await s.close();
    await f.close();
  }
});
