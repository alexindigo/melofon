import { assert, assertEquals } from '@std/assert';
import { apiFixture, error } from './helpers/api.ts';
import { createOutputs, type Outputs } from '../src/player.ts';
import { createSpeakers, type SpeakerView } from '../src/speakers.ts';
import { createOutputAdmission } from '../src/output-admission.ts';
import { createAirplayDevices } from '../src/boots/airplay-device.ts';
import { createAirplayDiscovery } from '../src/boots/airplay-mdns.ts';
import type { MdnsService } from '../src/mdns.ts';

const service: MdnsService = {
  name: '001122334455@Kitchen._raop._tcp.local',
  host: 'kitchen.local',
  address: '192.0.2.10',
  port: 7000,
  ttlMs: 120000,
  txt: { tp: 'UDP', am: 'AppleTV3,1', sr: '44100', ss: '16', ch: '2' },
};
const id = BigInt('0x001122334455').toString();

async function setup() {
  let outputs!: Outputs;
  let admission!: ReturnType<typeof createOutputAdmission>;
  let devices!: ReturnType<typeof createAirplayDevices>;
  let discovery!: ReturnType<typeof createAirplayDiscovery>;
  let announce!: (event: 'up' | 'down', service: MdnsService) => void;
  let clock = Date.now();
  let lookups = 0;
  let starts = 0;
  let saves = 0;
  let resolve!: (service: MdnsService) => void;
  let reject!: (error: Error) => void;
  const f = await apiFixture({
    hats: {
      layersRoot: 'layers',
      extraPorts: 1,
      env: ([port]) => ({ MELOFON_LISTEN_owntone: `${port},${port}` }),
    },
    services: async (f) => {
      outputs = createOutputs({
        notify: f.notify,
        persistence: {
          saveOutput() {
            saves++;
          },
          adoptOutput() {
            saves++;
            return Promise.resolve();
          },
        },
      });
      admission = createOutputAdmission({
        changed: () => f.notify!.emit(['outputs'], undefined, 'all'),
        now: () => clock,
        endpoint: (id) => {
          const row = outputs.get(id);
          return row?.host
            ? { id, protocol: row.type, address: row.host, port: row.port }
            : null;
        },
      });
      devices = createAirplayDevices({
        outputs,
        admission,
        changed: () => f.notify!.emit(['outputs'], undefined, 'all'),
        resolver: {
          resolve() {
            lookups++;
            return new Promise<MdnsService>((yes, no) => {
              resolve = yes;
              reject = no;
            });
          },
          close() {},
        },
        spawn() {
          starts++;
          throw new Error('GET must never construct a transport');
        },
      });
      discovery = createAirplayDiscovery({
        outputs,
        devices,
        state: f.state,
        createBrowser(onService) {
          announce = onService;
          return { resolve() {}, close() {} };
        },
      });
      // Wait for the existing asynchronous discovery-setting read.
      await f.state.getTyped('airplay.mdns');
      return {
        outputs,
        speakers: createSpeakers({
          outputs,
          adapterView: devices.describe,
        }),
      };
    },
  });
  const own = async (path = '/api/outputs') => {
    const response = await fetch(
      `http://melofon.home:${f.extraPorts[0]}${path}`,
      {
        signal: AbortSignal.timeout(5000),
      },
    );
    return response;
  };
  const read = async (credential: string, path = '/api/v1/speakers') => {
    const response = await f.get(path, credential, {
      Origin: 'http://other.home',
    });
    assertEquals(response.status, 200, await response.clone().text());
    assertEquals(response.headers.get('cache-control'), 'no-store');
    return response.json();
  };
  return {
    f,
    outputs,
    admission,
    devices,
    own,
    read,
    announce: (event: 'up' | 'down', row = service) => announce(event, row),
    expire: () => {
      clock = Date.now() + service.ttlMs + 1000;
    },
    resolve: () => resolve(service),
    reject: () => reject(new Error('receiver unavailable')),
    effects: () => ({ lookups, starts, saves }),
    async close() {
      discovery.close();
      devices.close();
      await f.close();
    },
  };
}

