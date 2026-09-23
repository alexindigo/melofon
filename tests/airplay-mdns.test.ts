// tests/airplay-mdns.test.ts — AirPlay discovery: TXT → output registration
// (id, name, host/port, devtype/encrypt/needsAuthKey), the tp filter, host
// dedupe (manual wins), unregister on down, the live airplay.mdns toggle,
// and password warnings. The browser is injected — no multicast in the gate.
import { assert, assertEquals } from '@std/assert';
import {
  createAirplayDiscovery,
  devtypeFromAm,
  supportsAuthSetupFromEt,
  wantedMetadataFromMd,
} from '../src/boots/airplay-mdns.ts';
import type { MdnsService } from '../src/mdns.ts';
import { createOutputs } from '../src/player.ts';
import type { State } from '../src/state.ts';

const INSTANCE = 'A4B2C1D2E3F4@Kitchen ATV._raop._tcp.local';
const ID = BigInt('0xA4B2C1D2E3F4').toString(10);

function fakeState(initial: Record<string, string> = {}): State & {
  change(key: string, value: string): void;
} {
  const store = new Map(Object.entries(initial));
  const listeners = new Set<(key: string, value: string) => void>();
  return {
    get: (key) => Promise.resolve(store.get(key) ?? null),
    set: (key, value) => {
      store.set(key, value);
      for (const fn of [...listeners]) fn(key, value);
      return Promise.resolve();
    },
    seedIfUnset: (key, value) => {
      if (store.has(key)) return Promise.resolve(false);
      store.set(key, value);
      for (const fn of [...listeners]) fn(key, value);
      return Promise.resolve(true);
    },
    list: () => Promise.resolve(Object.fromEntries(store)),
    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    change(key, value) {
      store.set(key, value);
      for (const fn of [...listeners]) fn(key, value);
    },
  };
}

class FakeBrowser {
  onService: ((event: 'up' | 'down', svc: MdnsService) => void) | null = null;
  closed = false;
  resolved: string[] = [];
  close() {
    this.closed = true;
  }
  resolve(address: string) {
    this.resolved.push(address);
  }
}

function svc(overrides: Partial<MdnsService> = {}): MdnsService {
  return {
    name: INSTANCE,
    host: 'kitchen-atv.local',
    port: 7000,
    address: '192.168.1.50',
    txt: {
      tp: 'UDP',
      am: 'AppleTV3,1',
      ek: '1',
      sf: '0x200',
      md: '0,1,2',
      et: '0,3,5',
    },
    ttlMs: 120_000,
    ...overrides,
  };
}

function setup(initial: Record<string, string> = {}) {
  const outputs = createOutputs();
  const state = fakeState(initial);
  const browsers: FakeBrowser[] = [];
  const logs: string[] = [];
  const discovery = createAirplayDiscovery({
    outputs,
    state,
    log: (msg) => logs.push(msg),
    createBrowser: (onService) => {
      const b = new FakeBrowser();
      b.onService = onService;
      browsers.push(b);
      return b;
    },
  });
  return { outputs, state, browsers, logs, discovery };
}

