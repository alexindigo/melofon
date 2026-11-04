import { assert, assertEquals } from '@std/assert';
import { apiFixture } from './helpers/api.ts';
import { createLibraries } from '../src/libraries.ts';
import { createOutputs } from '../src/player.ts';
import { createSpeakers } from '../src/speakers.ts';
import { createAirplayDevices } from '../src/boots/airplay-device.ts';
import { PreparationError } from '../src/output-admission.ts';
import { pathfinder } from '@pathfinder/pathfinder';
import { facade } from '../src/facade.ts';
import { authFixture } from './helpers/authentication.ts';
import { loadLayers } from '../src/layers.ts';

const forwardedHeaders = [
  'X-Forwarded-For',
  'X-Forwarded-Host',
  'X-Forwarded-Proto',
  'X-Real-IP',
  'Forwarded',
];

// All forms dispatch to Pathfinder's inherited Layer 0 status tree.
const statusPaths = [
  '/_/_status',
  '/_/_status/',
  '/_/_status/health',
  '/api/v1/_status',
  '/_melofon/api/v1/_status',
  '/_melofon/_status',
  '/_status',
];

for (const header of forwardedHeaders) {
  Deno.test(`core lockdown: loopback with ${header} is never local, even when empty`, async () => {
    const f = await apiFixture();
    try {
      for (const value of ['', '127.0.0.1', 'untrusted proxy data']) {
        const headers = { [header]: value };
        for (const path of ['/_/config', ...statusPaths]) {
          const response = await f.request(path, { headers }, true);
          assertEquals(response.status, 404, `${header} ${path}`);
          assertEquals(await response.json(), { detail: 'Not Found' });
        }
        for (const loopback of [true, false]) {
          const health = await f.request('/_/health', { headers }, loopback);
          assertEquals(health.status, 200);
          assertEquals(await health.json(), { ok: true });
        }
      }
    } finally {
      await f.close();
    }
  });
}

Deno.test('core lockdown: direct loopback config and inherited status aliases remain available', async () => {
  const f = await apiFixture();
  try {
    for (const path of ['/_/config', '/_/health', ...statusPaths]) {
      const response = await f.request(path, {}, true);
      assertEquals(response.status, 200, path);
      await response.json();
    }
  } finally {
    await f.close();
  }
});

Deno.test('core lockdown: inherited status descendants share the guard across header-selected mounts and extra binds', async () => {
  const f = await authFixture();
  const app = { store: f.store, state: f.state };
  const core = await pathfinder({ roots: ['core/'], app });
  const layers = (await loadLayers({
    app,
    layersRoot: 'tests/fixtures/layers',
  })).filter((layer) => ['layer-p', 'layer-q'].includes(layer.name)).map((
    layer,
  ) => ({
    ...layer,
    headers: [{ name: 'x-hat', includes: layer.name }],
    mounts: layer.mounts.map((mount) => ({ ...mount, prefix: '/shared' })),
  }));
  try {
    for (const extra of [false, true]) {
      const server = Deno.serve(
        { hostname: '0.0.0.0', port: 0, onListen() {} },
        facade(
          core,
          layers.map((layer) => ({ ...layer, ports: extra ? [3689] : [] })),
          extra ? { listenPort: 3689, defaultPort: 4534 } : {},
        ),
      );
      try {
        for (const layer of layers) {
          for (
            const prefix of [
              '/shared',
              `/_${layer.name}`,
              `/_${layer.name}/shared`,
            ]
          ) {
            for (const suffix of ['/_status', '/_status/', '/_status/health']) {
              for (const header of [undefined, ...forwardedHeaders]) {
                const response = await fetch(
                  `http://127.0.0.1:${server.addr.port}${prefix}${suffix}`,
                  {
                    headers: {
                      'x-hat': layer.name,
                      ...(header ? { [header]: '' } : {}),
                    },
                    signal: AbortSignal.timeout(5000),
                  },
                );
                assertEquals(
                  response.status,
                  header ? 404 : 200,
                  `${extra} ${prefix}${suffix} ${header}`,
                );
                const body = await response.json();
                if (header) assertEquals(body, { detail: 'Not Found' });
              }
            }
          }
        }
      } finally {
        await server.shutdown();
      }
    }
  } finally {
    await f.close();
  }
});

