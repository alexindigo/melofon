// tests/outputs.test.ts — the core /_/outputs CRUD (operator-registered
// outputs, M6 AirPlay first): validation, host-stable all-digit ids,
// idempotent re-register, list, delete.
import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { createOutputs } from '../src/player.ts';
import type { MdnsService } from '../src/mdns.ts';
import { createAirplayDevices } from '../src/boots/airplay-device.ts';
import { PreparationError } from '../src/output-admission.ts';

async function setup() {
  const outputs = createOutputs();
  const airplay = createAirplayDevices({
    outputs,
    resolver: {
      resolve: () =>
        Promise.reject(new PreparationError('timeout', 'fixture timeout')),
      close() {},
    },
    spawn: () => {
      throw new Error('CRUD cannot start a transport');
    },
  });
  const core = await pathfinder({
    roots: ['core/'],
    app: { cfg: {}, outputs, airplay, outputAdmission: airplay.admission },
  });
  return { core, outputs };
}

const post = (
  core: (req: Request) => Promise<Response>,
  body: string,
  json = true,
) =>
  core(
    new Request('http://x/outputs', {
      method: 'POST',
      body,
      ...(json ? { headers: { 'content-type': 'application/json' } } : {}),
    }),
  );

Deno.test('core /_/outputs POST validates the body', async () => {
  const { core } = await setup();
  assertEquals((await post(core, 'not json', false)).status, 400);
  assertEquals((await post(core, '{}')).status, 400);
  assertEquals(
    (await post(core, JSON.stringify({ type: 'AirPlay', host: 'h' }))).status,
    400,
  );
  assertEquals(
    (await post(
      core,
      JSON.stringify({ name: 'x', type: 'Chromecast', host: 'h' }),
    )).status,
    400,
  );
  assertEquals(
    (await post(core, JSON.stringify({ name: 'x', type: 'AirPlay' }))).status,
    400,
  );
  assertEquals(
    (await post(
      core,
      JSON.stringify({ name: 'x', type: 'AirPlay', host: 'h', port: -1 }),
    )).status,
    400,
  );
});

Deno.test('core /_/outputs register/list/delete round-trip', async () => {
  const { core } = await setup();
  const res = await post(
    core,
    JSON.stringify({
      name: 'Kitchen ATV',
      type: 'AirPlay',
      host: '192.0.2.10',
    }),
  );
  assertEquals(res.status, 200);
  const { output } = (await res.json()) as {
    output: {
      id: string;
      name: string;
      type: string;
      selected: boolean;
      volume: number;
      host: string;
    };
  };
  assertEquals(output.name, 'Kitchen ATV');
  assertEquals(output.type, 'AirPlay');
  assertEquals(output.selected, false);
  assertEquals(output.volume, 100);
  assertEquals(output.host, '192.0.2.10');
  // Stable from the host, all digits (the OwnTone wire id regex is /^\d+$/).
  assert(/^\d+$/.test(output.id));

  // Re-registering the same host is idempotent (last-wins on the name).
  const again = await post(
    core,
    JSON.stringify({ name: 'Kitchen', type: 'AirPlay', host: '192.0.2.10' }),
  );
  assertEquals(
    ((await again.json()) as { output: { id: string } }).output.id,
    output.id,
  );

  const listed = await core(new Request('http://x/outputs'));
  assertEquals(listed.status, 200);
  const body = (await listed.json()) as {
    outputs: { id: string; name: string }[];
  };
  assertEquals(body.outputs.length, 1);
  assertEquals(body.outputs[0].name, 'Kitchen');

  // A different host is a different output.
  const other = await post(
    core,
    JSON.stringify({
      name: 'Office',
      type: 'AirPlay',
      host: '192.0.2.20',
      port: 5000,
    }),
  );
  const otherOut = ((await other.json()) as {
    output: { id: string; port: number };
  }).output;
  assertNotEquals(otherOut.id, output.id);
  assertEquals(otherOut.port, 5000);

  const gone = await core(
    new Request(`http://x/outputs/${output.id}`, { method: 'DELETE' }),
  );
  assertEquals(gone.status, 200);
  const unknown = await core(
    new Request(`http://x/outputs/${output.id}`, { method: 'DELETE' }),
  );
  assertEquals(unknown.status, 404);
  const after = await core(new Request('http://x/outputs'));
  assertEquals(
    ((await after.json()) as { outputs: unknown[] }).outputs.length,
    1,
  );
});

