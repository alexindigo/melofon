// Lifecycle consumers use the production facade/listen manager and real HTTP.
import { assert, assertEquals, assertRejects } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { createHats, type Hats } from '../src/hats.ts';
import { createListenManager } from '../src/listen-manager.ts';
import { createBinds, createPortMapping } from '../src/binds.ts';
import { createNotify } from '../src/notify.ts';
import { createState } from '../src/state.ts';
import { openStore, type Store } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { captureLogs } from './helpers/logging.ts';
import { reservePorts } from './helpers/ports.ts';

async function fixture(
  root: string,
  name: string,
  manifest: object = {},
  source?: string,
) {
  const dir = `${root}/${name}`;
  await Deno.mkdir(`${dir}/routes/probe`, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/manifest.json`,
    JSON.stringify({ routes: `/${name}`, ...manifest }),
  );
  await Deno.writeTextFile(
    `${dir}/routes/probe/get.ts`,
    source ?? `export default () => ({hat: ${JSON.stringify(name)}});`,
  );
}

async function boot(
  store: Store,
  layersRoot?: string,
  env: Record<string, string> = {},
  reservation = reservePorts(1),
) {
  using reserved = reservation;
  const [port] = reserved.ports;
  const mapping = createPortMapping(env);
  const state = createState(store);
  const notify = createNotify();
  const notifications: string[][] = [];
  notify.subscribe((names) => notifications.push(names));
  const captured = captureLogs();
  let hats: Hats | undefined;
  const core = await pathfinder({ roots: ['core/'], app: { store } });
  const listens = createListenManager({
    core,
    layers: () => hats?.activeLayers() ?? [],
    mapping,
    defaultPort: port,
    hostname: '0.0.0.0',
    log: captured.log,
  });
  const binds = createBinds(() => hats?.layers() ?? [], mapping);
  try {
    reserved.release();
    hats = await createHats({
      store,
      app: { state, binds, cfg: { version: 'lifecycle-test' } },
      layersRoot,
      mapping,
      listens,
      notify,
      log: captured.log,
    });
    await listens.ensure([port]);
  } catch (error) {
    await listens.shutdown();
    throw error;
  }
  async function request(path: string, at = port) {
    return await fetch(`http://melofon.home:${at}${path}`, {
      signal: AbortSignal.timeout(2000),
    });
  }
  async function status(path: string, at = port) {
    const response = await request(path, at);
    await response.body?.cancel();
    return response.status;
  }
  return {
    hats,
    state,
    binds,
    notifications,
    logs: captured,
    port,
    request,
    status,
    close: async () => {
      await listens.shutdown();
      await captured.log.flush();
    },
  };
}

function noListen(port: number) {
  const socket = Deno.listen({ hostname: '0.0.0.0', port });
  socket.close();
}

