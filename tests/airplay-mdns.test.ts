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
import { createNotify } from '../src/notify.ts';
import { createOutputs } from '../src/player.ts';
import type { State } from '../src/state.ts';
import { createAirplayDevices } from '../src/boots/airplay-device.ts';
import { recordingSpawn } from './helpers/airplay-devices.ts';

const INSTANCE = 'A4B2C1D2E3F4@Kitchen ATV._raop._tcp.local';
const ID = BigInt('0xA4B2C1D2E3F4').toString(10);

function fakeState(initial: Record<string, string> = {}): State & {
  change(key: string, value: string): void;
} {
  const store = new Map(Object.entries(initial));
  const listeners = new Set<(key: string, value: string) => void>();
  return {
    declare() {},
    getTyped: (key) => Promise.resolve(store.get(key)),
    getWithRevision: (key) =>
      Promise.resolve({ value: store.get(key) ?? null, revision: 0 }),
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

function setup(
  initial: Record<string, string> = {},
  saved: Record<string, { selected: boolean; volume: number; model?: string }> =
    {},
) {
  const notify = createNotify();
  const outputs = createOutputs({ notify });
  const state = fakeState(initial);
  const browsers: FakeBrowser[] = [];
  const logs: string[] = [];
  const resolved: string[] = [];
  const commands: Record<string, unknown>[] = [];
  const devices = createAirplayDevices({
    outputs,
    resolver: {
      resolve(address) {
        resolved.push(address);
        return Promise.resolve(svc({ address }));
      },
      close() {},
    },
    spawn: recordingSpawn(() => ({
      send(command) {
        commands.push(command);
        return Promise.resolve();
      },
      pcm: () => Promise.resolve(),
      close: () => Promise.resolve(),
      ownsSharedFeed: () => false,
      cancelPcm() {},
    })),
  });
  const session = async (id: string) => {
    const permit = await devices.protocol.prepare({
      id,
      targetRevision: devices.admission.describe(id).targetRevision,
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    assert(permit.ok);
    const active = await devices.protocol.activate(permit.value, {
      volume: 1,
      positionMs: 0,
      lengthMs: 1,
      title: '',
      artist: '',
    }, { publish() {}, onEvent() {} });
    assert(active.ok);
    await active.value.close();
    return commands.at(-1)!;
  };
  const discovery = createAirplayDiscovery({
    outputs,
    state,
    devices,
    savedOutput: (id) => saved[id],
    log: {
      event: (event, facts) => logs.push(JSON.stringify({ event, ...facts })),
    },
    createBrowser: (onService) => {
      const b = new FakeBrowser();
      b.onService = onService;
      browsers.push(b);
      return b;
    },
  });
  return {
    outputs,
    state,
    browsers,
    logs,
    discovery,
    notify,
    devices,
    resolved,
    session,
  };
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
  const { outputs, browsers, discovery, session } = await setup();
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
    const prepared = await session(out.id);
    assertEquals(prepared.devtype, 'appletv');
    assertEquals(prepared.encrypt, true);
    assertEquals(prepared.wanted_metadata, 7);
    assertEquals(prepared.authsetup, 0);
    assertEquals(out.requiresAuth, true);
    assertEquals(out.needsAuthKey, true);
    assertEquals(out.model, 'AppleTV3,1', 'TXT am is the output identity');

    browsers[0].onService!('down', svc());
    assertEquals(outputs.list(), []);
  } finally {
    discovery.close();
  }
});

Deno.test('re-announcement updates host without wiping user state', async () => {
  const { outputs, browsers, discovery, session } = await setup();
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
    assertEquals((await session(out.id)).devtype, 'appletv');
  } finally {
    discovery.close();
  }
});

Deno.test('a device coming back unregistered registers with the saved selection', async () => {
  // No in-memory record (mDNS down→up, or a restart before the row
  // re-registers): the persisted user state wins over discovery defaults.
  const { outputs, browsers, discovery, session } = await setup({}, {
    [ID]: { selected: true, volume: 42 },
  });
  try {
    await settle();
    browsers[0].onService!('up', svc());
    const out = outputs.get(ID)!;
    assertEquals(out.selected, true, 'saved selection applied');
    assertEquals(out.volume, 42, 'saved volume applied');
    assertEquals(out.host, '192.168.1.50', 'announcement refreshes the host');
    assertEquals(out.port, 7000);
    assertEquals(
      (await session(out.id)).devtype,
      'appletv',
      'TXT knobs still derived',
    );

    // Without a saved row the discovery defaults stand.
    browsers[0].onService!('down', svc());
    browsers[0].onService!(
      'up',
      svc({ name: '001122334455@Patio._raop._tcp.local' }),
    );
    const patio = outputs.get(BigInt('0x001122334455').toString(10))!;
    assertEquals(patio.selected, false);
    assertEquals(patio.volume, 100);
  } finally {
    discovery.close();
  }
});

Deno.test('an identical re-announcement is a catalog no-op', async () => {
  const { outputs, browsers, logs, discovery, notify, session } = await setup();
  try {
    await settle();
    let outputsEvents = 0;
    notify.subscribe((types) => {
      if (types.includes('outputs')) outputsEvents++;
    });
    browsers[0].onService!('up', svc());
    assertEquals(outputs.list().length, 1);
    assertEquals(outputsEvents, 1, 'the first announcement registers');
    const logsAfterFirst = logs.length;

    // Same instance, same address, same TXT: nothing changed, no register,
    // no outputs event, no log line — chatty devices stay quiet.
    browsers[0].onService!('up', svc());
    browsers[0].onService!('up', svc());
    assertEquals(outputsEvents, 1, 'identical ups fired no outputs event');
    assertEquals(logs.length, logsAfterFirst, 'identical ups logged nothing');

    // A changed TXT (metadata knobs) is a real catalog update.
    browsers[0].onService!('up', svc({ txt: { ...svc().txt, md: '0,1' } }));
    assertEquals(outputsEvents, 2, 'changed TXT registers');
    assertEquals((await session(ID)).wanted_metadata, 3);
  } finally {
    discovery.close();
  }
});

Deno.test('a changed model is a real catalog update even within one devtype', async () => {
  const { outputs, browsers, discovery, notify, session } = await setup();
  try {
    await settle();
    let outputsEvents = 0;
    notify.subscribe((types) => {
      if (types.includes('outputs')) outputsEvents++;
    });
    // AppleTV2,1 and AppleTV3,1 both map to devtype appletv: the model
    // change alone must register.
    browsers[0].onService!(
      'up',
      svc({ txt: { ...svc().txt, am: 'AppleTV2,1' } }),
    );
    assertEquals(outputs.get(ID)!.model, 'AppleTV2,1');
    assertEquals((await session(ID)).devtype, 'appletv');
    assertEquals(outputsEvents, 1);

    browsers[0].onService!('up', svc()); // am AppleTV3,1
    assertEquals(outputsEvents, 2, 'the model replacement registers');
    assertEquals(outputs.get(ID)!.model, 'AppleTV3,1');
    assertEquals((await session(ID)).devtype, 'appletv', 'devtype unchanged');

    // Same model, same everything: a no-op again.
    browsers[0].onService!('up', svc());
    assertEquals(outputsEvents, 2, 'same-model re-announce stays quiet');
  } finally {
    discovery.close();
  }
});

Deno.test('a re-announcement without am recovers the saved model identity', async () => {
  // No in-memory record; the persisted row knows the model. A TXT without
  // `am` neither erases nor hides it (plan atv3-session-recycle).
  const { outputs, browsers, discovery, session } = await setup({}, {
    [ID]: { selected: true, volume: 42, model: 'AppleTV3,1' },
  });
  try {
    await settle();
    browsers[0].onService!(
      'up',
      svc({
        txt: { tp: 'UDP', ek: '1', sf: '0x200', md: '0,1,2', et: '0,3,5' },
      }),
    );
    const out = outputs.get(ID)!;
    assertEquals(out.model, 'AppleTV3,1', 'saved identity recovered');
    assertEquals(out.selected, true, 'saved selection applied');
    assertEquals(out.volume, 42, 'saved volume applied');
    assertEquals(
      (await session(out.id)).devtype,
      'apex1',
      'session knobs re-derive from the actual TXT',
    );
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
    assert(logs.some((l) => JSON.parse(l).reason === 'no_udp'));
    assert(logs.some((l) => JSON.parse(l).reason === 'name'));
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
    assert(logs.some((l) => JSON.parse(l).reason === 'host_owned'));
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

Deno.test('discovery supplies receiver configuration facts to shared logging', async () => {
  const { browsers, logs, discovery } = await setup();
  try {
    await settle();
    browsers[0].onService!('up', svc());
    assert(
      logs.some((l) =>
        JSON.parse(l).event === 'discovery_device' &&
        JSON.parse(l).encrypt === true &&
        JSON.parse(l).authsetup === false &&
        JSON.parse(l).metadata === 7
      ),
      `missing discovery configuration: ${logs.join(' | ')}`,
    );
  } finally {
    discovery.close();
  }
});

Deno.test('known-host preparation derives metadata while automatic browsing is off', async () => {
  const { browsers, discovery, devices, resolved, session } = await setup({
    'airplay.mdns': 'off',
  });
  try {
    await settle();
    const out = await devices.registerAddress({
      name: 'Kitchen ATV',
      host: '192.168.1.50',
    });
    assert(out);
    assertEquals(browsers.length, 0);
    assertEquals(resolved, ['192.168.1.50']);
    assertEquals((await session(out.id)).wanted_metadata, 7);
  } finally {
    discovery.close();
    devices.close();
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