Deno.test('core /_/outputs copies TXT when unicast resolve answers', async () => {
  const outputs = createOutputs();
  const svc: MdnsService = {
    name: 'A4B2C1D2E3F4@Kitchen ATV._raop._tcp.local',
    host: 'kitchen-atv.local',
    port: 7000,
    address: '10.4.10.106',
    txt: { tp: 'UDP', am: 'AppleTV3,1', md: '0,1,2', ek: '1' },
    ttlMs: 120_000,
  };
  const airplay = createAirplayDevices({
    outputs,
    resolver: {
      resolve: (address) => {
        assertEquals(address, '10.4.10.106');
        return Promise.resolve(svc);
      },
      close() {},
    },
    spawn: () => {
      throw new Error('CRUD cannot start');
    },
  });
  const core = await pathfinder({
    roots: ['core/'],
    app: {
      cfg: {},
      outputs,
      airplay,
      outputAdmission: airplay.admission,
    },
  });
  const res = await post(
    core,
    JSON.stringify({
      name: 'arbat',
      type: 'AirPlay',
      host: '10.4.10.106',
    }),
  );
  assertEquals(res.status, 200);
  const { output } = (await res.json()) as {
    output: { id: string; host: string; preparation: { state: string } };
  };
  assertEquals(output.host, '10.4.10.106');
  assertEquals(output.preparation.state, 'ready');
  assertEquals(airplay.admission.describe(output.id).source, 'dns-sd');
});

Deno.test('core /_/outputs re-registration: model preserved on timeout, replaced by a fresh am', async () => {
  const outputs = createOutputs();
  const atv3: MdnsService = {
    name: 'A4B2C1D2E3F4@arbat._raop._tcp.local',
    host: 'arbat.local',
    port: 7000,
    address: '10.4.10.106',
    txt: { tp: 'UDP', am: 'AppleTV3,1', md: '0,1,2' },
    ttlMs: 120_000,
  };
  let answer: MdnsService | null = atv3;
  const airplay = createAirplayDevices({
    outputs,
    resolver: {
      resolve: () =>
        answer
          ? Promise.resolve(answer)
          : Promise.reject(new PreparationError('timeout', 'fixture timeout')),
      close() {},
    },
    spawn: () => {
      throw new Error('CRUD cannot start');
    },
  });
  const core = await pathfinder({
    roots: ['core/'],
    app: {
      cfg: {},
      outputs,
      airplay,
      outputAdmission: airplay.admission,
    },
  });
  const body = JSON.stringify({
    name: 'arbat',
    type: 'AirPlay',
    host: '10.4.10.106',
  });

  const first = await post(core, body);
  assertEquals(first.status, 200);
  const firstOut = (await first.json()) as {
    output: { id: string; model?: string };
  };
  // Melofon's own CRUD surface may carry the model (never the OwnTone wire).
  assertEquals(firstOut.output.model, 'AppleTV3,1', 'TXT am is identity');
  const id = firstOut.output.id;

  // Resolve times out (null): the known model survives — no new parameter.
  answer = null;
  const second = await post(core, body);
  assertEquals(second.status, 200);
  assertEquals(outputs.get(id)!.model, 'AppleTV3,1', 'timeout keeps identity');

  // A fresh, different explicit model replaces the old one.
  answer = { ...atv3, txt: { ...atv3.txt, am: 'AppleTV2,1' } };
  const third = await post(core, body);
  assertEquals(third.status, 200);
  assertEquals(
    outputs.get(id)!.model,
    'AppleTV2,1',
    'an explicit different model wins',
  );
  assertEquals(airplay.admission.describe(id).state, 'ready');
});

Deno.test('core /_/outputs/<id>/pin delivers the pin to the boot', async () => {
  const { core, outputs } = await setup();
  const res = await post(
    core,
    JSON.stringify({
      name: 'Kitchen ATV',
      type: 'AirPlay',
      host: '192.0.2.10',
    }),
  );
  const { output } = (await res.json()) as { output: { id: string } };

  const pins: [string, string][] = [];
  outputs.onCommand((id, cmd) => {
    if (cmd.pin !== undefined) pins.push([id, cmd.pin]);
  });

  const ok = await core(
    new Request(`http://x/outputs/${output.id}/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: '1234' }),
    }),
  );
  assertEquals(ok.status, 200);
  assertEquals(pins, [[output.id, '1234']]);

  const unknown = await core(
    new Request('http://x/outputs/999/pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: '1234' }),
    }),
  );
  assertEquals(unknown.status, 404);
  const empty = await core(
    new Request(`http://x/outputs/${output.id}/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: '' }),
    }),
  );
  assertEquals(empty.status, 400);
});