Deno.test('hats: broken manifests, settings, mounts, ports and imports cannot abort startup', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-hats-' });
  const root = `${dir}/layers`;
  const store = await openStore(`${dir}/db`);
  try {
    await fixture(root, 'opensubsonic');
    await fixture(root, 'bad-json');
    await Deno.writeTextFile(`${root}/bad-json/manifest.json`, '{bad');
    await fixture(root, 'bad-settings', {
      settings: { broken: { type: 'unknown' } },
    });
    await fixture(root, 'bad-mount', { missing: '/missing' });
    await fixture(root, 'bad-port', { port: 0 });
    await fixture(root, 'bad-mapping', { port: [12345, 12346] });
    await fixture(
      root,
      'bad-import',
      {},
      'throw new Error("fixture import failure"); export default () => "never";',
    );
    const server = await boot(store, root, {
      'MELOFON_LISTEN_bad-mapping': '12345',
    });
    try {
      assertEquals(await server.status('/_/health'), 200);
      const response = await server.request('/opensubsonic/probe');
      assertEquals(await response.json(), { hat: 'opensubsonic' });
      for (
        const name of [
          'bad-json',
          'bad-settings',
          'bad-mount',
          'bad-port',
          'bad-mapping',
          'bad-import',
        ]
      ) {
        const hat = server.hats.list().find((h) => h.name === name)!;
        assertEquals(hat.state, 'failed', name);
        assertEquals(
          hat.errors[0].phase,
          name === 'bad-import' ? 'import' : 'manifest',
          name,
        );
        await assertRejects(
          () => server.hats.activate(name),
          Error,
          'Hat failed',
        );
        assertEquals(await server.status(`/_${name}/${name}/probe`), 404);
      }
      assert(server.notifications.length > 6);
      assert(server.notifications.every((names) => names.join() === 'hats'));
      const records = server.logs.records();
      assertEquals(records.filter((r) => r.event === 'hat_failed').length, 6);
      for (const event of ['hat_found', 'hat_loaded', 'hat_activated']) {
        assert(
          records.some((r) => r.event === event && r.hat === 'opensubsonic'),
          event,
        );
      }
    } finally {
      await server.close();
    }
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('hats: shipped migration runs once; deactivation keeps serving until restart', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-hats-' });
  let store = await openStore(dir);
  using reserved = reservePorts(3);
  const [, extra, ws] = reserved.ports;
  const env = { MELOFON_LISTEN_owntone: `${extra},${ws}` };
  try {
    const first = await boot(store, undefined, env, reserved);
    try {
      assertEquals(first.hats.list().map((h) => [h.name, h.state, h.active]), [
        ['melofon', 'active', true],
        ['opensubsonic', 'active', true],
        ['owntone', 'active', true],
        ['setup', 'found', false],
        ['share', 'active', true],
      ]);
      const discovery = await first.request(
        '/rest/getOpenSubsonicExtensions?f=json',
      );
      assertEquals((await discovery.json())['subsonic-response'].status, 'ok');
      const config = await first.request('/api/config', extra);
      assertEquals((await config.json()).websocket_port, ws);
      const share = await first.request('/share/bad');
      assertEquals(await share.text(), 'Share not found\n');
      const off = await first.hats.deactivate('opensubsonic');
      assertEquals([off.state, off.active, off.pendingRestart], [
        'active',
        false,
        true,
      ]);
      assert(first.hats.restartRequired);
      assertEquals(
        await first.status('/rest/getOpenSubsonicExtensions?f=json'),
        200,
      );
      assert(first.logs.records().some((r) => r.event === 'hat_deactivated'));
    } finally {
      await first.close();
    }
    await store.close();
    store = await openStore(dir);
    const second = await boot(store, undefined, env, reserved);
    try {
      const hat = second.hats.list().find((h) => h.name === 'opensubsonic')!;
      assertEquals([hat.state, hat.active, hat.pendingRestart], [
        'loaded',
        false,
        false,
      ]);
      assertEquals(
        await second.status('/rest/getOpenSubsonicExtensions?f=json'),
        404,
      );
      assertEquals(
        await second.status(
          '/_opensubsonic/rest/getOpenSubsonicExtensions?f=json',
        ),
        404,
      );
      assertEquals(await second.status('/api/config', extra), 200);
      assertEquals(
        (await rawSql(store).all(
          "SELECT id FROM migrations WHERE id = 'hats-001'",
        )).map((r) => r.id),
        ['hats-001'],
      );
      await second.hats.activate('opensubsonic');
      assertEquals(
        await second.status('/rest/getOpenSubsonicExtensions?f=json'),
        200,
      );
    } finally {
      await second.close();
    }
    await noListen(extra);
    await noListen(ws);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('hats: loaded inactive settings and routes activate over a new remapped listen', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-hats-' });
  const root = `${dir}/layers`;
  using reserved = reservePorts(2);
  const [, actual] = reserved.ports;
  const store = await openStore(`${dir}/db`);
  try {
    await fixture(
      root,
      'extra',
      {
        port: 12345,
        settings: { 'fixture.message': { type: 'string', default: 'before' } },
      },
      'export default async (_request, context) => ({hat: "extra", setting: await context.app.state.getTyped("fixture.message"), actual: context.app.binds.actual("extra", 12345), hasHats: "hats" in context.app});',
    );
    const server = await boot(store, root, {
      MELOFON_LISTEN_REPLACE_12345: String(actual),
    }, reserved);
    try {
      assertEquals(server.hats.list()[0].state, 'loaded');
      assertEquals(server.hats.list()[0].settings, ['fixture.message']);
      assertEquals(await server.state.getTyped('fixture.message'), 'before');
      await server.state.set('fixture.message', 'configured while inactive');
      await noListen(actual);
      assertEquals(await server.status('/_extra/extra/probe'), 404);
      assertEquals(
        await server.hats.activate('extra').then((
          h,
        ) => [h.state, h.active, h.pendingRestart]),
        ['active', true, false],
      );
      const response = await server.request('/extra/probe', actual);
      assertEquals(await response.json(), {
        hat: 'extra',
        setting: 'configured while inactive',
        actual,
        hasHats: false,
      });
      assertEquals(await server.status('/_extra/extra/probe', actual), 200);
      assertEquals(await server.status('/extra/probe'), 404);
      assertEquals(
        (await store.hats.list()).find((h) => h.name === 'extra')?.active,
        true,
      );
      await server.hats.deactivate('extra');
      assertEquals(await server.status('/extra/probe', actual), 200);
      await server.hats.activate('extra');
      assertEquals(server.hats.restartRequired, false);
    } finally {
      await server.close();
    }
    await noListen(actual);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('hats: failed multi-port activation rolls back new sockets and leaves flag off; retry works', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-hats-' });
  const root = `${dir}/layers`;
  const held = Deno.listen({ hostname: '0.0.0.0', port: 0 });
  const blocked = (held.addr as Deno.NetAddr).port;
  using reserved = reservePorts(2);
  const [, first] = reserved.ports;
  const store = await openStore(`${dir}/db`);
  let heldOpen = true;
  try {
    await fixture(root, 'extra', { port: [first, blocked] });
    const server = await boot(store, root, {}, reserved);
    try {
      await assertRejects(
        () => server.hats.activate('extra'),
        Deno.errors.AddrInUse,
      );
      const hat = server.hats.list()[0];
      assertEquals([hat.state, hat.active], ['loaded', false]);
      assertEquals(hat.errors[0].phase, 'activate');
      assertEquals(
        (await store.hats.list()).find((h) => h.name === 'extra'),
        undefined,
      );
      await noListen(first);
      assertEquals(await server.status('/_/health'), 200);
      assert(
        server.logs.records().some((r) => r.event === 'hat_activation_failed'),
      );
      held.close();
      heldOpen = false;
      await server.hats.activate('extra');
      for (const port of [first, blocked]) {
        assertEquals(await server.status('/extra/probe', port), 200);
      }
      assertEquals(server.hats.list()[0].errors, []);
    } finally {
      await server.close();
    }
    await noListen(first);
    await noListen(blocked);
  } finally {
    if (heldOpen) held.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('hats: startup port conflict is isolated and retains the desired flag', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-hats-' });
  const root = `${dir}/layers`;
  const held = Deno.listen({ hostname: '0.0.0.0', port: 0 });
  const blocked = (held.addr as Deno.NetAddr).port;
  const store = await openStore(`${dir}/db`);
  try {
    await fixture(root, 'opensubsonic');
    await fixture(root, 'owntone', { port: blocked });
    const server = await boot(store, root);
    try {
      assertEquals(await server.status('/opensubsonic/probe'), 200);
      const hat = server.hats.list().find((h) => h.name === 'owntone')!;
      assertEquals([hat.state, hat.active, hat.errors[0].phase], [
        'loaded',
        true,
        'activate',
      ]);
      assertEquals(
        (await store.hats.list()).find((h) => h.name === 'owntone')?.active,
        true,
      );
    } finally {
      await server.close();
    }
  } finally {
    held.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('hats: live shared listen excludes inactive forced routes and survives another activation failing', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-hats-' });
  const root = `${dir}/layers`;
  const held = Deno.listen({ hostname: '0.0.0.0', port: 0 });
  const blocked = (held.addr as Deno.NetAddr).port;
  using reserved = reservePorts(2);
  const [, shared] = reserved.ports;
  const store = await openStore(`${dir}/db`);
  try {
    await fixture(root, 'opensubsonic', { port: 12345 });
    await fixture(root, 'extra', { port: 12345 });
    await fixture(root, 'conflict', { port: [12345, blocked] });
    const env = { MELOFON_LISTEN_REPLACE_12345: String(shared) };
    const server = await boot(store, root, env, reserved);
    try {
      // Mutating the caller's environment cannot change the parsed mapping.
      env.MELOFON_LISTEN_REPLACE_12345 = String(blocked);
      assertEquals(server.binds.actual('extra', 12345), shared);
      assertEquals(await server.status('/opensubsonic/probe', shared), 200);
      assertEquals(await server.status('/_extra/extra/probe', shared), 404);
      await assertRejects(
        () => server.hats.activate('conflict'),
        Deno.errors.AddrInUse,
      );
      assertEquals(await server.status('/opensubsonic/probe', shared), 200);
      await server.hats.activate('extra');
      assertEquals(await server.status('/extra/probe', shared), 200);
      assertEquals(await server.status('/_extra/extra/probe', shared), 200);
      assertEquals(await server.status('/opensubsonic/probe', shared), 200);
    } finally {
      await server.close();
    }
    await noListen(shared);
  } finally {
    held.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('hats: rescan never imports; new hats wait for restart and loaded files are hashed', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-hats-' });
  const root = `${dir}/layers`;
  const store = await openStore(`${dir}/db`);
  try {
    await fixture(root, 'opensubsonic');
    await fixture(root, 'file-only');
    const server = await boot(store, root);
    try {
      // Importing this would leave independent observable evidence, then throw.
      const marker = `${dir}/imported`;
      await fixture(
        root,
        'later',
        { settings: { 'later.ready': { type: 'boolean', default: true } } },
        `Deno.writeTextFileSync(${
          JSON.stringify(marker)
        }, 'imported'); throw new Error('rescan imported code'); export default () => 'never';`,
      );
      await server.hats.rescan();
      assertEquals(
        server.hats.list().find((h) => h.name === 'later')?.state,
        'found',
      );
      assertEquals(await server.state.getTyped('later.ready'), true);
      await assertRejects(() => Deno.stat(marker), Deno.errors.NotFound);
      const activated = await server.hats.activate('later');
      assertEquals([
        activated.state,
        activated.active,
        activated.pendingRestart,
      ], ['found', true, true]);
      assertEquals(await server.status('/later/probe'), 404);
      assertEquals(await server.status('/_later/later/probe'), 404);
      await fixture(root, 'later-good');
      await server.hats.rescan();
      await server.hats.activate('later-good');
      assertEquals(await server.status('/later-good/probe'), 404);
      await Deno.writeTextFile(
        `${root}/file-only/routes/probe/get.ts`,
        'throw new Error("file-only change must not import");',
      );
      await server.hats.rescan();
      assert(
        server.hats.list().find((h) => h.name === 'file-only')?.pendingRestart,
      );
      assert(
        server.hats.list().find((h) => h.name === 'file-only')?.errors.some((
          e,
        ) => e.code === 'hat_changed'),
      );
      await Deno.writeTextFile(
        `${root}/opensubsonic/manifest.json`,
        JSON.stringify({ routes: '/moved' }),
      );
      await server.hats.rescan();
      assertEquals(await server.status('/opensubsonic/probe'), 200);
      assertEquals(await server.status('/moved/probe'), 404);
      assert(
        server.hats.list().find((h) => h.name === 'opensubsonic')?.errors.some((
          e,
        ) => e.code === 'hat_changed'),
      );
      assert(server.hats.restartRequired);
      await Deno.writeTextFile(
        `${root}/opensubsonic/routes/probe/get.ts`,
        'throw new Error("changed route must not import");',
      );
      await server.hats.rescan();
      assertEquals(await server.status('/opensubsonic/probe'), 200);
      await assertRejects(() => Deno.stat(marker), Deno.errors.NotFound);
    } finally {
      await server.close();
    }
    const restarted = await boot(store, root);
    try {
      assertEquals(
        restarted.hats.list().find((h) => h.name === 'later-good')?.state,
        'active',
      );
      assertEquals(await restarted.status('/later-good/probe'), 200);
      assertEquals(
        restarted.hats.list().find((h) => h.name === 'later')?.state,
        'failed',
      );
      assertEquals(await Deno.readTextFile(`${dir}/imported`), 'imported');
    } finally {
      await restarted.close();
    }
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('hats: setup marker is reserved, configurable, and never imported or activated', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-hats-' });
  const root = `${dir}/layers`;
  const store = await openStore(`${dir}/db`);
  try {
    await fixture(
      root,
      'setup',
      {
        setup: true,
        settings: { 'setup.title': { type: 'string', default: 'Setup' } },
      },
      'throw new Error("setup must not import"); export default () => "never";',
    );
    const server = await boot(store, root);
    try {
      assertEquals(server.hats.list()[0].setup, true);
      assertEquals(server.hats.list()[0].state, 'found');
      assertEquals(await server.state.getTyped('setup.title'), 'Setup');
      await assertRejects(
        () => server.hats.activate('setup'),
        Error,
        'Setup hat is reserved',
      );
      assertEquals(await server.status('/_setup/setup/probe'), 404);
    } finally {
      await server.close();
    }
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('hats: pre-ledger database receives shipped flags once on upgrade', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-hats-' });
  let store = await openStore(dir);
  try {
    // Remove only the new tables, reproducing the BASE database schema.
    await rawSql(store).run('DROP TABLE hats');
    await rawSql(store).run('DROP TABLE migrations');
    await store.close();
    store = await openStore(dir);
    assertEquals(await store.hats.list(), [
      { name: 'melofon', active: true },
      { name: 'opensubsonic', active: true },
      { name: 'owntone', active: true },
      { name: 'share', active: true },
    ]);
    using reserved = reservePorts(3);
    const [, own, ws] = reserved.ports;
    const upgraded = await boot(store, undefined, {
      MELOFON_LISTEN_owntone: `${own},${ws}`,
    }, reserved);
    try {
      assert(
        upgraded.hats.list().every((h) =>
          h.setup ? h.state === 'found' : h.state === 'active'
        ),
      );
      assertEquals(
        await upgraded.status('/rest/getOpenSubsonicExtensions?f=json'),
        200,
      );
      const share = await upgraded.request('/share/bad');
      assertEquals(await share.text(), 'Share not found\n');
      const ownPort = upgraded.hats.list().find((h) =>
        h.name === 'owntone'
      )!.ports.actual[0];
      assertEquals(await upgraded.status('/api/config', ownPort), 200);
    } finally {
      await upgraded.close();
    }
    await store.hats.set('share', false);
    const applied = await rawSql(store).all(
      'SELECT id, applied_at FROM migrations',
    );
    await store.close();
    store = await openStore(dir);
    assertEquals(
      (await store.hats.list()).find((h) => h.name === 'share')?.active,
      false,
    );
    assertEquals(
      await rawSql(store).all('SELECT id, applied_at FROM migrations'),
      applied,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
