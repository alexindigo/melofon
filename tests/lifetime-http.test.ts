import { assert, assertEquals } from '@std/assert';
import { openStore } from '../src/store/index.ts';
import { createLibraries } from '../src/libraries.ts';
import { scanLibrary } from '../src/scan.ts';
import { restored } from './helpers/prepared.ts';
import { eventually, lookupPlugin } from './helpers/lookup.ts';
import { reservePorts } from './helpers/ports.ts';

type Event = { name: string; [key: string]: unknown };
async function boot(mode: string) {
  assert(
    (await Deno.resolveDns('melofon.home', 'A')).every((ip) =>
      !ip.startsWith('127.')
    ),
  );
  const dir = await restored('lifetime-http', async (dir) => {
    const store = await openStore(`${dir}/db`);
    try {
      await createLibraries(store).add(
        'Fixture',
        await Deno.realPath('tests/fixtures/library'),
      );
      await scanLibrary(store);
      // A real local plugin, with no external network or credential requirement.
      await lookupPlugin(`${dir}/db/lookups`);
    } finally {
      await store.close();
    }
  }, 'melofon-lifetime-http-');
  using ports = reservePorts(3);
  const [port, own, ws] = ports.ports;
  const origin = `http://melofon.home:${port}`;
  const env: Record<string, string> = {};
  for (
    const key of ['HOME', 'PATH', 'DENO_DIR', 'TMPDIR', 'MELOFON_RAOP_LIB']
  ) {
    const value = Deno.env.get(key);
    if (value !== undefined) env[key] = value;
  }
  ports.release();
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      'test',
      '--frozen',
      '--cached-only',
      '--node-modules-dir=manual',
      '--allow-all',
      'tests/fixtures/lifetime-http-server.ts',
      '--',
      mode,
      dir,
      ...ports.ports.map(String),
    ],
    clearEnv: true,
    env,
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  const logs = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  let status: Deno.CommandStatus | undefined;
  void child.status.then((value) => status = value);
  async function events(): Promise<Event[]> {
    try {
      return JSON.parse(await Deno.readTextFile(`${dir}/events.json`));
    } catch (error) {
      if (
        error instanceof Deno.errors.NotFound || error instanceof SyntaxError
      ) return [];
      throw error;
    }
  }
  const wait = (name: string) =>
    eventually(async () => {
      const found = (await events()).some((e) => e.name === name);
      if (!found && status) throw new Error((await logs).join('\n'));
      return found;
    }, 60000);
  const mark = (name: string) => Deno.writeTextFile(`${dir}/${name}`, 'yes');
  let key = '';
  const request = (path: string, method = 'GET', body?: unknown) =>
    fetch(`${origin}${path}`, {
      method,
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60000),
    });
  async function api(path: string, method = 'GET', body?: unknown) {
    const response = await request(`/api/v1${path}`, method, body);
    const text = await response.text();
    assert(response.ok, `${method} ${path}: ${response.status} ${text}`);
    return text ? JSON.parse(text) : undefined;
  }
  async function exited() {
    await eventually(() => status !== undefined, 60000);
    assertEquals(status!.code, 0, (await logs).join('\n'));
    return await events();
  }
  async function close() {
    await mark('release');
    await mark('recover');
    if (!status) {
      try {
        child.kill('SIGTERM');
      } catch { /* Already exited. */ }
    }
    try {
      await exited();
    } finally {
      if (!status) {
        child.kill('SIGKILL');
        await child.status;
      }
      await logs;
      await Deno.remove(dir, { recursive: true });
    }
  }
  try {
    if (mode !== 'startup') {
      await wait('serving');
      key = (await api('/session', 'POST', {
        username: 'admin',
        password: 'lifetime-http-password',
        use: 'bearer',
        deviceName: 'Lifetime acceptance',
      })).key;
    }
    return {
      dir,
      child,
      events,
      wait,
      mark,
      request,
      api,
      exited,
      close,
      ports: [port, own, ws],
      isExited: () => status !== undefined,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

for (const mode of ['scan', 'prepare']) {
  Deno.test(`cold HTTP SIGTERM joins ${mode} before store close and process exit`, async () => {
    const t = await boot(mode);
    let pending: Promise<unknown> | undefined;
    try {
      const songs = (await t.api('/songs?limit=2')).songs;
      await t.mark('arm');
      if (mode === 'scan') {
        const response = await t.request('/api/v1/admin/scans', 'POST', {
          mode: 'full',
        });
        assertEquals(response.status, 202);
        await response.body?.cancel();
      } else {
        pending = t.api('/players/1/queue/items', 'POST', {
          references: [{ kind: 'song', id: songs[0].id }],
          startPlaying: true,
        }).catch((error) => error);
      }
      await t.wait(`${mode}-entered`);
      t.child.kill('SIGTERM');
      await t.wait('sigterm');
      assertEquals(t.isExited(), false);
      assertEquals(
        (await t.events()).some((e) => e.name === 'store-closing'),
        false,
      );
      await t.mark('release');
      await pending;
      const events = await t.exited();
      const names = events.map((e) => e.name);
      assert(names.indexOf('sigterm') < names.indexOf(`${mode}-settled`));
      assert(names.indexOf(`${mode}-settled`) < names.indexOf('store-closing'));
      assert(names.indexOf('store-closed') < names.indexOf('exit'));
      assertEquals(events.filter((e) => e.name === 'late-store-call'), []);
      const store = await openStore(`${t.dir}/db`);
      await store.close();
    } finally {
      await t.mark('release');
      await pending;
      await t.close();
    }
  });
}

Deno.test('cold startup failure after serving releases real listeners, Workers and store', async () => {
  const t = await boot('startup');
  try {
    const events = await t.exited();
    const opened = events.find((e) => e.name === 'serving');
    assert(opened && Number(opened.activeWorkers) > 0);
    assert(
      events.some((e) =>
        e.name === 'rollback' && e.storeClosed && e.activeWorkers === 0 &&
        e.rebound === 3 && e.reopened === true
      ),
    );
    for (const port of t.ports) {
      const socket = Deno.listen({ hostname: '0.0.0.0', port });
      socket.close();
    }
    const store = await openStore(`${t.dir}/db`);
    await store.close();
  } finally {
    await t.close();
  }
});

Deno.test('cold HTTP two-player command burst succeeds once and saves in publication order after recovery', async () => {
  const t = await boot('saves');
  try {
    const { player: kitchen } = await t.api('/players', 'POST', {
      name: 'Kitchen',
    });
    const songs = (await t.api('/songs?limit=2')).songs;
    await t.api('/players/1/queue/items', 'POST', {
      references: [{ kind: 'song', id: songs[0].id }],
    });
    await t.api(`/players/${kitchen.id}/queue/items`, 'POST', {
      references: [{ kind: 'song', id: songs[1].id }],
    });
    await eventually(async () =>
      (await (await t.request('/_/health')).json()).ok === true
    );
    await t.mark('arm');
    await t.api('/players/1/queue/copy/add', 'POST', {
      targetPlayerId: kitchen.id,
    });
    await t.api(`/players/${kitchen.id}/queue/copy/add`, 'POST', {
      targetPlayerId: 1,
    });
    for (
      const [id, volume] of [[1, 61], [kitchen.id, 71], [1, 62], [
        kitchen.id,
        72,
      ]]
    ) {
      await t.api(`/players/${id}/volume`, 'PUT', { volume });
    }
    const homeQueue = await t.api('/players/1/queue?view=all');
    const kitchenQueue = await t.api(`/players/${kitchen.id}/queue?view=all`);
    assertEquals(
      homeQueue.items.map((e: { reference: { id: string } }) => e.reference.id),
      [songs[0].id, songs[1].id, songs[0].id],
    );
    assertEquals(
      kitchenQueue.items.map((e: { reference: { id: string } }) =>
        e.reference.id
      ),
      [songs[1].id, songs[0].id],
    );
    const unhealthy = await t.request('/_/health');
    assertEquals(unhealthy.status, 503);
    assertEquals(await unhealthy.json(), {
      ok: false,
      persistence: { pendingWrites: 6 },
    });
    const failed = (await t.events()).filter((e) => e.name === 'save-attempt');
    assert(failed.length >= 6);
    assert(
      failed.every((e) =>
        JSON.stringify(e.changes) === JSON.stringify(failed[0].changes)
      ),
    );
    await t.mark('recover');
    await eventually(
      async () => (await (await t.request('/_/health')).json()).ok === true,
      60000,
    );
    const landed = (await t.events()).filter((e) => e.name === 'save-landed');
    assertEquals(landed.length, 6);
    assertEquals(landed[0].changes, failed[0].changes);
    // The successful durable snapshots must follow the exact command sequence.
    const batches = landed.map((e) => e.changes) as {
      players: {
        playerId: number;
        volume?: number;
        queue?: { items: { id: number }[] };
      }[];
    }[];
    assertEquals(
      batches[0].players.find((p) => p.playerId === kitchen.id)!.queue!.items
        .map((e) => e.id),
      kitchenQueue.items.map((e: { entryId: number }) => e.entryId),
    );
    assertEquals(
      batches[1].players.find((p) => p.playerId === 1)!.queue!.items
        .map((e) => e.id),
      homeQueue.items.map((e: { entryId: number }) => e.entryId),
    );
    assertEquals(
      batches.slice(2).map((b) => b.players.map((p) => [p.playerId, p.volume])),
      [[[1, 61]], [[kitchen.id, 71]], [[1, 62]], [[kitchen.id, 72]]],
    );
    t.child.kill('SIGTERM');
    await t.exited();
    const store = await openStore(`${t.dir}/db`);
    try {
      assertEquals(
        (await store.playback.loadQueue(1)).items.map((e) => e.id),
        homeQueue.items.map((e: { entryId: number }) => e.entryId),
      );
      assertEquals(
        (await store.playback.loadQueue(kitchen.id)).items.map((e) => e.id),
        kitchenQueue.items.map((e: { entryId: number }) => e.entryId),
      );
      const players = await store.players.list();
      assertEquals(players.map((p) => p.volume), [62, 72]);
      assertEquals(
        (await t.events()).filter((e) => e.name === 'save-landed').length,
        6,
      );
    } finally {
      await store.close();
    }
  } finally {
    await t.close();
  }
});