Deno.test('speaker HTTP reads require a login and allow cookie/Bearer for regular users and admins', async () => {
  const t = await setup();
  try {
    const addresses = await Deno.resolveDns('melofon.home', 'A');
    assert(
      addresses.length > 0 && addresses.every((ip) => !ip.startsWith('127.')),
    );
    await t.f.auth.users.create(t.f.admin.id, {
      username: 'member',
      password: 'password-member',
      role: 'user',
    });
    const paths = ['/api/v1/speakers', '/_melofon/api/v1/speakers'];
    for (const path of paths) {
      await error(await t.f.get(path), 401, 'unauthenticated');
      await error(await t.f.get(`${path}/missing`), 401, 'unauthenticated');
    }
    for (const username of ['admin', 'member']) {
      for (const mode of ['cookie', 'bearer'] as const) {
        const login = await t.f.login(mode, username, `password-${username}`);
        for (const path of paths) {
          assertEquals(await t.read(login.credential, path), { speakers: [] });
          await error(
            await t.f.get(`${path}/missing`, login.credential),
            404,
            'not_found',
          );
        }
      }
    }
    assertEquals(t.effects(), { starts: 0, lookups: 0, saves: 0 });
    const own = await t.own();
    assertEquals(own.status, 200);
    assertEquals(await own.json(), { outputs: [] });
  } finally {
    await t.close();
  }
});

Deno.test('speaker HTTP reads project discovered facts and failures while OwnTone keeps its wire view', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login('bearer');
    t.announce('up');
    const before = t.effects();
    const listed = (await t.read(credential)).speakers as SpeakerView[];
    assertEquals(listed.length, 1);
    assertEquals(listed[0], {
      id,
      name: 'Kitchen',
      protocol: 'AirPlay',
      address: service.address,
      port: 7000,
      model: 'AppleTV3,1',
      selected: false,
      volume: 100,
      connectionStrategy: 'melofon',
      adopted: false,
      discovered: true,
      abilities: {
        volume: true,
        seek: true,
        pin: false,
        password: false,
        formats: ['pcm'],
      },
      state: {
        connection: 'disconnected',
        authentication: 'none',
        preparation: {
          state: 'ready',
          targetRevision: 1,
          source: 'dns-sd',
          expiresAt: listed[0].state.preparation.expiresAt,
        },
      },
    });
    assert(listed[0].state.preparation.expiresAt! > Date.now());
    assertEquals(await t.read(credential, `/api/v1/speakers/${id}`), {
      speaker: listed[0],
    });
    assertEquals(await t.read(credential, `/_melofon/api/v1/speakers/${id}`), {
      speaker: listed[0],
    });
    const own = await t.own();
    assertEquals(own.status, 200);
    const ownBody = await own.json();
    assertEquals(ownBody, {
      outputs: [{
        id,
        name: 'Kitchen',
        type: 'AirPlay',
        selected: false,
        volume: 100,
        has_password: false,
        requires_auth: false,
        needs_auth_key: false,
        format: 'pcm',
        supported_formats: ['pcm'],
        offset_ms: 0,
      }],
    });
    const detail = await t.own(`/api/outputs/${id}`);
    assertEquals(detail.status, 200);
    assertEquals(await detail.json(), ownBody.outputs[0]);
    assertEquals(t.effects(), before, 'reads cannot discover, save or start');
    t.announce('up', { ...service, txt: { ...service.txt, pw: 'true' } });
    const protectedSpeaker = (await t.read(credential)).speakers[0];
    assertEquals(protectedSpeaker.state.preparation.state, 'ready');
    assertEquals(protectedSpeaker.abilities.password, true);
    assertEquals(protectedSpeaker.state.authentication, 'none');
    assertEquals((await (await t.own()).json()).outputs[0].has_password, true);
    assertEquals(t.effects(), before, 'password facts cannot grant sessions');
    t.expire();
    assertEquals(
      (await t.read(credential)).speakers[0].state.preparation.state,
      'unresolved',
    );
    assertEquals((await t.read(credential)).speakers[0].abilities, null);
    // Passwords are supported; incompatible PCM remains a preparation failure.
    t.announce('up', {
      ...service,
      txt: { ...service.txt, pw: 'true', ch: '1' },
    });
    const failed = (await t.read(credential)).speakers[0].state.preparation;
    assertEquals(failed.state, 'failed');
    assertEquals(failed.error.code, 'unsupported');
    assertEquals((await (await t.own()).json()).outputs[0].has_password, true);
    assert(!('source' in failed));
    t.announce('down');
    assertEquals(await t.read(credential), { speakers: [] });
    await error(
      await t.f.get(`/api/v1/speakers/${id}`, credential),
      404,
      'not_found',
    );
    const missingOwn = await t.own(`/api/outputs/${id}`);
    assertEquals(missingOwn.status, 400);
    await missingOwn.body?.cancel();
  } finally {
    await t.close();
  }
});

