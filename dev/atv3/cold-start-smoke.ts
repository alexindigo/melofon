// dev/atv3/cold-start-smoke.ts — owned throwaway-process cold-start smoke
// (plan atv3-session-recycle §6.2). Spawns exactly one main.ts child with a
// temporary data dir and its own log on throwaway loopback ports, then
// proves: the process boots into the recycle policy marker, /_/health is
// OK, the OwnTone /api/player wire shape is unchanged (eight keys, no
// last_command), and a volume PUT is attributed to its X-Melofon-Client.
// Native last-command JSON observes that same command without recording reads.
// Process/control proof only — it proves nothing about ATV audio.
//
//   deno run --allow-run --allow-net --allow-env --allow-read --allow-write \
//     --allow-ffi --allow-sys --node-modules-dir=auto \
//     dev/atv3/cold-start-smoke.ts
//
// Hard rules: never reads/writes the household DB, never binds household
// ports, fails (does not kill) when a port is occupied, terminates only its
// owned child by its process handle, removes only its own temp dir. The
// child gets clearEnv (only PATH/HOME survive) and NO --env flag, so no
// household configuration can leak in.

import { openDb } from '../../src/db.ts';
import { createPersistence } from '../../src/persistence.ts';
import { createState } from '../../src/state.ts';
import dgram from 'node:dgram';
import { dnsQuestions } from '../../src/mdns.ts';
import { airplayAnswer } from '../../tests/mdns-builder.ts';
import { startFakeRaop } from '../../tests/helpers/fake-raop.ts';
import { parseLogfmt } from '../../tests/helpers/logging.ts';

function logRecords(text: string): Record<string, string>[] {
  return text.split('\n').filter((line) => line.startsWith('time=')).map(
    parseLogfmt,
  );
}

const LISTEN = '127.0.0.1:14138';
const OWNTONE = [14689, 14688];
const BASE = `http://${LISTEN}`;
const OWNTONE_BASE = `http://127.0.0.1:${OWNTONE[0]}`;
const HEALTH_DEADLINE_MS = 30_000;
const nativeReceipts: unknown[] = [];

const repoRoot = decodeURIComponent(
  new URL('../../', import.meta.url).pathname,
);

function fail(msg: string): never {
  throw new Error(`cold-start smoke: FAIL — ${msg}`);
}

function assertPortFree(port: number): void {
  let probe: Deno.Listener;
  try {
    probe = Deno.listen({ hostname: '127.0.0.1', port });
  } catch (err) {
    fail(
      `port ${port} is occupied (${(err as Error).message}) — ` +
        'not killing its owner; free it yourself or stop',
    );
  }
  probe!.close();
}

// Preflight: every port must be free BEFORE anything spawns.
assertPortFree(14138);
for (const port of OWNTONE) assertPortFree(port);