Deno.test('core lockdown: LAN and spoofed forwarding get bare 404s on every admin route; health stays public', async () => {
  const f = await apiFixture();
  try {
    const { credential } = await f.login('bearer');
    assert(f.peers.every((peer) => peer !== '127.0.0.1' && peer !== '::1'));
    const routes = [
      ['GET', '/_/config'],
      ['PUT', '/_/config/arbitrary'],
      ['GET', '/_/libraries'],
      ['POST', '/_/libraries'],
      ['DELETE', '/_/libraries/id'],
      ['GET', '/_/outputs'],
      ['POST', '/_/outputs'],
      ['PUT', '/_/outputs/id'],
      ['DELETE', '/_/outputs/id'],
      ['POST', '/_/outputs/id/pin'],
      ['GET', '/_/last-command'],
      ['POST', '/_/last-command'],
      ['GET', '/_/unknown'],
    ];
    for (
      const headers of [
        {},
        {
          'X-Forwarded-For': '127.0.0.1',
          'X-Real-IP': '::1',
          Authorization: `Bearer ${credential}`,
        },
      ] as Record<string, string>[]
    ) {
      for (const [method, path] of routes) {
        const response = await f.request(path, { method, headers });
        assertEquals(response.status, 404, `${method} ${path}`);
        assertEquals(await response.json(), { detail: 'Not Found' });
      }
      const health = await f.get('/_/health', undefined, headers);
      assertEquals(health.status, 200);
      assertEquals(await health.json(), { ok: true });
    }
  } finally {
    await f.close();
  }
});

