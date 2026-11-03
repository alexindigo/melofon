import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { facade } from '../../src/facade.ts';
import { findHats, loadHat } from '../../src/layers.ts';
import { authFixture } from './authentication.ts';
import { createHats, type Hats } from '../../src/hats.ts';
import { createHatServices } from '../../src/hat-service.ts';
import { createHatData } from '../../src/hat-data.ts';
import { createArtwork } from '../../src/artwork.ts';
import { createLibrary } from '../../src/library.ts';
import { createPortMapping } from '../../src/binds.ts';
import {
  createListenManager,
  type ListenManager,
} from '../../src/listen-manager.ts';
import { createNotify } from '../../src/notify.ts';
import { createSettings } from '../../src/settings.ts';
import { createPublicAddress } from '../../src/public-address.ts';
import { createPreferences } from '../../src/preferences.ts';
import { configureLogging, type Logger, scopedLog } from '../../src/logging.ts';
import { createServerStatus } from '../../src/server-status.ts';
import { loadConfig } from '../../src/config.ts';
import type { ScanService } from '../../src/scan.ts';
import { reservePorts } from './ports.ts';

export async function apiFixture(
  options: {
    failSignIn?: boolean;
    tls?: boolean;
    hats?: {
      layersRoot: string;
      extraPorts: number;
      env: (ports: number[]) => Record<string, string>;
    };
    services?: (
      fixture: Awaited<ReturnType<typeof authFixture>>,
    ) => Promise<Record<string, unknown>>;
    allLayers?: boolean;
    status?: Logger;
    traceRequests?: boolean;
    storeDir?: string;
  } = {},
) {
  const notify = createNotify();
  const f = await authFixture(notify, options.storeDir);
  const peers: string[] = [];
  let hats: Hats | undefined;
  let listens: ListenManager | undefined;
  let stopLoggingSettings: (() => void) | undefined;
  const notifications: string[][] = [];
  notify.subscribe((names) => notifications.push(names));
  const settingNotifications: Record<string, string[]>[] = [];
  notify.subscribe((names, keys) => {
    if (names.includes('settings') && keys) settingNotifications.push(keys);
  });
  const bag = {
    ...f.auth,
    notify,
    state: f.state,
    publicAddress: createPublicAddress(f.state),
    cfg: f.cfg,
    settings: createSettings(f.store, f.state),
    preferences: createPreferences(f.store, f.state, notify),
    hats: createHatServices(f.store, () => hats!),
    hatData: createHatData(f.store, f.cfg, f.state),
    artwork: createArtwork(createLibrary(f.store), {
      state: f.state,
      dataDir: f.cfg.dataDir,
      facts: f.store.artwork,
    }),
    signIn(input: Parameters<typeof f.auth.signIn>[0]) {
      peers.push(input.clientAddress);
      if (options.failSignIn) throw new Error('private fixture failure');
      return f.auth.signIn(input);
    },
  };
  try {
    Object.assign(bag, await options.services?.(f));
    if (options.status) {
      f.cfg.version = loadConfig().version!;
      stopLoggingSettings = await configureLogging(f.state, options.status);
      Object.assign(bag, {
        server: createServerStatus({
          store: f.store,
          version: f.cfg.version,
          startedAt: new Date().toISOString(),
          hats: () => hats!,
          listens: () => listens?.list() ?? [],
          scan: (bag as unknown as { scan: ScanService }).scan,
          logger: options.status,
        }),
      });
    }
    const foundHats = await findHats({ app: bag });
    const found = foundHats.find((h) => h.name === 'melofon')!;
    assertEquals(found.errors, []);
    const layer = await loadHat(found, bag);
    const layers = options.allLayers
      ? await Promise.all(
        foundHats.filter((h) => !h.setup && h.errors.length === 0).map((h) =>
          loadHat(h, bag)
        ),
      )
      : [layer];
    assert(
      (await f.store.hats.list()).some((h) => h.name === 'melofon' && h.active),
    );
    const core = await pathfinder({
      roots: ['core/'],
      app: { store: f.store, ...bag, log: scopedLog('core') },
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
    using reserved = reservePorts(1 + (options.hats?.extraPorts ?? 0));
    const [port, ...extraPorts] = reserved.ports;
    let shutdown: () => Promise<void>;
    if (options.hats) {
      assert(!options.tls, 'lifecycle fixture uses plain HTTP');
      const mapping = createPortMapping(options.hats.env(extraPorts));
      listens = createListenManager({
        core,
        layers: () => hats?.activeLayers() ?? [],
        mapping,
        defaultPort: port,
        hostname: '0.0.0.0',
        debugLogRequests: options.traceRequests,
        debugLogHeaders: options.traceRequests,
        publicAddress: bag.publicAddress,
      });
      try {
        reserved.release();
        hats = await createHats({
          store: f.store,
          app: bag,
          layersRoot: options.hats.layersRoot,
          mapping,
          listens,
          notify,
        });
        await listens.ensure([port]);
      } catch (error) {
        await listens.shutdown();
        throw error;
      }
      shutdown = () => listens!.shutdown();
    } else {
      reserved.release();
      const server = Deno.serve(
        { hostname: '0.0.0.0', port, onListen() {}, ...tls },
        facade(core, layers, {
          debugLogRequests: options.traceRequests,
          debugLogHeaders: options.traceRequests,
          publicAddress: bag.publicAddress,
        }),
      );
      shutdown = () => server.shutdown();
    }
    const origin = `${options.tls ? 'https' : 'http'}://melofon.home:${port}`;
    const request = async (
      path: string,
      init: RequestInit = {},
      loopback = false,
    ) => {
      const headers = new Headers(init.headers);
      // Test callers explicitly control Origin, including absence.
      const response = await fetch(
        `${
          loopback ? origin.replace('melofon.home', '127.0.0.1') : origin
        }${path}`,
        {
          ...init,
          headers,
          signal: AbortSignal.timeout(5000),
          ...(client ? { client } : {}),
        },
      );
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
      loopback = false,
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
      }, loopback);
    };
    const login = async (
      use: 'cookie' | 'bearer' = 'cookie',
      username = 'admin',
      password = 'password-admin',
      deviceName = 'Device',
    ) => {
      const response = await json(
        `${await bag.publicAddress.prefix()}/api/v1/session`,
        'POST',
        {
          username,
          password,
          use,
          deviceName,
        },
      );
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
      notify,
      origin,
      extraPorts,
      peers,
      notifications,
      settingNotifications,
      request,
      json,
      login,
      get,
      async close() {
        await shutdown();
        stopLoggingSettings?.();
        client?.close();
        await f.close();
      },
    };
  } catch (error) {
    stopLoggingSettings?.();
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
