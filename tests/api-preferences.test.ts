import { assert, assertEquals } from '@std/assert';
import { apiFixture, error } from './helpers/api.ts';
import { reservePorts } from './helpers/ports.ts';
import type { Preferences } from '../layers/melofon/types.ts';

const base = '/api/v1/me/preferences';
const defaults = {
  theme: 'system',
  language: null,
  viewMode: 'grid',
  defaultView: null,
  replayGainMode: 'off',
  volume: null,
};
type Fixture = Awaited<ReturnType<typeof apiFixture>>;
async function get(f: Fixture, credential: string): Promise<Preferences> {
  const r = await f.get(base, credential);
  assertEquals(r.status, 200, await r.clone().text());
  return r.json();
}
function change(
  f: Fixture,
  credential: string,
  preferences: unknown,
  revisions?: unknown,
) {
  return f.json(base, 'PATCH', {
    preferences,
    ...(revisions === undefined ? {} : { revisions }),
  }, credential);
}
async function changed(
  f: Fixture,
  credential: string,
  preferences: unknown,
  revisions?: unknown,
): Promise<Preferences> {
  const r = await change(f, credential, preferences, revisions);
  assertEquals(r.status, 200, await r.clone().text());
  return r.json();
}
async function failure(r: Response, code: string, key?: string) {
  const body = await r.json();
  assertEquals(
    r.status,
    code === 'revision_conflict' ? 409 : 400,
    JSON.stringify(body),
  );
  assertEquals(body.code, code);
  assertEquals(typeof body.message, 'string');
  if (key !== undefined) assertEquals(body.key, key);
  return body;
}
async function member(
  f: Fixture,
  name: string,
  role: 'user' | 'admin' = 'user',
) {
  await f.auth.users.create(f.admin.id, {
    username: name,
    password: 'password-member',
    role,
  });
  return f.login('bearer', name, 'password-member');
}

Deno.test('API preferences: defaults, all declared values and per-user isolation without admin access', async () => {
  const f = await apiFixture();
  try {
    const a = await member(f, 'alice');
    const b = await member(f, 'bob');
    const admin = await f.login();
    const initial = await get(f, a.credential);
    assertEquals(initial, {
      preferences: defaults,
      defaults,
      revisions: Object.fromEntries(
        Object.keys(defaults).map((key) => [key, 0]),
      ),
    });
    const values = {
      theme: 'dark',
      language: 'zh-Hant-TW',
      viewMode: 'list',
      defaultView: 'favourites',
      replayGainMode: 'album',
      volume: 0,
    };
    const result = await changed(f, a.credential, values);
    assertEquals(result.preferences, values);
    assertEquals(result.defaults, defaults);
    assertEquals(
      result.revisions,
      Object.fromEntries(Object.keys(defaults).map((key) => [key, 1])),
    );
    assertEquals(await get(f, a.credential), result);
    assertEquals(await get(f, b.credential), initial);
    assertEquals(await get(f, admin.credential), initial);
    const bResult = await changed(f, b.credential, {
      theme: 'light',
      volume: 100,
    });
    assertEquals(bResult.preferences.theme, 'light');
    assertEquals(bResult.preferences.volume, 100);
    assertEquals(await get(f, a.credential), result);
    // No target parameter: even an admin cannot select somebody else's preferences.
    await error(
      await f.json(base, 'PATCH', {
        userId: 'alice',
        preferences: { theme: 'light' },
      }, admin.credential),
      400,
      'unknown_field',
    );
    for (
      const path of [
        '/api/v1/admin/users/alice/preferences',
        '/api/v1/me/preferences/alice',
      ]
    ) {
      await error(await f.get(path, admin.credential), 404, 'not_found');
    }
  } finally {
    await f.close();
  }
});

