import { assert, assertEquals, assertRejects } from '@std/assert';
import { startServer } from '../src/server.ts';
import { createLogger } from '../src/logging.ts';
import { createTermination } from '../src/restart.ts';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { createAuthentication } from '../src/authentication.ts';
import { createState } from '../src/state.ts';
import { reservePorts } from './helpers/ports.ts';

async function boot(dataDir: string, extra: Record<string, string> = {}) {
  using reserved = reservePorts(3);
  const [port, own, ws] = reserved.ports;
  const env = {
    MELOFON_DATA: dataDir,
    MELOFON_SECRET: 'setup-test-secret',
    MELOFON_LISTEN: `0.0.0.0:${port}`,
    MELOFON_LISTEN_owntone: `${own},${ws}`,
    MELOFON_AIRPLAY_MDNS: 'off',
    ...extra,
  };
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
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  reserved.release();
  const server = await startServer({
    env,
    setupLog: log,
    exit(code) {
      exits.push(code);
      resolveExit(code);
    },
  });
  await log.flush();
  const origin = `http://melofon.home:${port}`;
  const replies: string[] = [];
  const request = async (
    path: string,
    init: RequestInit = {},
    base = origin,
  ) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      signal: AbortSignal.timeout(5000),
    });
    const raw = await response.text();
    replies.push(raw, JSON.stringify([...response.headers]));
    return {
      status: response.status,
      headers: response.headers,
      raw,
      body: raw.startsWith('{') ? JSON.parse(raw) : undefined,
    };
  };
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    request('/setup', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: origin,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const codeLines = lines.filter((line) => line.includes('event=setup_code '));
  const code = codeLines[0]?.match(/\bcode=([A-Z2-9-]+)/)?.[1];
  return {
    server,
    env,
    origin,
    own,
    ws,
    exits,
    exited,
    lines,
    codeLines,
    code,
    replies,
    request,
    post,
    close: () => server.shutdown(),
  };
}

