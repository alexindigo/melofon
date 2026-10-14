// tests/state.test.ts — app.state: CRUD, persistence across reopen,
// seedIfUnset never stomping an operator's choice, live onChange, and the
// /_/config endpoints (list + put) the Settings UI will form over.
import { assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openDb } from '../src/db.ts';
import { createState } from '../src/state.ts';
import { captureLogs } from './helpers/logging.ts';

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-state-' });
  const db = await openDb(dir);
  return {
    dir,
    db,
    close: async (keep = false) => {
      db.close();
      if (!keep) await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('state: get/set/list round-trip, onChange fires live', async () => {
  const { db, close } = await setup();
  try {
    const state = createState(db);
    assertEquals(await state.get('airplay.mdns'), null);

    const seen: [string, string][] = [];
    const off = state.onChange((key, value) => seen.push([key, value]));

    await state.set('airplay.mdns', 'off');
    assertEquals(await state.get('airplay.mdns'), 'off');
    assertEquals(seen, [['airplay.mdns', 'off']]);

    await state.set('lastfm.enabled', 'on');
    assertEquals(await state.list(), {
      'airplay.mdns': 'off',
      'lastfm.enabled': 'on',
    });

    off();
    await state.set('airplay.mdns', 'on');
    assertEquals(seen.length, 2, 'no events after unsubscribe');
  } finally {
    await close();
  }
});

Deno.test('state: persists across reopen; seedIfUnset never stomps', async () => {
  const { dir, db, close } = await setup();
  try {
    const state = createState(db);
    assertEquals(await state.seedIfUnset('airplay.mdns', 'off'), true);
    assertEquals(await state.get('airplay.mdns'), 'off');

    // The operator flips it on; a later seed must not stomp that.
    await state.set('airplay.mdns', 'on');
    assertEquals(await state.seedIfUnset('airplay.mdns', 'off'), false);
    assertEquals(await state.get('airplay.mdns'), 'on');

    // Reopen the same database file: values persist.
    db.close();
    const db2 = await openDb(dir);
    const state2 = createState(db2);
    assertEquals(await state2.get('airplay.mdns'), 'on');
    db2.close();
  } finally {
    await close(true);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('core /_/config: list and put', async () => {
  const { db, close } = await setup();
  try {
    const state = createState(db);
    const { log, records } = captureLogs();
    const core = await pathfinder({
      roots: ['core/'],
      app: { db, state, log },
    });

    const put = (key: string, body: string, json = true) =>
      core(
        new Request(`http://x/config/${key}`, {
          method: 'PUT',
          body,
          ...(json ? { headers: { 'content-type': 'application/json' } } : {}),
        }),
      );

    // Bad bodies 400.
    assertEquals((await put('airplay.mdns', 'not json', false)).status, 400);
    assertEquals((await put('airplay.mdns', '{}')).status, 400);
    assertEquals((await put('airplay.mdns', '{"value":1}')).status, 400);

    // Set → list reflects it; the onChange subscription fires.
    const seen: [string, string][] = [];
    state.onChange((key, value) => seen.push([key, value]));
    const res = await put('airplay.mdns', '{"value":"off"}');
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });
    assertEquals(seen, [['airplay.mdns', 'off']]);

    assertEquals(
      records().map((record) => [record.event, record.key, record.kind]),
      [['config_changed', 'airplay.mdns', 'http']],
    );

    const list = await core(new Request('http://x/config'));
    assertEquals(list.status, 200);
    assertEquals(await list.json(), { config: { 'airplay.mdns': 'off' } });
  } finally {
    await close();
  }
});
