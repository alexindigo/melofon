import { assert, assertEquals } from '@std/assert';
import { cp } from 'node:fs/promises';
import { error, iso } from './helpers/api.ts';
import { freePort, statusFixture } from './helpers/api-status.ts';
import { startServer } from '../src/server.ts';

const base = '/api/v1/server';
Deno.test('API server: signed-in projection, actual remapped listens and live hat warnings', async () => {
  const f = await statusFixture(true);
  try {
    await error(await f.get(base), 401, 'unauthenticated');
    const admin = (await f.login()).credential;
    await f.auth.users.create(f.admin.id, {
      username: 'reader',
      password: 'password-reader',
      role: 'user',
    });
    const reader =
      (await f.login('bearer', 'reader', 'password-reader')).credential;
    const response = await f.get(base, reader, { Origin: f.origin });
    assertEquals(response.status, 200);
    const basic = await response.json();
    assertEquals(Object.keys(basic).sort(), [
      'startedAt',
      'uptimeMs',
      'version',
    ]);
    assertEquals(
      basic.version,
      JSON.parse(await Deno.readTextFile('deno.json')).version,
    );
    iso(basic.startedAt);
    assert(Number.isInteger(basic.uptimeMs) && basic.uptimeMs >= 0);
    const status = await (await f.get(base, admin, { Origin: f.origin }))
      .json();
    assertEquals(status.startedAt, basic.startedAt);
    assert(status.uptimeMs >= basic.uptimeMs);
    assertEquals(status.hats.failed, ['bad']);
    assert(status.hats.active.includes('melofon'));
    assertEquals(status.hats.restartRequired, false);
    assert(
      status.warnings.some((w: { code: string }) => w.code === 'no_library'),
    );
    assertEquals(
      status.warnings.filter((w: { code: string }) => w.code === 'hat_failed')
        .length,
      1,
    );
    for (const port of f.ownPorts) {
      assertEquals(
        status.listens.find((l: { port: number }) => l.port === port),
        { hostname: '0.0.0.0', port, kind: 'extra', hats: ['owntone'] },
      );
    }
    const normal = status.listens.find((l: { kind: string }) =>
      l.kind === 'default'
    );
    assert(normal.hats.includes('melofon') && !normal.hats.includes('owntone'));
    const deactivated = await f.json(
      '/api/v1/admin/hats/owntone/active',
      'PUT',
      { active: false },
      admin,
    );
    assertEquals(deactivated.status, 200);
    await deactivated.text();
    const after = await (await f.get(base, admin)).json();
    assert(after.hats.restartRequired);
    assert(after.hats.active.includes('owntone'));
    assert(
      after.warnings.some((w: { code: string }) =>
        w.code === 'restart_required'
      ),
    );
    assertEquals(
      after.listens.filter((l: { kind: string }) => l.kind === 'extra').length,
      2,
    );
    // The public service reads current roles, not credentials' cached claims.
    const readerId =
      (await f.store.users.credentials({ username: 'reader' }))!.user.id;
    await f.auth.users.update(f.admin.id, readerId, { role: 'admin' });
    assert('listens' in await (await f.get(base, reader)).json());
    await f.auth.users.update(f.admin.id, readerId, { role: 'user' });
    const stillBasic = await (await f.get(base, reader)).json();
    assertEquals(Object.keys(stillBasic).sort(), [
      'startedAt',
      'uptimeMs',
      'version',
    ]);
  } finally {
    await f.close();
  }
});

Deno.test('API server: production composition exposes deno.json version and startup logging through the real facade', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-production-status-' });
  const port = freePort();
  const origin = `http://melofon.home:${port}`;
  const exits: number[] = [];
  const server = await startServer({
    exit: (code) => {
      exits.push(code);
    },
    env: {
      MELOFON_DATA: dir,
      MELOFON_SECRET: 'production-status-secret',
      MELOFON_USER: 'admin',
      MELOFON_PASSWORD: 'production-status-password',
      MELOFON_LISTEN: `0.0.0.0:${port}`,
      MELOFON_LISTEN_owntone: `${freePort()},${freePort()}`,
      MELOFON_AIRPLAY_MDNS: 'off',
    },
  });
  try {
    const login = await fetch(`${origin}/api/v1/session`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'admin',
        password: 'production-status-password',
        use: 'bearer',
      }),
      signal: AbortSignal.timeout(5000),
    });
    assertEquals(login.status, 200);
    const { key } = await login.json();
    const get = (path: string) =>
      fetch(origin + path, {
        headers: { Authorization: `Bearer ${key}`, Origin: origin },
        signal: AbortSignal.timeout(5000),
      });
    const statusResponse = await get(base);
    assertEquals(statusResponse.status, 200);
    const status = await statusResponse.json();
    assertEquals(
      status.version,
      JSON.parse(await Deno.readTextFile('deno.json')).version,
    );
    assertEquals(status.listens.length, 3);
    assert(status.hats.active.includes('melofon'));
    const log = await get('/api/v1/admin/log?component=server');
    assertEquals(log.status, 200);
    const records = (await log.json()).records;
    assertEquals(
      records.filter((r: { event: string }) => r.event === 'listening').length,
      3,
    );
  } finally {
    await server.shutdown();
    assertEquals(exits, [0]);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('API server: no-library, scanning, scan failure and log loss reflect current core state', async () => {
  const f = await statusFixture(true);
  try {
    const admin = (await f.login('bearer')).credential;
    const warnings = async () =>
      (await (await f.get(base, admin)).json()).warnings.map((
        w: { code: string },
      ) => w.code);
    assert((await warnings()).includes('no_library'));
    const music = `${f.dir}/music`;
    await cp('tests/fixtures/library', music, { recursive: true });
    f.hold();
    f.failMedia(true);
    const add = await f.json('/api/v1/admin/libraries', 'POST', {
      name: 'Music',
      path: music,
    }, admin);
    assertEquals(add.status, 201);
    await add.text();
    assert(!(await warnings()).includes('no_library'));
    assert((await warnings()).includes('scanning'));
    f.release();
    await f.scan.start({ ifRunning: true });
    assert((await warnings()).includes('scan_failed'));
    assert(!(await warnings()).includes('scanning'));
    f.failMedia(false);
    await f.scan.run();
    assert(!(await warnings()).includes('scan_failed'));
    f.failSink(true);
    f.logger.event('fixture_info', {});
    f.failSink(false);
    assert((await warnings()).includes('log_dropped'));
  } finally {
    await f.close();
  }
});