async function temp(run: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-setup-' });
  try {
    await run(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('setup: only setup hats serve, log-only code, completed response then exit 75 and normal restart', () =>
  temp(async (dir) => {
    const first = await boot(dir);
    try {
      assert(first.server.setupMode);
      assertEquals(first.codeLines.length, 1);
      assert(
        first.code &&
          /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){2}$/.test(first.code),
        first.lines.join(''),
      );
      assertEquals(
        first.server.hats.list().filter((h) => h.state === 'active').map((h) =>
          h.name
        ),
        ['setup'],
      );
      assert(
        first.server.hats.list().filter((h) => !h.setup).every((h) =>
          h.state === 'found'
        ),
      );
      assertEquals((await first.request('/setup')).body, {
        setupRequired: true,
      });
      for (
        const path of [
          '/',
          '/rest/ping',
          '/api/v1/me',
          '/_melofon/api/v1/me',
          '/_/config',
        ]
      ) assertEquals((await first.request(path)).status, 404, path);
      assertEquals((await first.request('/_/health')).body, { ok: true });
      for (const port of [first.own, first.ws]) {
        await assertRejects(() =>
          fetch(`http://melofon.home:${port}/api/config`, {
            signal: AbortSignal.timeout(1000),
          })
        );
      }
      const short = await first.post({
        code: first.code,
        username: 'new-admin',
        password: 'short',
      });
      assertEquals([short.status, short.body.code], [
        400,
        'password_too_short',
      ]);
      const result = await first.post({
        code: first.code,
        username: 'new-admin',
        password: 'new-admin-password',
        displayName: 'First Admin',
      });
      assertEquals(result.status, 201);
      assertEquals(result.body.restarting, true);
      assertEquals([
        result.body.user.username,
        result.body.user.displayName,
        result.body.user.role,
      ], ['new-admin', 'First Admin', 'admin']);
      assert(!result.raw.includes('password'));
      assert(
        first.replies.every((reply) => !reply.includes(first.code!)),
        'code must never be in a response',
      );
      assertEquals(await first.exited, 75);
      assertEquals(first.exits, [75]);
    } finally {
      await first.close();
    }
    const second = await boot(dir);
    try {
      assertEquals(second.server.setupMode, false);
      assertEquals(second.codeLines.length, 0);
      assertEquals(
        second.server.hats.list().find((h) => h.name === 'setup')?.state,
        'found',
      );
      assertEquals((await second.request('/setup')).status, 404);
      const signed = await second.request('/api/v1/session', {
        method: 'POST',
        headers: { Origin: second.origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'new-admin',
          password: 'new-admin-password',
          use: 'bearer',
        }),
      });
      assertEquals(signed.status, 200);
      assertEquals(
        (await second.request('/api/v1/me', {
          headers: { Authorization: `Bearer ${signed.body.key}` },
        })).body.role,
        'admin',
      );
      assertEquals(
        (await second.request('/rest/getOpenSubsonicExtensions?f=json'))
          .body['subsonic-response'].status,
        'ok',
      );
      assertEquals(
        (await second.request(
          '/api/config',
          {},
          `http://melofon.home:${second.own}`,
        )).status,
        200,
      );
      assertEquals(
        (await second.request('/share/bad')).raw,
        'Share not found\n',
      );
    } finally {
      await second.close();
    }
    const store = await openStore(dir);
    try {
      assertEquals(await store.users.adminCount(), 1);
      assertEquals(await store.hats.list(), [
        { name: 'melofon', active: true },
        { name: 'opensubsonic', active: true },
        { name: 'owntone', active: true },
        { name: 'share', active: true },
      ]);
    } finally {
      await store.close();
    }
  }));

Deno.test('setup: failed codes use the shared limiter settings and ignore spoofed client addresses', () =>
  temp(async (dir) => {
    const f = await boot(dir);
    try {
      const body = {
        code: 'WRONG',
        username: 'admin',
        password: 'password-admin',
      };
      const responses = [];
      for (let i = 0; i < 11; i++) {
        responses.push(
          await f.post(body, { 'X-Forwarded-For': `192.0.2.${i}` }),
        );
      }
      assertEquals(responses.map((r) => r.status), [
        ...Array(10).fill(401),
        429,
      ]);
      assertEquals(responses[0].body.code, 'invalid_code');
      assertEquals(responses[10].body.code, 'too_many_attempts');
      assert(Number(responses[10].headers.get('retry-after')) > 0);
      assertEquals(f.exits, []);
      assert(f.replies.every((reply) => !reply.includes(f.code!)));
    } finally {
      await f.close();
    }
  }));

Deno.test('setup: Origin is mandatory even with Bearer, strict JSON and fields, own error pages', () =>
  temp(async (dir) => {
    const f = await boot(dir);
    try {
      const input = {
        code: f.code,
        username: 'admin',
        password: 'password-admin',
      };
      for (const origin of ['', 'null', 'http://evil.melofon.home']) {
        const response = await f.post(input, {
          Origin: origin,
          Authorization: 'Bearer ignored',
        });
        assertEquals([response.status, response.body.code], [403, 'origin']);
      }
      const missing = await f.request('/setup', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: 'Bearer ignored',
        },
        body: JSON.stringify(input),
      });
      assertEquals(missing.status, 403);
      for (
        const body of [
          { ...input, role: 'admin' },
          { ...input, username: '' },
          { ...input, displayName: 5 },
          { ...input, code: null },
        ]
      ) {
        const response = await f.post(body);
        assertEquals([response.status, response.body.code], [
          400,
          'invalid_field',
        ]);
      }
      for (const raw of ['{', '[]', 'null']) {
        const response = await f.request('/setup', {
          method: 'POST',
          headers: { Origin: f.origin, 'content-type': 'application/json' },
          body: raw,
        });
        assertEquals([response.status, response.body.code], [400, 'not_json']);
      }
      const media = await f.post(input, { 'content-type': 'text/plain' });
      assertEquals(media.status, 415);
      const large = await f.post({ junk: 'x'.repeat(65537) });
      assertEquals([large.status, large.body.code], [413, 'too_large']);
      assertEquals((await f.request('/setup/missing')).body.code, 'not_found');
      const method = await f.request('/setup', {
        method: 'DELETE',
        headers: { Origin: f.origin },
      });
      assertEquals([method.status, method.body.code], [
        405,
        'method_not_allowed',
      ]);
      assert(method.headers.get('allow')?.includes('POST'));
      assertEquals(f.exits, []);
    } finally {
      await f.close();
    }
  }));

