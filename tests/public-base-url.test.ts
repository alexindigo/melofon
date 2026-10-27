import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { startServer } from '../src/server.ts';
import { createLogger } from '../src/logging.ts';
import { reservePorts } from './helpers/ports.ts';

const settings = '/api/v1/admin/settings';
const auth = new URLSearchParams({
  u: 'admin',
  p: 'prefix-password',
  v: '1.16.1',
  c: 'base-url',
  f: 'json',
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function boot(dataDir: string, extra: Record<string, string> = {}) {
  using reserved = reservePorts(3);
  const [port, own, ws] = reserved.ports;
  const lines: string[] = [];
  const log = createLogger({
    sinks: {
      stdout: (line) => {
        lines.push(line);
      },
      stderr: (line) => {
        lines.push(line);
      },
    },
  });
  const exits: number[] = [];
  reserved.release();
  const server = await startServer({
    env: {
      MELOFON_DATA: dataDir,
      MELOFON_SECRET: 'base-url-secret',
      MELOFON_USER: 'admin',
      MELOFON_PASSWORD: 'prefix-password',
      MELOFON_LISTEN: `0.0.0.0:${port}`,
      MELOFON_LISTEN_owntone: `${own},${ws}`,
      MELOFON_AIRPLAY_MDNS: 'off',
      ...extra,
    },
    setupLog: log,
    exit: (code) => {
      exits.push(code);
    },
  });
  await log.flush();
  const origin = `http://melofon.home:${port}`;
  const request = (path: string, init: RequestInit = {}, base = origin) =>
    fetch(`${base}${path}`, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
  const json = (path: string, method: string, body: unknown, cookie = '') =>
    request(path, {
      method,
      headers: {
        Origin: origin,
        Cookie: cookie,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const login = async (prefix: string) => {
    const response = await json(`${prefix}/api/v1/session`, 'POST', {
      username: 'admin',
      password: 'prefix-password',
      use: 'cookie',
    });
    assertEquals(response.status, 200, await response.clone().text());
    await response.json();
    const header = response.headers.get('set-cookie')!;
    return { header, cookie: header.split(';')[0] };
  };
  const change = async (prefix: string, cookie: string, value: unknown) => {
    const response = await json(`${prefix}${settings}`, 'PATCH', {
      changes: [{ key: 'server.baseUrl', value }],
    }, cookie);
    assertEquals(response.status, 200, await response.clone().text());
    return response.json();
  };
  const rest = async (
    prefix: string,
    op: string,
    fields: Record<string, string> = {},
  ) => {
    const query = new URLSearchParams(auth);
    for (const [key, value] of Object.entries(fields)) query.set(key, value);
    const response = await request(`${prefix}/rest/${op}?${query}`);
    assertEquals(response.status, 200);
    const body = (await response.json())['subsonic-response'];
    assertEquals(body.status, 'ok', JSON.stringify(body));
    return body;
  };
  return {
    server,
    origin,
    own,
    ws,
    lines,
    exits,
    request,
    json,
    login,
    change,
    rest,
    close: () => server.shutdown(),
  };
}

async function temp(run: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-base-url-' });
  try {
    await run(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}
async function missing(response: Response) {
  assertEquals(response.status, 404);
  assertEquals(await response.json(), { detail: 'Not Found' });
}

Deno.test('base URL: real default listen strips once before mounts, aliases, core and hello; own ports stay at root', () =>
  temp(async (dir) => {
    const f = await boot(dir, { MELOFON_BASE_URL: '/music' });
    try {
      const redirect = await f.request('/');
      assertEquals(redirect.status, 302);
      assertEquals(redirect.headers.get('location'), '/music/');
      await redirect.body?.cancel();
      for (const path of ['/music', '/music/']) {
        assertEquals(await (await f.request(path)).text(), 'Hello World!\n');
      }
      for (const path of ['/_/health', '/music/_/health']) {
        const response = await f.request(path, {
          headers: { Forwarded: 'for=127.0.0.1' },
        });
        assertEquals(response.status, 200);
        assertEquals(await response.json(), { ok: true });
      }
      for (const prefix of ['/music', '/music/_opensubsonic']) {
        await f.rest(prefix, 'ping.view');
      }
      for (
        const path of [
          '/rest/ping.view',
          '/api/v1/me',
          '/share/bad',
          '/_/config',
          '/_/_status',
          '/_melofon/api/v1/me',
          '/musicish/rest/ping.view',
          '/music/music/rest/ping.view',
          '/music/_/config',
        ]
      ) await missing(await f.request(path));
      await missing(await f.request('/', { method: 'POST' }));
      const signed = await f.login('/music');
      assertStringIncludes(signed.header, '; Path=/music;');
      const me = await f.request('/music/_melofon/api/v1/me', {
        headers: { Cookie: signed.cookie },
      });
      assertEquals(me.status, 200);
      assertEquals((await me.json()).username, 'admin');
      const local = f.origin.replace('melofon.home', '127.0.0.1');
      const config = await f.request('/music/_/config', {}, local);
      assertEquals(config.status, 200);
      assertEquals((await config.json()).config['server.baseUrl'], '/music');
      for (
        const header of [
          'X-Forwarded-For',
          'X-Forwarded-Host',
          'X-Forwarded-Proto',
          'X-Real-IP',
          'Forwarded',
        ]
      ) {
        await missing(
          await f.request(
            '/music/_/config',
            { headers: { [header]: '' } },
            local,
          ),
        );
        await missing(
          await f.request('/music/_melofon/api/v1/_status', {
            headers: { [header]: '' },
          }, local),
        );
      }
      const own = `http://melofon.home:${f.own}`;
      const configOwn = await f.request('/api/config', {}, own);
      assertEquals(configOwn.status, 200);
      assert((await configOwn.json()).version);
      await missing(await f.request('/music/api/config', {}, own));
    } finally {
      await f.close();
    }
  }));

Deno.test('base URL: cookie sign-in, sign-out and live prefix changes keep one server and existing sessions', () =>
  temp(async (dir) => {
    const f = await boot(dir, { MELOFON_BASE_URL: '/music/' });
    try {
      const signed = await f.login('/music');
      assertStringIncludes(signed.header, '; Path=/music;');
      const before = await f.json(
        '/music/api/v1/server',
        'GET',
        undefined,
        signed.cookie,
      );
      assertEquals(before.status, 200);
      const status = await before.json();
      await f.change(
        '/music',
        signed.cookie,
        'https://myhome.example/records/',
      );
      await missing(
        await f.request('/music/api/v1/me', {
          headers: { Cookie: signed.cookie },
        }),
      );
      const me = await f.request('/records/api/v1/me', {
        headers: { Cookie: signed.cookie },
      });
      assertEquals((await me.json()).username, 'admin');
      const after = await f.json(
        '/records/api/v1/server',
        'GET',
        undefined,
        signed.cookie,
      );
      const movedStatus = await after.json();
      assertEquals(movedStatus.startedAt, status.startedAt);
      assertEquals(movedStatus.listens, status.listens);
      assert(movedStatus.uptimeMs >= status.uptimeMs);
      await f.rest('/records', 'ping.view');
      const redirect = await f.request('/');
      assertEquals(redirect.headers.get('location'), '/records/');
      await redirect.body?.cancel();
      const moved = await f.login('/records');
      assertStringIncludes(moved.header, '; Path=/records;');
      const logout = await f.json(
        '/records/api/v1/session',
        'DELETE',
        undefined,
        moved.cookie,
      );
      assertEquals(logout.status, 200);
      assertStringIncludes(
        logout.headers.get('set-cookie')!,
        '; Path=/records;',
      );
      assertStringIncludes(logout.headers.get('set-cookie')!, 'Max-Age=0');
      await logout.json();
      await f.change('/records', signed.cookie, '');
      await f.rest('', 'ping.view');
      await missing(await f.request('/records/rest/ping.view'));
      assertStringIncludes((await f.login('')).header, '; Path=/;');
      assertEquals(f.exits, []);
    } finally {
      await f.close();
    }
  }));

Deno.test('base URL: settings API rejects malformed values atomically and accepts normalized path/full URL forms', () =>
  temp(async (dir) => {
    const f = await boot(dir);
    try {
      const signed = await f.login('');
      for (
        const value of [
          '/',
          '//music',
          'music',
          '/_private',
          '/_/health',
          '/music?x=1',
          '/music#x',
          'ftp://example.com/music',
          'https:///music',
          'http://',
          'https://user:pass@example.com/music',
          'https://example.com/_private',
          'https://example.com/music?x=1',
          'https://example.com/music#x',
          'https://example.com:99999/music',
          'https://999.999.999.999/music',
          '/music/../other',
          '/music/%2e%2E/other',
          '/music\\other',
          '/music;Secure',
          '/music\n',
          '/music\x00',
          'http://999.999.999.999./music',
          'http://[1:2:3:4:5:6:7:8:9]/music',
          'http://0x100000000/music',
          'http://example.0x100000000/music',
          'http://example.0x1/music',
          '/music%',
          null,
          7,
        ]
      ) {
        const response = await f.json(settings, 'PATCH', {
          changes: [{ key: 'server.baseUrl', value }],
        }, signed.cookie);
        assertEquals(response.status, 400, JSON.stringify(value));
        const body = await response.json();
        assertEquals([body.code, body.key], [
          'invalid_value',
          'server.baseUrl',
        ]);
        await f.rest('', 'ping.view');
      }
      let prefix = '';
      for (
        const [value, next] of [
          ['/music/', '/music'],
          ['/house/music', '/house/music'],
          ['http://melofon.home:8000/library/', '/library'],
          ['https://myhome.example/music', '/music'],
          ['http://192.0.2.1/music', '/music'],
          ['http://[::1]/music', '/music'],
          ['HTTP://MELOFON.HOME/music/', '/music'],
          ['http://[::ffff:192.0.2.1]:65535/music', '/music'],
          ['https://myhome.example', ''],
          ['https://myhome.example/', ''],
        ]
      ) {
        await f.change(prefix, signed.cookie, value);
        prefix = next;
        await f.rest(prefix, 'ping.view');
      }
      const response = await f.json(
        `${settings}/server.baseUrl`,
        'GET',
        undefined,
        signed.cookie,
      );
      const item = await response.json();
      assertEquals([item.owner, item.default, item.value, item.source], [
        'core',
        '',
        'https://myhome.example/',
        'stored',
      ]);
      assertEquals(typeof item.schema.pattern, 'string');
    } finally {
      await f.close();
    }
  }));

Deno.test('base URL: first-boot env seed persists and never overwrites an operator value, including empty', () =>
  temp(async (dir) => {
    const first = await boot(dir, { MELOFON_BASE_URL: '/music' });
    try {
      await first.rest('/music', 'ping.view');
      const signed = await first.login('/music');
      await first.change('/music', signed.cookie, '/stored');
    } finally {
      await first.close();
    }
    const second = await boot(dir, { MELOFON_BASE_URL: '/replacement' });
    try {
      await second.rest('/stored', 'ping.view');
      await missing(await second.request('/replacement/rest/ping.view'));
      const signed = await second.login('/stored');
      await second.change('/stored', signed.cookie, '');
    } finally {
      await second.close();
    }
    const third = await boot(dir, { MELOFON_BASE_URL: '/replacement' });
    try {
      await third.rest('', 'ping.view');
      const signed = await third.login('');
      const response = await third.json(
        `${settings}/server.baseUrl`,
        'GET',
        undefined,
        signed.cookie,
      );
      const item = await response.json();
      assertEquals([item.value, item.source], ['', 'stored']);
    } finally {
      await third.close();
    }
  }));

Deno.test('base URL: a real shared track page and audio stream serve through the prefixed share mount', () =>
  temp(async (dir) => {
    const f = await boot(dir, { MELOFON_BASE_URL: '/music' });
    try {
      const signed = await f.login('/music');
      const added = await f.json('/music/api/v1/admin/libraries', 'POST', {
        name: 'Fixture',
        path: await Deno.realPath('tests/fixtures/library'),
      }, signed.cookie);
      assertEquals(added.status, 201);
      await added.json();
      let songs;
      const until = Date.now() + 30000;
      do {
        songs = (await f.rest('/music', 'getRandomSongs')).randomSongs.song;
        if (songs?.length) break;
        assert(Date.now() < until, 'fixture scan timed out');
        await sleep(50);
      } while (true);
      const enabled = await f.json(`/music${settings}`, 'PATCH', {
        changes: [{ key: 'sharing.enabled', value: true }],
      }, signed.cookie);
      assertEquals(enabled.status, 200);
      await enabled.json();
      const created = await f.rest('/music', 'createShare', {
        id: songs[0].id,
        description: 'Prefixed music',
      });
      const id = created.shares.share[0].id;
      const page = await f.request(`/music/share/${id}`);
      assertEquals(page.status, 200);
      assertStringIncludes(await page.text(), 'Prefixed music');
      const stream = await f.request(`/music/share/${id}/0`);
      assertEquals(stream.status, 200);
      assert((await stream.arrayBuffer()).byteLength > 0);
      await missing(await f.request(`/share/${id}`));
    } finally {
      await f.close();
    }
  }));

Deno.test('base URL: setup is reachable under the seeded prefix and survives the setup restart', () =>
  temp(async (dir) => {
    const f = await boot(dir, {
      MELOFON_USER: '',
      MELOFON_PASSWORD: '',
      MELOFON_BASE_URL: '/music',
    });
    try {
      assert(f.server.setupMode);
      const probe = await f.request('/music/setup');
      assertEquals(probe.status, 200);
      assertEquals(await probe.json(), { setupRequired: true });
      await missing(await f.request('/setup'));
      const code = f.lines.find((line) => line.includes('event=setup_code '))
        ?.match(/\bcode=([A-Z2-9-]+)/)?.[1];
      assert(code);
      const response = await f.json('/music/setup', 'POST', {
        code,
        username: 'admin',
        password: 'prefix-password',
      });
      assertEquals(response.status, 201);
      assertEquals((await response.json()).restarting, true);
      const until = Date.now() + 5000;
      while (!f.exits.length) {
        assert(Date.now() < until);
        await sleep(10);
      }
      assertEquals(f.exits, [75]);
    } finally {
      await f.close();
    }
    const normal = await boot(dir);
    try {
      assertEquals(normal.server.setupMode, false);
      assertStringIncludes(
        (await normal.login('/music')).header,
        '; Path=/music;',
      );
      await normal.rest('/music', 'ping.view');
    } finally {
      await normal.close();
    }
  }));

Deno.test('base URL: WebSocket upgrades keep their transport through the prefix and forced mount, and receive live changes', () =>
  temp(async (dir) => {
    const f = await boot(dir, { MELOFON_BASE_URL: '/music' });
    let socket: WebSocket | undefined;
    try {
      const signed = await f.login('/music');
      let prefix = '/music';
      for (const alias of ['', '/_melofon']) {
        const frames: { type: string; events?: Record<string, string[]> }[] =
          [];
        socket = new WebSocket(
          `${f.origin.replace('http:', 'ws:')}${prefix}${alias}/api/v1/events`,
          {
            headers: { Origin: f.origin, Cookie: signed.cookie },
          },
        );
        socket.onmessage = (event) =>
          frames.push(JSON.parse(String(event.data)));
        const until = Date.now() + 5000;
        while (!frames.length) {
          assert(Date.now() < until, 'WebSocket hello timeout');
          await sleep(10);
        }
        assertEquals(frames.shift()!.type, 'hello');
        const next = prefix === '/music' ? '/records' : '/music';
        await f.change(prefix, signed.cookie, next);
        while (
          !frames.some((frame) =>
            frame.events?.settings?.includes('server.baseUrl')
          )
        ) {
          assert(Date.now() < until, 'WebSocket setting event timeout');
          await sleep(10);
        }
        assertEquals(socket.readyState, WebSocket.OPEN);
        socket.close();
        while (socket.readyState !== WebSocket.CLOSED) {
          assert(Date.now() < until);
          await sleep(10);
        }
        prefix = next;
        const me = await f.request(`${prefix}/api/v1/me`, {
          headers: { Cookie: signed.cookie },
        });
        assertEquals((await me.json()).username, 'admin');
      }
    } finally {
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
      await f.close();
    }
  }));