Deno.test('core lockdown: loopback config, libraries, all outputs routes and diagnostics retain their behaviour', async () => {
  const root = await Deno.makeTempDir({ prefix: 'melofon-core-lockdown-' });
  const outputs = createOutputs();
  const airplay = createAirplayDevices({
    outputs,
    resolver: {
      resolve: () =>
        Promise.reject(new PreparationError('timeout', 'fixture timeout')),
      close() {},
    },
    spawn: () => {
      throw new Error('CRUD must not start transport');
    },
  });
  const f = await apiFixture({
    services: async (f) => {
      f.state.declare('fixture.local', { type: 'string', default: 'default' });
      await f.state.seedIfUnset('fixture.local', 'default');
      return {
        libraries: createLibraries(f.store, { dataDir: f.dir }),
        outputs,
        airplay,
        speakers: createSpeakers({
          outputs,
          registerAddress: airplay.registerAddress,
          submitPin: async (id, pin) => {
            outputs.update(id, { pin });
            await Promise.resolve();
            return { state: 'pairing' as const, saved: false };
          },
          adapterView: (id) => ({
            preparation: airplay.admission.describe(id),
          }),
        }),
        outputAdmission: airplay.admission,
        playback: { lastCommand: () => null },
      };
    },
  });
  const local = (path: string, method = 'GET', body?: unknown) =>
    f.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, true);
  const ok = async (response: Response) => {
    assertEquals(response.status, 200, await response.clone().text());
    return response.json();
  };
  try {
    await ok(await local('/_/health'));
    assertEquals(
      (await ok(await local('/_/config'))).config['fixture.local'],
      'default',
    );
    await ok(
      await local('/_/config/fixture.local', 'PUT', { value: 'changed' }),
    );
    assertEquals(
      (await ok(await local('/_/config'))).config['fixture.local'],
      'changed',
    );
    const added = await ok(
      await local('/_/libraries', 'POST', { name: 'Local', path: root }),
    );
    assertEquals((await ok(await local('/_/libraries'))).libraries, [
      added.library,
    ]);
    const invalid = await local('/_/libraries', 'POST', {
      name: 'Relative',
      path: 'relative',
    });
    assertEquals(invalid.status, 400);
    assertEquals((await invalid.json()).code, 'path_not_absolute');
    await ok(await local(`/_/libraries/${added.library.id}`, 'DELETE'));
    const registered = await ok(
      await local('/_/outputs', 'POST', {
        name: 'Local',
        type: 'AirPlay',
        host: '192.0.2.10',
      }),
    );
    const id = registered.output.id;
    assertEquals((await ok(await local('/_/outputs'))).outputs[0].id, id);
    await ok(
      await local(`/_/outputs/${id}`, 'PUT', { connectionStrategy: 'owntone' }),
    );
    const pins: unknown[] = [];
    outputs.onCommand((id, command) => pins.push([id, command]));
    await ok(await local(`/_/outputs/${id}/pin`, 'POST', { pin: '1234' }));
    assertEquals(pins, [[id, { pin: '1234' }]]);
    const diagnostic = await ok(await local('/_/last-command'));
    assertEquals(diagnostic.playback, null);
    assertEquals(diagnostic.outputs.kind, 'update');
    await ok(await local(`/_/outputs/${id}`, 'DELETE'));
    assertEquals((await ok(await local('/_/outputs'))).outputs, []);
  } finally {
    airplay.close();
    await f.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('core lockdown: IPv6 loopback is admitted and unknown/non-loopback peers fail closed', async () => {
  const f = await authFixture();
  const core = await pathfinder({
    roots: ['core/'],
    app: { store: f.store, state: f.state },
  });
  const route = facade(core, []);
  const server = Deno.serve({ hostname: '::1', port: 0, onListen() {} }, route);
  try {
    const response = await fetch(`http://[::1]:${server.addr.port}/_/config`, {
      signal: AbortSignal.timeout(5000),
    });
    assertEquals(response.status, 200);
    await response.json();
    // Supplemental peer-parser boundary cases; the LAN tests above exercise
    // real peer forwarding end-to-end rather than only this supplied info.
    for (
      const hostname of [
        undefined,
        '192.168.1.20',
        '127.0.0.999',
        'localhost',
        '::ffff:192.168.1.5',
        '::ffff:127.0.0.999',
      ]
    ) {
      const denied = await route(
        new Request('http://melofon.home/_/config', {
          headers: { 'X-Forwarded-For': '::ffff:127.0.0.1' },
        }),
        hostname ? { remoteAddr: { hostname } } : undefined,
      );
      assertEquals(denied.status, 404);
      assertEquals(await denied.json(), { detail: 'Not Found' });
    }
    for (
      const hostname of [
        '127.0.0.1',
        '127.23.45.67',
        '::1',
        '::ffff:127.0.0.1',
        '::FFFF:127.23.45.67',
      ]
    ) {
      const allowed = await route(new Request('http://melofon.home/_/config'), {
        remoteAddr: { hostname },
      });
      assertEquals(allowed.status, 200);
      await allowed.json();
    }
  } finally {
    await server.shutdown();
    await f.close();
  }
});

Deno.test('core lockdown: forwarded IPv6 loopback requests lose local privilege while health stays public', async () => {
  const f = await authFixture();
  const core = await pathfinder({
    roots: ['core/'],
    app: { store: f.store, state: f.state },
  });
  const server = Deno.serve(
    { hostname: '::1', port: 0, onListen() {} },
    facade(core, []),
  );
  try {
    for (const header of forwardedHeaders) {
      for (const path of ['/_/config', '/_/_status', '/_/health']) {
        const response = await fetch(
          `http://[::1]:${server.addr.port}${path}`,
          {
            headers: { [header]: '' },
            signal: AbortSignal.timeout(5000),
          },
        );
        assertEquals(response.status, path === '/_/health' ? 200 : 404);
        assertEquals(
          await response.json(),
          path === '/_/health' ? { ok: true } : { detail: 'Not Found' },
        );
      }
    }
  } finally {
    await server.shutdown();
    await f.close();
  }
});