Deno.test('setup: env seed bypasses setup; existing users without an admin are preserved', () =>
  temp(async (dir) => {
    const env = { MELOFON_USER: 'env-admin', MELOFON_PASSWORD: 'env-password' };
    const seeded = await boot(dir, env);
    try {
      assertEquals(seeded.server.setupMode, false);
      assertEquals(seeded.codeLines, []);
      assertEquals((await seeded.request('/setup')).status, 404);
    } finally {
      await seeded.close();
    }
    const store = await openStore(dir);
    const before = await store.users.credentials({ username: 'env-admin' });
    await rawSql(store).run("UPDATE users SET role = 'user'");
    await store.close();
    const repair = await boot(dir, env);
    try {
      assertEquals(repair.server.setupMode, true);
      const collision = await repair.post({
        code: repair.code,
        username: 'env-admin',
        password: 'replacement-password',
      });
      assertEquals([collision.status, collision.body.code], [
        400,
        'invalid_field',
      ]);
      const result = await repair.post({
        code: repair.code,
        username: 'replacement-admin',
        password: 'replacement-password',
      });
      assertEquals(result.status, 201);
      assertEquals(await repair.exited, 75);
    } finally {
      await repair.close();
    }
    const reopened = await openStore(dir);
    try {
      const after = await reopened.users.credentials({ username: 'env-admin' });
      assertEquals(after?.user.id, before?.user.id);
      assertEquals(after?.passwordEnc, before?.passwordEnc);
      assertEquals(after?.user.role, 'user');
      assertEquals(await reopened.users.count(), 2);
    } finally {
      await reopened.close();
    }
  }));

Deno.test('setup: a code rotates each start and a stale code cannot claim the server', () =>
  temp(async (dir) => {
    const first = await boot(dir);
    await first.close();
    const second = await boot(dir);
    try {
      assert(second.code !== first.code);
      const stale = await second.post({
        code: first.code,
        username: 'admin',
        password: 'password-admin',
      });
      assertEquals([stale.status, stale.body.code], [401, 'invalid_code']);
    } finally {
      await second.close();
    }
  }));

Deno.test('restart: shutdown waits for response completion, drains resources once, then injected exit 75', async () => {
  let complete!: () => void;
  const completed = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const sequence: string[] = [];
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const termination = createTermination({
    close: () => {
      sequence.push('closed');
      return Promise.resolve();
    },
    exit(code) {
      sequence.push(`exit:${code}`);
      resolveExit();
    },
  });
  termination.restartAfter(completed);
  await Promise.resolve();
  assertEquals(sequence, []);
  sequence.push('response-sent');
  complete();
  await exited;
  await termination.shutdown();
  assertEquals(sequence, ['response-sent', 'closed', 'exit:75']);
});

Deno.test('setup: desired flags are unchanged, including disabled normal hats and the setup flag', () =>
  temp(async (dir) => {
    const store = await openStore(dir);
    await store.hats.set('opensubsonic', false);
    await store.hats.set('setup', false);
    const flags = await store.hats.list();
    await store.close();
    const f = await boot(dir);
    try {
      assertEquals(f.server.hats.activeLayers().map((layer) => layer.name), [
        'setup',
      ]);
      assertEquals(
        f.server.hats.list().find((hat) => hat.name === 'opensubsonic')?.active,
        false,
      );
      assertEquals((await f.request('/rest/ping')).status, 404);
    } finally {
      await f.close();
    }
    const reopened = await openStore(dir);
    try {
      assertEquals(await reopened.hats.list(), flags);
    } finally {
      await reopened.close();
    }
  }));

Deno.test('setup: the core users transaction permits exactly one concurrent first-admin creation', () =>
  temp(async (dir) => {
    const store = await openStore(dir);
    try {
      const cfg = {
        dataDir: dir,
        secret: 'setup-test-secret',
        listen: undefined,
        user: undefined,
        password: undefined,
      };
      const auth = createAuthentication(store, cfg, createState(store));
      const results = await Promise.allSettled(
        ['first', 'second'].map((username) =>
          auth.users.createFirstAdmin({ username, password: 'password-admin' })
        ),
      );
      assertEquals(results.filter((r) => r.status === 'fulfilled').length, 1);
      const failure = results.find((r) => r.status === 'rejected');
      assert(failure?.status === 'rejected');
      assertEquals(failure.reason.code, 'forbidden');
      assertEquals(await store.users.count(), 1);
      assertEquals(await store.users.adminCount(), 1);
      const winner = results.find((r) => r.status === 'fulfilled');
      assert(winner?.status === 'fulfilled');
      const signed = await auth.signIn({
        username: winner.value.username,
        password: 'password-admin',
        clientAddress: 'setup-test',
        deviceName: 'test',
        userAgent: 'test',
      });
      assertEquals(
        (await auth.sessions.authenticate(signed.key))?.user.id,
        winner.value.id,
      );
    } finally {
      await store.close();
    }
  }));