async function sha256Hex(path: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    await Deno.readFile(path),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const raopLib = Deno.env.get('MELOFON_RAOP_LIB')?.trim() ||
  `${repoRoot}helper/raop/libmelofon_raop.so`;
const libHash = await sha256Hex(raopLib).catch(() =>
  fail(`candidate RAOP library unreadable: ${raopLib}`)
);
const lockHash = await sha256Hex(`${repoRoot}deno.lock`);

const dataDir = await Deno.makeTempDir({ prefix: 'melofon-smoke-data-' });
const workDir = await Deno.makeTempDir({ prefix: 'melofon-smoke-' });
const logPath = `${workDir}/child.log`;
const logFile = await Deno.open(logPath, { create: true, write: true });

const spawnedAt = Date.now();
const child = new Deno.Command(Deno.execPath(), {
  args: [
    'run',
    '--frozen',
    '--cached-only',
    '--allow-net',
    '--allow-env',
    '--allow-read',
    '--allow-write',
    '--allow-ffi',
    '--allow-sys',
    '--node-modules-dir=auto',
    'main.ts',
  ],
  cwd: repoRoot,
  clearEnv: true,
  env: {
    PATH: Deno.env.get('PATH') ?? '/usr/bin:/bin',
    HOME: Deno.env.get('HOME') ?? '/tmp',
    TMPDIR: Deno.env.get('TMPDIR') ?? '/tmp',
    MELOFON_LISTEN: LISTEN,
    MELOFON_LISTEN_owntone: OWNTONE.join(','),
    MELOFON_DATA: dataDir,
    MELOFON_AIRPLAY_MDNS: 'off',
    MELOFON_RAOP_LIB: raopLib,
    // Test-only auth values (never the household's).
    MELOFON_USER: 'smoke',
    MELOFON_PASSWORD: 'smoke',
    MELOFON_SECRET: 'smoke-secret',
  },
  stdout: 'piped',
  stderr: 'piped',
}).spawn();

// Tee both child streams into the owned log (also keeps the pipes drained).
const tees: Promise<void>[] = [];
for (const stream of [child.stdout, child.stderr]) {
  tees.push((async () => {
    for await (const chunk of stream) await logFile.write(chunk);
  })());
}

console.log(
  `cold-start smoke: pid=${child.pid} spawnedAt=${spawnedAt} log=${logPath}`,
);
console.log(`cold-start smoke: raopLib=${raopLib} sha256=${libHash}`);
console.log(`cold-start smoke: deno.lock sha256=${lockHash}`);

let done = false, stopped = false;
const stopChild = async () => {
  if (stopped) return;
  stopped = true;
  try {
    child.kill('SIGTERM');
  } catch { /* already gone */ }
  const deadline = performance.now() + 5_000;
  let status: Deno.CommandStatus | undefined;
  while (performance.now() < deadline) {
    status = await Promise.race([
      child.status,
      new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), 200)
      ),
    ]);
    if (status !== undefined) break;
  }
  if (status === undefined) {
    try {
      child.kill('SIGKILL');
    } catch { /* already gone */ }
    status = await child.status;
  }
  if (status.success === false && status.signal === undefined) {
    fail(`child exited abnormally: code=${status.code}`);
  }
};
const cleanup = async () => {
  if (done) return;
  done = true;
  try {
    await stopChild();
  } finally {
    await Promise.allSettled(tees);
    try {
      logFile.close();
    } catch { /* already closed */ }
    const evidence = Deno.env.get('MELOFON_LOGGING_EVIDENCE');
    if (evidence) {
      if (
        !evidence.startsWith(
          '/home/tester/melofon-output-preparation-01/shared-logging-01/evidence/',
        )
      ) fail('evidence outside owned guest workspace');
      await Deno.mkdir(evidence, { recursive: true, mode: 0o700 });
      await Deno.writeFile(
        `${evidence}/child.log`,
        await Deno.readFile(logPath),
        { createNew: true },
      );
      await Deno.writeTextFile(
        `${evidence}/native-last-command.json`,
        JSON.stringify(nativeReceipts, null, 2) + '\n',
        { createNew: true },
      );
    }
    await Deno.remove(workDir, { recursive: true });
    await Deno.remove(dataDir, { recursive: true });
  }
};