Deno.test('speaker HTTP reads track preparation without granting sessions or inferring readiness from saved preferences', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login();
    // A non-decimal id also demonstrates that native speakers are protocol-neutral.
    t.outputs.register({
      id: 'manual-speaker',
      name: 'Manual',
      type: 'AirPlay',
      host: service.address,
      port: 7000,
      selected: true,
      volume: 42,
      connectionStrategy: 'owntone',
    });
    const path = '/api/v1/speakers/manual-speaker';
    const initial = (await t.read(credential, path)).speaker;
    assertEquals(initial.state.preparation, {
      state: 'unresolved',
      targetRevision: 1,
    });
    assertEquals(initial.selected, true);
    const pending = t.devices.registerAddress({
      name: 'Manual',
      host: service.address,
      port: 7000,
    });
    const effects = t.effects();
    assertEquals(effects.lookups, 1);
    assertEquals(
      (await t.read(credential, path)).speaker.state.preparation.state,
      'preparing',
    );
    assertEquals(t.effects(), effects);
    t.resolve();
    await pending;
    const ready = (await t.read(credential, path)).speaker;
    assertEquals(ready.state.preparation.state, 'ready');
    assertEquals(ready.connectionStrategy, 'owntone');
    t.admission.invalidate('manual-speaker');
    const retry = t.devices.registerAddress({
      name: 'Manual',
      host: service.address,
      port: 7000,
    });
    t.reject();
    await retry;
    const failed = (await t.read(credential, path)).speaker;
    assertEquals(failed.state.preparation.state, 'failed');
    assertEquals(failed.state.preparation.error.code, 'unavailable');
    assertEquals(failed.selected, true);
    t.outputs.register({
      ...t.outputs.get('manual-speaker')!,
      host: '192.0.2.11',
    });
    const moved = (await t.read(credential, path)).speaker;
    assertEquals(moved.address, '192.0.2.11');
    assertEquals(moved.state.preparation.state, 'unresolved');
    assert(
      moved.state.preparation.targetRevision >
        ready.state.preparation.targetRevision,
    );
    const finalEffects = t.effects();
    await t.read(credential);
    await t.read(credential, path);
    assertEquals(t.effects(), finalEffects);
    assertEquals(finalEffects.starts, 0);
  } finally {
    await t.close();
  }
});

Deno.test('temporary selected speakers retain session intent across withdrawal and release on every deselection path', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login('bearer');
    const command = async (path: string, body?: unknown) => {
      const response = await fetch(
        `http://melofon.home:${t.f.extraPorts[0]}/api/outputs${path}`,
        {
          method: 'PUT',
          signal: AbortSignal.timeout(5000),
          headers: { 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      assertEquals(response.status, 204, await response.text());
    };
    for (const mode of ['set', 'toggle', 'update'] as const) {
      t.announce('up');
      await command('/set', { outputs: [id] });
      await command(`/${id}`, { volume: 37 });
      t.announce('down');
      let row = (await t.read(credential)).speakers[0];
      assert(row, 'selected temporary identity survives observation loss');
      assertEquals(row.adopted, false);
      assertEquals(row.discovered, false);
      assertEquals(row.selected, true);
      assertEquals(row.volume, 37);
      assertEquals(row.state.preparation.state, 'unresolved');
      t.announce('up');
      row = (await t.read(credential)).speakers[0];
      assertEquals(row.selected, true);
      assertEquals(row.volume, 37);
      assertEquals(row.discovered, true);
      assertEquals(row.state.preparation.state, 'ready');
      t.announce('down');
      if (mode === 'set') await command('/set', { outputs: [] });
      else if (mode === 'toggle') await command(`/${id}/toggle`);
      else await command(`/${id}`, { selected: false });
      assertEquals((await t.read(credential)).speakers, []);
      assertEquals(await (await t.own()).json(), { outputs: [] });
      t.announce('up');
      row = (await t.read(credential)).speakers[0];
      assertEquals(row.selected, false);
      assertEquals(row.volume, 100, 'released temporary preferences are gone');
      t.announce('down');
      assertEquals((await t.read(credential)).speakers, []);
    }
    assertEquals(t.effects().saves, 0);
    assertEquals(t.effects().starts, 0);
  } finally {
    await t.close();
  }
});