/** The initial state.get resolves asynchronously. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

Deno.test('devtype mapping (OwnTone model strings → helper tokens)', () => {
  assertEquals(devtypeFromAm(undefined), 'apex1');
  assertEquals(devtypeFromAm('AirPort4,1'), 'apex2');
  assertEquals(devtypeFromAm('AirPort10,1'), 'apex3');
  assertEquals(devtypeFromAm('AppleTV5,3'), 'appletv4');
  assertEquals(devtypeFromAm('AppleTV3,1'), 'appletv');
  assertEquals(devtypeFromAm('AudioAccessory1,1'), 'homepod');
  assertEquals(devtypeFromAm('SomethingElse'), 'other');
});

Deno.test('TXT md/et parse like raop_device_cb', () => {
  assertEquals(wantedMetadataFromMd(undefined), 0);
  assertEquals(wantedMetadataFromMd(''), 0);
  assertEquals(wantedMetadataFromMd('0,1,2'), 7);
  assertEquals(wantedMetadataFromMd('2'), 4);
  assertEquals(supportsAuthSetupFromEt(undefined), false);
  assertEquals(supportsAuthSetupFromEt('0,3,5'), false);
  assertEquals(supportsAuthSetupFromEt('0,3,4,5'), true);
});

Deno.test('up registers with TXT-derived fields; down unregisters', async () => {
  const { outputs, browsers, discovery } = await setup();
  try {
    await settle();
    assertEquals(browsers.length, 1, 'browser starts (unset = on)');
    browsers[0].onService!('up', svc());

    const outputsList = outputs.list();
    assertEquals(outputsList.length, 1);
    const out = outputsList[0];
    assertEquals(out.id, ID);
    assertEquals(out.name, 'Kitchen ATV');
    assertEquals(out.type, 'AirPlay');
    assertEquals(out.selected, false);
    assertEquals(out.volume, 100);
    assertEquals(out.host, '192.168.1.50');
    assertEquals(out.port, 7000);
    assertEquals(out.devtype, 'appletv');
    assertEquals(out.encrypt, true);
    assertEquals(out.wantedMetadata, 7);
    assertEquals(out.supportsAuthSetup, false);
    assertEquals(out.requiresAuth, true);
    assertEquals(out.needsAuthKey, true);

    browsers[0].onService!('down', svc());
    assertEquals(outputs.list(), []);
  } finally {
    discovery.close();
  }
});

Deno.test('re-announcement updates host without wiping user state', async () => {
  const { outputs, browsers, discovery } = await setup();
  try {
    await settle();
    browsers[0].onService!('up', svc());
    outputs.update(ID, { selected: true, volume: 42 });
    outputs.update(ID, { needsAuthKey: false }); // PIN completed
    // The device moves (ethernet→wifi, DHCP change): same instance id,
    // new address. The record is replaced — never duplicated — and the
    // user's selection, volume, and PIN completion survive.
    browsers[0].onService!('up', svc({ address: '192.168.1.77' }));
    const out = outputs.get(ID)!;
    assertEquals(outputs.list().length, 1, 'no duplicate');
    assertEquals(out.host, '192.168.1.77', 'host refreshed');
    assertEquals(out.selected, true, 'selection preserved');
    assertEquals(out.volume, 42, 'volume preserved');
    assertEquals(out.needsAuthKey, false, 'PIN completion preserved');
    assertEquals(out.devtype, 'appletv');
  } finally {
    discovery.close();
  }
});

Deno.test('non-AirTunes (no UDP in tp) and odd instance names are skipped', async () => {
  const { outputs, browsers, logs, discovery } = await setup();
  try {
    await settle();
    browsers[0].onService!('up', svc({ txt: { tp: 'RAOP' } }));
    browsers[0].onService!('up', svc({ name: 'no-at-sign' }));
    browsers[0].onService!('up', svc({ name: '@no id' }));
    browsers[0].onService!('up', svc({ name: 'zz@bad hex' }));
    assertEquals(outputs.list(), []);
    assert(logs.some((l) => l.includes('no UDP in tp')));
    assert(logs.some((l) => l.includes('odd instance name')));
  } finally {
    discovery.close();
  }
});

Deno.test('manual registration wins the host; discovery does not duplicate', async () => {
  const { outputs, browsers, logs, discovery } = await setup();
  try {
    await settle();
    outputs.register({
      id: 'manual',
      name: 'Manual ATV',
      type: 'AirPlay',
      selected: false,
      volume: 100,
      host: '192.168.1.50',
    });
    browsers[0].onService!('up', svc());
    const list = outputs.list();
    assertEquals(list.length, 1);
    assertEquals(list[0].id, 'manual');
    assert(logs.some((l) => l.includes('host already owned')));
  } finally {
    discovery.close();
  }
});

Deno.test('toggle: off unregisters discovered and closes the browser; on rebrowses', async () => {
  const { outputs, state, browsers, discovery } = await setup();
  try {
    await settle();
    browsers[0].onService!('up', svc());
    assertEquals(outputs.list().length, 1);

    state.change('airplay.mdns', 'off');
    assertEquals(outputs.list(), []);
    assertEquals(browsers[0].closed, true);

    state.change('airplay.mdns', 'on');
    assertEquals(browsers.length, 2, 'a fresh browser starts');
  } finally {
    discovery.close();
  }
});

Deno.test('state preset off: no browser starts until flipped on', async () => {
  const { state, browsers, discovery } = await setup({ 'airplay.mdns': 'off' });
  try {
    await settle();
    assertEquals(browsers.length, 0);
    state.change('airplay.mdns', 'on');
    assertEquals(browsers.length, 1);
  } finally {
    discovery.close();
  }
});

Deno.test('discovery logs the OwnTone-shaped Adding AirPlay device line', async () => {
  const { browsers, logs, discovery } = await setup();
  try {
    await settle();
    browsers[0].onService!('up', svc());
    assert(
      logs.some((l) =>
        l.includes('Adding AirPlay device') &&
        l.includes('encrypt: 1') &&
        l.includes('authsetup: 0') &&
        l.includes('metadata: 7')
      ),
      `missing OwnTone-shaped line: ${logs.join(' | ')}`,
    );
  } finally {
    discovery.close();
  }
});

Deno.test('known-host resolve registers wantedMetadata from TXT', async () => {
  const { outputs, browsers, discovery } = await setup();
  try {
    await settle();
    const pending = discovery.resolve('192.168.1.50');
    await settle();
    assertEquals(browsers[0].resolved, ['192.168.1.50']);
    browsers[0].onService!('up', svc());
    const got = await pending;
    assertEquals(got?.txt.md, '0,1,2');
    const out = outputs.list().find((o) => o.host === '192.168.1.50');
    assertEquals(out?.wantedMetadata, 7);
  } finally {
    discovery.close();
  }
});

Deno.test('password-protected devices register with a warning', async () => {
  const { outputs, browsers, logs, discovery } = await setup();
  try {
    await settle();
    browsers[0].onService!('up', svc({ txt: { tp: 'UDP', pw: 'true' } }));
    assertEquals(outputs.list().length, 1);
    assert(logs.some((l) => l.includes('password')));
  } finally {
    discovery.close();
  }
});