try {
  // Bounded wait for health.
  let healthy = false;
  const deadline = performance.now() + HEALTH_DEADLINE_MS;
  while (performance.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/_/health`);
      if (res.ok) {
        const body = await res.json();
        if (body?.ok === true) {
          healthy = true;
          break;
        }
      }
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!healthy) fail('never became healthy (see the child log)');

  const freshCommand = await fetch(`${BASE}/_/last-command`);
  if (
    !freshCommand.ok ||
    freshCommand.headers.get('cache-control') !== 'no-store'
  ) fail('fresh native last-command response/status/cache policy');
  const freshBody = await freshCommand.json();
  if (
    JSON.stringify(Object.keys(freshBody).sort()) !==
      JSON.stringify(['outputs', 'playback']) ||
    freshBody.playback !== null || freshBody.outputs !== null
  ) fail('fresh native last-command records were not independently null');
  nativeReceipts.push({ checkpoint: 'fresh', body: freshBody });

  // The marker is logged during boot, before listen; give the tee a moment.
  let markerSeen = false;
  for (let i = 0; i < 20 && !markerSeen; i++) {
    const log1 = await Deno.readTextFile(logPath);
    markerSeen = logRecords(log1).some((record) =>
      record.event === 'airplay_policy' &&
      record.policy === 'connection-strategies-v1'
    );
    if (!markerSeen) await new Promise((r) => setTimeout(r, 100));
  }
  if (!markerSeen) fail('the boot policy marker is missing from the child log');

  const DEFAULT_KEY = 'airplay.connectionStrategy.default';
  const config = await fetch(`${BASE}/_/config`);
  const configBody = await config.json();
  const values = configBody.config;
  if (values[DEFAULT_KEY] !== 'melofon') {
    fail('new-speaker strategy default not seeded');
  }
  const create = async (host: string) => {
    const response = await fetch(`${BASE}/_/outputs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'unselected smoke fake',
        type: 'AirPlay',
        host,
      }),
    });
    if (!response.ok) fail(`native output POST: ${response.status}`);
    return (await response.json()).output;
  };
  const first = await create('127.0.0.240');
  if (first.connectionStrategy !== 'melofon' || first.selected) {
    fail('first output default/selection wrong');
  }
  if (first.preparation.state === 'ready') {
    fail('bare registration manufactured receiver readiness');
  }
  const choice = await fetch(`${BASE}/_/outputs/${first.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ connectionStrategy: 'audiostation' }),
  });
  if (
    !choice.ok ||
    (await choice.json()).output.connectionStrategy !== 'audiostation'
  ) fail('native per-output choice failed');
  const global = await fetch(`${BASE}/_/config/${DEFAULT_KEY}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'owntone' }),
  });
  if (!global.ok) fail('global strategy PUT failed');
  await global.body?.cancel();
  const second = await create('127.0.0.241');
  if (second.connectionStrategy !== 'owntone' || second.selected) {
    fail('new-output-only default failed');
  }
  const list = await fetch(`${BASE}/_/outputs`);
  const rows = (await list.json()).outputs;
  if (
    rows.find((row: { id: string }) => row.id === first.id)
      ?.connectionStrategy !== 'audiostation'
  ) fail('global change rewrote existing choice');

  const player = await fetch(`${OWNTONE_BASE}/api/player`);
  if (!player.ok) fail(`GET /api/player: ${player.status}`);
  const keys = Object.keys(await player.json()).sort();
  const expected = [
    'consume',
    'item_id',
    'item_length_ms',
    'item_progress_ms',
    'repeat',
    'shuffle',
    'state',
    'volume',
  ].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    fail(`OwnTone /api/player keys changed: ${keys.join(',')}`);
  }

  const commandStartedAt = Date.now();
  const put = await fetch(`${OWNTONE_BASE}/api/player/volume?volume=75`, {
    method: 'PUT',
    headers: {
      'X-Melofon-Client': 'atv3-smoke',
      'User-Agent': 'melofon-atv3-smoke',
    },
  });
  if (put.status !== 204) fail(`PUT volume: ${put.status}`);
  await put.body?.cancel();
  const commandFinishedAt = Date.now();
  let previousNative: string | undefined;
  for (let read = 0; read < 2; read++) {
    const response = await fetch(`${BASE}/_/last-command`, {
      headers: { 'X-Melofon-Client': 'atv3-observer' },
    });
    if (!response.ok || response.headers.get('cache-control') !== 'no-store') {
      fail('post-volume native last-command status/cache policy');
    }
    const body = await response.json();
    const command = body.playback;
    if (
      JSON.stringify(Object.keys(body).sort()) !==
        JSON.stringify(['outputs', 'playback']) ||
      !command || command.kind !== 'volume' || command.detail !== 'volume=75' ||
      command.intent !== 'none' || command.queueCleared !== false ||
      typeof command.atMs !== 'number' || command.atMs < commandStartedAt ||
      command.atMs > commandFinishedAt ||
      JSON.stringify(command.source) !== JSON.stringify({
          kind: 'http',
          peer: '127.0.0.1',
          userAgent: 'melofon-atv3-smoke',
          client: 'atv3-smoke',
        }) ||
      JSON.stringify(Object.keys(command).sort()) !== JSON.stringify([
          'atMs',
          'detail',
          'intent',
          'kind',
          'queueCleared',
          'source',
        ]) ||
      body.outputs?.kind !== 'register' ||
      body.outputs?.source.kind !== 'http' ||
      body.outputs?.source.peer !== '127.0.0.1' ||
      JSON.stringify(Object.keys(body.outputs).sort()) !==
        JSON.stringify(['kind', 'source'])
    ) {
      fail(
        'native JSON did not report the actual volume/current output records',
      );
    }
    const encoded = JSON.stringify(body);
    if (previousNative !== undefined && encoded !== previousNative) {
      fail('observer GET overwrote the latest command');
    }
    previousNative = encoded;
    nativeReceipts.push({ checkpoint: `volume-read-${read + 1}`, body });
  }
  const volumeState = await (await fetch(`${OWNTONE_BASE}/api/player`)).json();
  if (
    JSON.stringify(Object.keys(volumeState).sort()) !==
      JSON.stringify(expected) ||
    volumeState.volume !== 75 || volumeState.state !== 'stop'
  ) fail('native reads changed OwnTone volume/state/wire keys');
  nativeReceipts.push({ checkpoint: 'owntone-after-reads', body: volumeState });
  console.log(
    'cold-start smoke: native last-command fresh nulls and volume/client JSON observed; two reads preserved provenance and OwnTone volume/state',
  );
  // The [cmd] line attributes the client.
  let attributed = false;
  for (let i = 0; i < 20 && !attributed; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const log = await Deno.readTextFile(logPath);
    attributed = logRecords(log).some((record) =>
      record.event === 'command' && record.command === 'volume' &&
      record.client === 'atv3-smoke' && JSON.parse(record.facts).volume === 75
    );
  }
  if (!attributed) fail('the volume command was not attributed in the log');

  const wireOutputs = await fetch(`${OWNTONE_BASE}/api/outputs`);
  if (!wireOutputs.ok) fail(`OwnTone outputs: ${wireOutputs.status}`);
  const projected = (await wireOutputs.json()).outputs;
  const outputKeys = [
    'format',
    'has_password',
    'id',
    'name',
    'needs_auth_key',
    'offset_ms',
    'requires_auth',
    'selected',
    'supported_formats',
    'type',
    'volume',
  ].sort();
  if (
    projected.length !== 2 ||
    projected.some((row: Record<string, unknown>) =>
      JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(outputKeys)
    )
  ) {
    fail('OwnTone output wire keys changed');
  }
  // Stop the only writer before reopening its real on-disk database. These
  // are public persistence consumers, not a second connection to a live DB.
  await stopChild();
  const reopened = await openDb(dataDir);
  try {
    const stored = createPersistence(reopened);
    const saved = await stored.loadOutputs();
    if (
      saved.find((row) => row.id === first.id)?.connectionStrategy !==
        'audiostation' ||
      saved.find((row) => row.id === second.id)?.connectionStrategy !==
        'owntone'
    ) {
      fail('native settings did not survive disk reopen');
    }
    if (await createState(reopened).get(DEFAULT_KEY) !== 'owntone') {
      fail('global default did not survive disk reopen');
    }
  } finally {
    reopened.close();
  }
  console.log(
    'cold-start smoke: native strategies survived disk reopen; OwnTone player/output keys unchanged',
  );

  console.log('cold-start smoke: OK');
} finally {
  await cleanup();
}

