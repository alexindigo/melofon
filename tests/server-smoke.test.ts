// tests/server-smoke.test.ts — the real main.ts booted as a child process on
// free loopback ports: health, the OpenSubsonic surface over the socket, and
// restart restore of an AirPlay output.
import { assert, assertEquals } from '@std/assert';
import { startFakeRaop } from './helpers/fake-raop.ts';

const USER = 'admin';
const PASSWORD = 'smoke-password';
const AUTH = { u: USER, p: PASSWORD, v: '1.16.1', c: 'smoke' };
const AUTH_QUERY = new URLSearchParams(AUTH).toString();
const INHERITED = ['HOME', 'PATH', 'DENO_DIR', 'TMPDIR', 'MELOFON_RAOP_LIB'];

async function boot(dataDir: string, extra: Record<string, string> = {}) {
  const freePort = () => {
    const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    const { port } = listener.addr as Deno.NetAddr;
    listener.close();
    return port;
  };
  const port = freePort();
  const env: Record<string, string> = {};
  for (const name of INHERITED) {
    const value = Deno.env.get(name);
    if (value !== undefined) env[name] = value;
  }
  Object.assign(env, {
    MELOFON_DATA: dataDir,
    MELOFON_USER: USER,
    MELOFON_PASSWORD: PASSWORD,
    MELOFON_SECRET: 'smoke-secret',
    MELOFON_LISTEN: `127.0.0.1:${port}`,
    MELOFON_LISTEN_owntone: `${freePort()},${freePort()}`,
    MELOFON_AIRPLAY_MDNS: 'off',
    ...extra,
  });
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
    cwd: new URL('../', import.meta.url),
    clearEnv: true,
    env,
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  // Drain both pipes so the child never blocks on a full buffer.
  const drained = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const kill = (signal: Deno.Signal) => {
    try {
      child.kill(signal);
    } catch {
      // Already exited: nothing left to signal.
    }
  };
  const stop = async () => {
    kill('SIGTERM');
    const exited = await Promise.race([
      child.status.then(() => true),
      new Promise<boolean>((resolve) => {
        AbortSignal.timeout(10_000).addEventListener(
          'abort',
          () => resolve(false),
        );
      }),
    ]);
    if (!exited) kill('SIGKILL');
    await child.status;
    await drained;
  };
  const base = `http://127.0.0.1:${port}`;
  try {
    const until = Date.now() + 30_000;
    for (;;) {
      try {
        const res = await fetch(`${base}/_/health`, {
          signal: AbortSignal.timeout(1_000),
        });
        if ((await res.json()).ok === true) break;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > until) {
        throw new Error('server never became healthy');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    await stop();
    throw error;
  }
  return { base, stop };
}

Deno.test('boot: health is ok and ping reports 1.16.1 with the fixture login', async () => {
  const data = await Deno.makeTempDir({ prefix: 'melofon-smoke-' });
  const server = await boot(data);
  try {
    const health = await fetch(`${server.base}/_/health`);
    assertEquals(await health.json(), { ok: true });
    const ping = await fetch(`${server.base}/rest/ping?${AUTH_QUERY}&f=json`);
    const body = (await ping.json())['subsonic-response'];
    assertEquals([body.status, body.version], ['ok', '1.16.1']);
  } finally {
    await server.stop();
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test('OpenSubsonic over the socket: public, form, mixed, XML and JSONP', async () => {
  const data = await Deno.makeTempDir({ prefix: 'melofon-smoke-' });
  const server = await boot(data);
  try {
    const { base } = server;
    const discovery = await fetch(
      `${base}/rest/getOpenSubsonicExtensions?f=json`,
    );
    assertEquals((await discovery.json())['subsonic-response'].status, 'ok');

    const form = await fetch(`${base}/rest/getUser`, {
      method: 'POST',
      body: new URLSearchParams({ ...AUTH, f: 'json' }),
    });
    assertEquals((await form.json())['subsonic-response'].status, 'ok');

    const mixed = await fetch(`${base}/rest/ping?${AUTH_QUERY}&t=abc&f=json`);
    const conflict = (await mixed.json())['subsonic-response'];
    assertEquals(conflict.error.code, 43);

    const stream = await fetch(
      `${base}/rest/stream?u=${USER}&p=wrong&v=1.16.1&c=smoke`,
    );
    assertEquals(stream.headers.get('content-type'), 'text/xml; charset=utf-8');
    await stream.text();

    const put = await fetch(`${base}/_/config/opensubsonic.jsonp`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'on' }),
    });
    assertEquals(await put.json(), { ok: true });

    const jsonp = await fetch(
      `${base}/rest/ping?${AUTH_QUERY}&f=jsonp&callback=cb`,
    );
    assertEquals(jsonp.headers.get('content-type'), 'application/javascript');
    assertEquals(jsonp.headers.get('x-content-type-options'), 'nosniff');
    const raw = await jsonp.text();
    assert(raw.startsWith('cb(') && raw.endsWith(')'), raw);
    const envelope = JSON.parse(raw.slice(3, -1))['subsonic-response'];
    assertEquals(envelope.status, 'ok');
  } finally {
    await server.stop();
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test('restart restores an AirPlay output registered by host env', async () => {
  const data = await Deno.makeTempDir({ prefix: 'melofon-smoke-' });
  const raop = await startFakeRaop();
  try {
    const first = await boot(data, {
      MELOFON_AIRPLAY_HOST: `127.0.0.1:${raop.port}`,
    });
    try {
      const listed = await fetch(`${first.base}/_/outputs`);
      const { outputs } = await listed.json();
      assert(outputs.some((o: { host?: string }) => o.host === '127.0.0.1'));
    } finally {
      await first.stop();
    }
    const second = await boot(data);
    try {
      const listed = await fetch(`${second.base}/_/outputs`);
      const { outputs } = await listed.json();
      assert(outputs.some((o: { host?: string }) => o.host === '127.0.0.1'));
    } finally {
      await second.stop();
    }
  } finally {
    raop.close();
    await Deno.remove(data, { recursive: true });
  }
});
