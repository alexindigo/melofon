import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { facade } from '../../src/facade.ts';
import { findHats, loadHat } from '../../src/layers.ts';
import { authFixture } from './authentication.ts';

export async function apiFixture(
  options: { failSignIn?: boolean; tls?: boolean } = {},
) {
  const f = await authFixture();
  const peers: string[] = [];
  const bag = {
    ...f.auth,
    state: f.state,
    signIn(input: Parameters<typeof f.auth.signIn>[0]) {
      peers.push(input.clientAddress);
      if (options.failSignIn) throw new Error('private fixture failure');
      return f.auth.signIn(input);
    },
  };
  try {
    const found = (await findHats({ app: bag })).find((h) =>
      h.name === 'melofon'
    )!;
    assertEquals(found.errors, []);
    const layer = await loadHat(found, bag);
    assert(
      (await f.store.hats.list()).some((h) => h.name === 'melofon' && h.active),
    );
    const core = await pathfinder({
      roots: ['core/'],
      app: { store: f.store },
    });
    const tls = options.tls
      ? {
        cert: await Deno.readTextFile('tests/fixtures/api-tls/cert.pem'),
        key: await Deno.readTextFile('tests/fixtures/api-tls/key.pem'),
      }
      : {};
    const client = options.tls
      ? Deno.createHttpClient({ caCerts: [tls.cert!] })
      : undefined;
    const server = Deno.serve(
      { hostname: '0.0.0.0', port: 0, onListen() {}, ...tls },
      facade(core, [layer]),
    );
    const origin = `${
      options.tls ? 'https' : 'http'
    }://melofon.home:${server.addr.port}`;
    const request = async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      // Test callers explicitly control Origin, including absence.
      const response = await fetch(`${origin}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(5000),
        ...(client ? { client } : {}),
      });
      for (const [name] of response.headers) {
        assert(
          !name.toLowerCase().startsWith('access-control-'),
          `unexpected CORS header ${name}`,
        );
      }
      return response;
    };
    const json = (
      path: string,
      method: string,
      body: unknown,
      credential?: string,
      givenOrigin: string | null = origin,
    ) => {
      const headers = new Headers({
        'Content-Type': 'application/json',
        'User-Agent': 'Melofon API test',
      });
      if (givenOrigin !== null) headers.set('Origin', givenOrigin);
      if (credential) {
        headers.set(
          credential.startsWith('melofon_session=')
            ? 'Cookie'
            : 'Authorization',
          credential.startsWith('melofon_session=')
            ? credential
            : `Bearer ${credential}`,
        );
      }
      return request(path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    };
    const login = async (
      use: 'cookie' | 'bearer' = 'cookie',
      username = 'admin',
      password = 'password-admin',
      deviceName = 'Device',
    ) => {
      const response = await json('/api/v1/session', 'POST', {
        username,
        password,
        use,
        deviceName,
      });
      assertEquals(response.status, 200, await response.clone().text());
      const body = await response.json();
      const credential: string = use === 'cookie'
        ? response.headers.get('set-cookie')!.split(';')[0]
        : body.key;
      return { response, body, credential };
    };
    const get = (
      path: string,
      credential?: string,
      extra: Record<string, string> = {},
    ) => {
      return request(path, {
        headers: {
          ...(credential
            ? credential.startsWith('melofon_session=')
              ? { Cookie: credential }
              : { Authorization: `Bearer ${credential}` }
            : {}),
          ...extra,
        },
      });
    };
    return {
      ...f,
      origin,
      peers,
      request,
      json,
      login,
      get,
      async close() {
        await server.shutdown();
        client?.close();
        await f.close();
      },
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}

export async function error(response: Response, status: number, code: string) {
  const body = await response.json();
  assertEquals(response.status, status, JSON.stringify(body));
  assertEquals(body.code, code);
  assertEquals(Object.keys(body).sort(), ['code', 'message']);
  assertEquals(typeof body.message, 'string');
  return body;
}
export function cleared(response: Response) {
  assert(response.headers.get('set-cookie')?.includes('melofon_session=;'));
  assert(response.headers.get('set-cookie')?.includes('Max-Age=0'));
}
export function iso(value: string) {
  assert(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value), value);
}