// Real composition-root proof: env registration prepares with browsing off;
// a later process restores preferences without treating disk identity as facts.
const prepData = await Deno.makeTempDir({ prefix: 'melofon-prep-smoke-data-' });
const prepWork = await Deno.makeTempDir({ prefix: 'melofon-prep-smoke-' });
const receiver = await startFakeRaop();
const dns = dgram.createSocket('udp4');
let prepChild: Deno.ChildProcess | undefined;
let pumps: Promise<void>[] = [];
let prepLog: Deno.FsFile | undefined;
let queries = 0;
const stopPreparationChild = async () => {
  if (!prepChild) return;
  const owned = prepChild;
  prepChild = undefined;
  try {
    owned.kill('SIGTERM');
  } catch { /* already exited */ }
  const status = await Promise.race([
    owned.status,
    new Promise<undefined>((r) => setTimeout(() => r(undefined), 5000)),
  ]);
  if (status === undefined) {
    try {
      owned.kill('SIGKILL');
    } catch { /* already exited */ }
    await owned.status;
  }
  await Promise.allSettled(pumps);
  prepLog?.close();
  prepLog = undefined;
};
const launchPreparationChild = async (envRegistration: boolean) => {
  assertPortFree(14138);
  for (const port of OWNTONE) assertPortFree(port);
  prepLog = await Deno.open(
    `${prepWork}/${envRegistration ? 'env' : 'restore'}.log`,
    { createNew: true, write: true },
  );
  const log = prepLog;
  prepChild = new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--frozen',
      '--cached-only',
      '--allow-net',
      '--allow-env',
      '--allow-read',
      '--allow-write',
      '--allow-ffi',
      '--allow-sys',
      '--node-modules-dir=auto',
      'main.ts',
    ],
    cwd: repoRoot,
    clearEnv: true,
    env: {
      PATH: Deno.env.get('PATH') ?? '/usr/bin:/bin',
      HOME: Deno.env.get('HOME') ?? '/tmp',
      TMPDIR: Deno.env.get('TMPDIR') ?? '/tmp',
      MELOFON_LISTEN: LISTEN,
      MELOFON_LISTEN_owntone: OWNTONE.join(','),
      MELOFON_DATA: prepData,
      MELOFON_AIRPLAY_MDNS: 'off',
      MELOFON_RAOP_LIB: raopLib,
      MELOFON_USER: 'smoke',
      MELOFON_PASSWORD: 'smoke',
      MELOFON_SECRET: 'smoke-secret',
      ...(envRegistration
        ? { MELOFON_AIRPLAY_HOST: `127.0.0.1:${receiver.port}` }
        : {}),
    },
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  pumps = [prepChild.stdout, prepChild.stderr].map((stream) =>
    (async () => {
      for await (const chunk of stream) await log.write(chunk);
    })()
  );
  const deadline = performance.now() + HEALTH_DEADLINE_MS;
  while (performance.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/_/health`);
      if (response.ok && (await response.json()).ok === true) return;
    } catch { /* startup in flight */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  fail('preparation child failed to boot');
};
try {
  // Do not substitute another port or kill a service if this fixture bind fails.
  await new Promise<void>((resolve, reject) => {
    dns.once('error', reject);
    dns.bind(5353, '127.0.0.1', resolve);
  });
  dns.on('message', (message, peer) => {
    const questions = dnsQuestions(message);
    if (!questions || (message[2] & 0x80) !== 0) return;
    queries++;
    const id = new DataView(message.buffer, message.byteOffset).getUint16(0);
    dns.send(
      airplayAnswer({
        instance: '001122334455@Env Fixture._raop._tcp.local',
        host: 'env-fixture.local',
        address: [127, 0, 0, 1],
        port: receiver.port,
        ttl: 10,
        txt: ['tp=UDP', 'am=AppleTV3,1', 'md=0,1,2'],
        id,
        questions,
      }),
      peer.port,
      peer.address,
    );
  });
  await launchPreparationChild(true);
  const envRows = (await (await fetch(`${BASE}/_/outputs`)).json()).outputs;
  if (
    envRows.length !== 1 || envRows[0].preparation.state !== 'ready' ||
    envRows[0].model !== 'AppleTV3,1' || queries < 1 ||
    receiver.sessions.length !== 0
  ) fail('env path did not prepare without creating a session');
  const selected = await fetch(`${OWNTONE_BASE}/api/outputs/${envRows[0].id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selected: true, volume: 42 }),
  });
  if (selected.status !== 204) fail('saved selection command failed');
  await selected.body?.cancel();
  await new Promise((r) => setTimeout(r, 100));
  await stopPreparationChild();
  const queriesBefore = queries;
  await launchPreparationChild(false);
  const restored = (await (await fetch(`${BASE}/_/outputs`)).json()).outputs;
  if (
    restored.length !== 1 || !restored[0].selected ||
    restored[0].volume !== 42 || restored[0].model !== 'AppleTV3,1' ||
    restored[0].preparation.state !== 'unresolved' ||
    receiver.sessions.length !== 0 || queries !== queriesBefore
  ) fail('restore manufactured capabilities or discarded saved preferences');
  console.log(
    'cold-start smoke: env path ready via unicast with browse off; restore retained preferences but not a prepared permit; zero RTSP sessions',
  );
  console.log('cold-start smoke: preparation OK');
} finally {
  await stopPreparationChild();
  try {
    dns.close();
  } catch { /* fixture bind failed */ }
  receiver.close();
  await Deno.remove(prepWork, { recursive: true });
  await Deno.remove(prepData, { recursive: true });
}