Deno.test('API preferences: inherited authentication, cookie/Bearer Origin and strict body validation', async () => {
  const f = await apiFixture();
  try {
    await error(await f.get(base), 401, 'unauthenticated');
    await error(
      await f.json(base, 'PATCH', { preferences: { theme: 'dark' } }),
      401,
      'unauthenticated',
    );
    const cookie = await f.login();
    const bearer = await f.login('bearer');
    for (const login of [cookie, bearer]) {
      for (const origin of ['null', 'http://foreign.home']) {
        await error(
          await f.json(
            base,
            'PATCH',
            { preferences: { theme: 'dark' } },
            login.credential,
            origin,
          ),
          403,
          'origin',
        );
      }
    }
    await error(
      await f.json(base, 'PATCH', { preferences: {} }, cookie.credential, null),
      403,
      'origin',
    );
    const response = await f.json(
      base,
      'PATCH',
      { preferences: { theme: 'light' } },
      bearer.credential,
      null,
    );
    assertEquals(response.status, 200);
    await response.json();
    const before = await get(f, cookie.credential);
    for (
      const body of [
        {},
        { preferences: null },
        { preferences: [] },
        { preferences: 'theme' },
        { preferences: {}, revisions: null },
        { preferences: {}, revisions: [] },
      ]
    ) {
      await failure(
        await f.json(base, 'PATCH', body, cookie.credential),
        'invalid_value',
      );
    }
    for (
      const revisions of [{ theme: -1 }, { theme: 0.5 }, { theme: '0' }, {
        theme: null,
      }, { volume: 0 }]
    ) {
      await failure(
        await change(f, cookie.credential, { theme: 'dark' }, revisions),
        'invalid_value',
      );
    }
    await error(
      await f.request(base, {
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
    assertEquals(await changed(f, cookie.credential, {}), before);
    assertEquals(await get(f, cookie.credential), before);
  } finally {
    await f.close();
  }
});

Deno.test('API preferences: shared schema validation and unknown keys reject the entire batch', async () => {
  const f = await apiFixture();
  try {
    const { credential } = await f.login();
    const before = await get(f, credential);
    const events: unknown[] = [];
    f.notify.subscribe((names, ids, audience) => {
      if (names.includes('preferences')) events.push({ ids, audience });
    });
    for (
      const [key, value] of [
        ['theme', 'blue'],
        ['theme', 1],
        ['language', 'en_US'],
        ['language', ''],
        ['language', 'a'.repeat(36)],
        ['viewMode', 'tiles'],
        ['defaultView', 'x'.repeat(65)],
        ['defaultView', {}],
        ['replayGainMode', 'auto'],
        ['volume', -1],
        ['volume', 101],
        ['volume', 1.5],
        ['volume', '50'],
        ['volume', true],
      ] as const
    ) {
      await failure(
        await change(f, credential, {
          'ui.valid': ['not committed'],
          [key]: value,
        }),
        'invalid_value',
        key,
      );
      assertEquals(await get(f, credential), before);
    }
    for (
      const key of [
        'speakerId',
        'unknown',
        'ui.',
        'ui.bad/name',
        `ui.${'x'.repeat(65)}`,
        '__proto__',
        'constructor',
      ]
    ) {
      await failure(
        await change(
          f,
          credential,
          Object.fromEntries([['theme', 'dark'], [key, null]]),
        ),
        'unknown_preference',
        key,
      );
      assertEquals(await get(f, credential), before);
    }
    assertEquals(events, []);
    const accepted = await changed(f, credential, {
      defaultView: 'x'.repeat(64),
      language: 'en',
      replayGainMode: 'track',
      volume: 50,
    });
    assertEquals(accepted.preferences.defaultView, 'x'.repeat(64));
    assertEquals(accepted.preferences.language, 'en');
    assertEquals(accepted.preferences.replayGainMode, 'track');
    assertEquals(accepted.preferences.volume, 50);
  } finally {
    await f.close();
  }
});

Deno.test('API preferences: arbitrary UI JSON, exact aggregate UTF-8 cap, atomic concurrent quota and reset frees space', async () => {
  const f = await apiFixture();
  try {
    const a = await f.login();
    const b = await member(f, 'bob');
    const arbitrary = {
      'ui.object': {
        nested: [1, true, false, null, { title: '雪', text: '"\\\n' }],
      },
      'ui.array': [1, 'x'],
      'ui.bool': false,
      'ui.number': 1.5,
      [`ui.${'x'.repeat(64)}`]: {},
    };
    const first = await changed(f, a.credential, arbitrary);
    for (const [key, value] of Object.entries(arbitrary)) {
      assertEquals(first.preferences[key], value);
    }
    await changed(
      f,
      a.credential,
      Object.fromEntries(Object.keys(arbitrary).map((key) => [key, null])),
    );
    // {"ui.a":"..."} has 11 bytes of syntax; multibyte strings count as UTF-8.
    const half = 'é'.repeat(16000);
    await changed(f, a.credential, { 'ui.a': half });
    const exact = await changed(f, a.credential, { 'ui.b': 'x'.repeat(33515) });
    assertEquals(
      new TextEncoder().encode(
        JSON.stringify({ 'ui.a': half, 'ui.b': exact.preferences['ui.b'] }),
      ).byteLength,
      65536,
    );
    await failure(
      await change(f, a.credential, {
        'ui.b': 'x'.repeat(33516),
        theme: 'dark',
      }),
      'too_large',
    );
    assertEquals(await get(f, a.credential), exact);
    assertEquals((await get(f, b.credential)).preferences, defaults);
    assertEquals(
      (await changed(f, b.credential, { 'ui.own': 'y'.repeat(40000) }))
        .preferences['ui.own'],
      'y'.repeat(40000),
    );
    const reset = await changed(f, a.credential, { 'ui.a': null });
    assert(!Object.hasOwn(reset.preferences, 'ui.a'));
    assertEquals(reset.revisions['ui.a'], 2);
    await changed(f, a.credential, { 'ui.b': null });
    const results = await Promise.all(
      ['ui.c', 'ui.d'].map((key) =>
        change(f, a.credential, { [key]: 'z'.repeat(40000) })
      ),
    );
    assertEquals(results.map((r) => r.status).sort(), [200, 400]);
    for (const r of results) {
      if (r.status === 400) await failure(r, 'too_large');
      else await r.json();
    }
    const after = await get(f, a.credential);
    assertEquals(
      ['ui.c', 'ui.d'].filter((key) => Object.hasOwn(after.preferences, key))
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});

Deno.test('API preferences: two-device revisions, all-or-nothing conflict and reset tombstones prevent ABA', async () => {
  const f = await apiFixture();
  try {
    const a = await f.login();
    const b = await f.login('bearer');
    const responses = await Promise.all(
      [a, b].map((login, index) =>
        change(f, login.credential, { theme: index ? 'dark' : 'light' }, {
          theme: 0,
        })
      ),
    );
    assertEquals(responses.map((r) => r.status).sort(), [200, 409]);
    for (const r of responses) {
      if (r.status === 409) {
        assertEquals((await failure(r, 'revision_conflict')).revisions, {
          theme: 1,
        });
      } else await r.json();
    }
    const before = await get(f, a.credential);
    const conflict = await failure(
      await change(f, b.credential, { theme: 'system', volume: 22 }, {
        theme: 0,
        volume: 0,
      }),
      'revision_conflict',
    );
    assertEquals(conflict.revisions, { theme: 1, volume: 0 });
    assertEquals(await get(f, a.credential), before);
    const reset = await changed(
      f,
      b.credential,
      { theme: null, volume: null },
      { theme: 1, volume: 0 },
    );
    assertEquals(reset.preferences, defaults);
    assertEquals(reset.revisions.theme, 2);
    assertEquals(reset.revisions.volume, 1);
    await failure(
      await change(f, a.credential, { theme: 'dark' }, { theme: 0 }),
      'revision_conflict',
    );
    await failure(
      await change(f, a.credential, { theme: 'dark' }, { theme: 1 }),
      'revision_conflict',
    );
    assertEquals(
      (await changed(f, a.credential, { theme: null }, { theme: 2 })).revisions
        .theme,
      3,
    );
    const ui = await changed(f, a.credential, {
      'ui.deleted': { state: 'before reset' },
    });
    assertEquals(ui.revisions['ui.deleted'], 1);
    const deleted = await changed(f, a.credential, { 'ui.deleted': null }, {
      'ui.deleted': 1,
    });
    assert(!Object.hasOwn(deleted.preferences, 'ui.deleted'));
    assertEquals(deleted.revisions['ui.deleted'], 2);
    await failure(
      await change(f, b.credential, { 'ui.deleted': false }, {
        'ui.deleted': 0,
      }),
      'revision_conflict',
    );
  } finally {
    await f.close();
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert(Date.now() < deadline, 'socket outcome timed out');
    await sleep(10);
  }
}
function socket(f: Fixture, credential: string) {
  const headers = new Headers(
    credential.startsWith('melofon_session=')
      ? { Cookie: credential }
      : { Authorization: `Bearer ${credential}` },
  );
  headers.set('Origin', f.origin);
  const ws = new WebSocket(
    `${f.origin.replace('http:', 'ws:')}/api/v1/events`,
    { headers },
  );
  const frames: { type: string; events?: Record<string, string[]> }[] = [];
  ws.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
  return {
    frames,
    async ready() {
      await until(() => frames.length > 0);
      assertEquals(frames.shift()!.type, 'hello');
    },
    async close() {
      if (ws.readyState < WebSocket.CLOSING) ws.close();
      await until(() => ws.readyState === WebSocket.CLOSED);
    },
  };
}

Deno.test('API preferences: real cookie/Bearer device sockets refetch private changes; another user and admin receive nothing', async () => {
  const f = await apiFixture();
  const sockets: ReturnType<typeof socket>[] = [];
  try {
    const a = await member(f, 'alice');
    const a2 = await f.login(
      'cookie',
      'alice',
      'password-member',
      'Second device',
    );
    const b = await member(f, 'bob');
    const admin = await f.login();
    for (const login of [a, a2, b, admin]) {
      const s = socket(f, login.credential);
      sockets.push(s);
      await s.ready();
    }
    const result = await changed(f, a.credential, {
      theme: 'dark',
      'ui.layout': { columns: 3 },
    });
    await until(() =>
      sockets[0].frames.length > 0 && sockets[1].frames.length > 0
    );
    for (const s of sockets.slice(0, 2)) {
      assertEquals(s.frames.shift(), {
        type: 'changed',
        events: { preferences: ['theme', 'ui.layout'] },
      });
    }
    assertEquals(await get(f, a2.credential), result);
    // A subsequent private event is a same-connection processing barrier.
    await changed(f, b.credential, { viewMode: 'list' });
    await until(() => sockets[2].frames.length > 0);
    assertEquals(sockets[2].frames.shift(), {
      type: 'changed',
      events: { preferences: ['viewMode'] },
    });
    // @ts-expect-error The required audience is also enforced at type-check time.
    f.notify.emit(['preferences'], { preferences: ['unscoped-must-not-leak'] });
    await failure(
      await change(f, a.credential, { theme: 'light' }, { theme: 0 }),
      'revision_conflict',
    );
    await failure(
      await change(f, a.credential, { volume: 101 }),
      'invalid_value',
      'volume',
    );
    await changed(f, a.credential, {});
    await sleep(150);
    for (const s of sockets) assertEquals(s.frames, []);
    assertEquals(
      (await get(f, b.credential)).preferences['ui.layout'],
      undefined,
    );
    const reset = await changed(f, a2.credential, {
      theme: null,
      'ui.layout': null,
    });
    await until(() =>
      sockets[0].frames.length > 0 && sockets[1].frames.length > 0
    );
    assertEquals(await get(f, a.credential), reset);
    assertEquals(reset.preferences, defaults);
    assertEquals(sockets[2].frames, []);
    assertEquals(sockets[3].frames, []);
  } finally {
    for (const s of sockets) await s.close();
    await f.close();
  }
});

// This case starts the real production composition twice, not a reopened mock
// service. Existing server-smoke provides the child lifecycle precedent.
async function boot(dataDir: string) {
  using reserved = reservePorts(3);
  const [port, own, ws] = reserved.ports;
  const env: Record<string, string> = {};
  for (
    const key of ['HOME', 'PATH', 'DENO_DIR', 'TMPDIR', 'MELOFON_RAOP_LIB']
  ) {
    const value = Deno.env.get(key);
    if (value !== undefined) env[key] = value;
  }
  const origin = `http://melofon.home:${port}`;
  Object.assign(env, {
    MELOFON_DATA: dataDir,
    MELOFON_USER: 'admin',
    MELOFON_PASSWORD: 'password-admin',
    MELOFON_SECRET: 'preferences-restart-secret',
    MELOFON_LISTEN: `0.0.0.0:${port}`,
    MELOFON_LISTEN_owntone: `${own},${ws}`,
    MELOFON_AIRPLAY_MDNS: 'off',
  });
  reserved.release();
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--frozen',
      '--cached-only',
      '--node-modules-dir=manual',
      '--allow-net',
      '--allow-env',
      '--allow-read',
      '--allow-write',
      '--allow-ffi',
      '--allow-sys',
      'main.ts',
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
  async function stop() {
    try {
      child.kill('SIGTERM');
    } catch { /* Already exited. */ }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exited = await Promise.race([
        child.status.then(() => true),
        new Promise<boolean>((r) => {
          timer = setTimeout(() => r(false), 10000);
        }),
      ]);
      if (!exited) {
        try {
          child.kill('SIGKILL');
        } catch { /* Already exited. */ }
      }
      await child.status;
      await logs;
    } finally {
      clearTimeout(timer);
    }
  }
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(5000) });
  try {
    const deadline = Date.now() + 30000;
    for (;;) {
      try {
        const r = await request('/_/health');
        if ((await r.json()).ok) break;
      } catch { /* Boot in progress. */ }
      assert(Date.now() < deadline, 'production server did not start');
      await sleep(100);
    }
    return { origin, request, stop };
  } catch (error) {
    await stop();
    throw new Error(`${error}\n${(await logs).join('\n')}`);
  }
}

Deno.test('API preferences: values, defaults, per-key revisions and reset survive a real server restart', async () => {
  const dir = await Deno.makeTempDir({
    prefix: 'melofon-preferences-restart-',
  });
  let server: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    server = await boot(dir);
    const login = await server.request('/api/v1/session', {
      method: 'POST',
      headers: { Origin: server.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'admin',
        password: 'password-admin',
        use: 'bearer',
      }),
    });
    assertEquals(login.status, 200);
    const { key } = await login.json();
    const write = async (preferences: unknown) => {
      const r = await server!.request(base, {
        method: 'PATCH',
        headers: {
          Origin: server!.origin,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ preferences }),
      });
      assertEquals(r.status, 200, await r.clone().text());
      return r.json();
    };
    await write({
      theme: 'dark',
      language: 'pt-BR',
      volume: 45,
      'ui.layout': { columns: [1, 3], collapsed: false },
    });
    const before = await write({ volume: null });
    assertEquals(before.revisions.volume, 2);
    await server.stop();
    server = await boot(dir);
    const r = await server.request(base, {
      headers: { Authorization: `Bearer ${key}`, Origin: server.origin },
    });
    assertEquals(r.status, 200);
    assertEquals(await r.json(), before);
    const reset = await write({ theme: null });
    assertEquals(reset.preferences.theme, 'system');
    assertEquals(reset.revisions.theme, 2);
    assertEquals(reset.preferences['ui.layout'], {
      columns: [1, 3],
      collapsed: false,
    });
  } finally {
    await server?.stop();
    await Deno.remove(dir, { recursive: true });
  }
});
