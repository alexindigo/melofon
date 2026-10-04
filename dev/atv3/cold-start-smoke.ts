// dev/atv3/cold-start-smoke.ts — owned throwaway-process cold-start smoke
// (plan atv3-session-recycle §6.2). Spawns exactly one main.ts child with a
// temporary data dir and its own log on throwaway loopback ports, then
// proves: the process boots into the recycle policy marker, /_/health is
// OK, the OwnTone /api/player wire shape is unchanged (eight keys, no
// last_command), and a volume PUT is attributed to its X-Melofon-Client.
// Startup proof only — it proves nothing about ATV audio.
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

const LISTEN = '127.0.0.1:14138';
const OWNTONE = [14689, 14688];
const BASE = `http://${LISTEN}`;
const OWNTONE_BASE = `http://127.0.0.1:${OWNTONE[0]}`;
const HEALTH_DEADLINE_MS = 30_000;

const repoRoot = decodeURIComponent(
  new URL('../../', import.meta.url).pathname,
);

function fail(msg: string): never {
  console.error(`cold-start smoke: FAIL — ${msg}`);
  Deno.exit(1);
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

let done = false;
const cleanup = async () => {
  if (done) return;
  done = true;
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
  await Promise.allSettled(tees);
  try {
    logFile.close();
  } catch { /* already closed */ }
  await Deno.remove(workDir, { recursive: true });
  await Deno.remove(dataDir, { recursive: true });
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

  // The marker is logged during boot, before listen; give the tee a moment.
  let markerSeen = false;
  for (let i = 0; i < 20 && !markerSeen; i++) {
    const log1 = await Deno.readTextFile(logPath);
    markerSeen = log1.includes('policy=atv3-recycle-v1');
    if (!markerSeen) await new Promise((r) => setTimeout(r, 100));
  }
  if (!markerSeen) fail('the boot policy marker is missing from the child log');

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

  const put = await fetch(`${OWNTONE_BASE}/api/player/volume?volume=75`, {
    method: 'PUT',
    headers: { 'X-Melofon-Client': 'atv3-smoke' },
  });
  if (put.status !== 204) fail(`PUT volume: ${put.status}`);
  await put.body?.cancel();
  // The [cmd] line attributes the client.
  let attributed = false;
  for (let i = 0; i < 20 && !attributed; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const log = await Deno.readTextFile(logPath);
    attributed = /\[cmd\] volume volume=75 .*client=atv3-smoke/.test(log);
  }
  if (!attributed) fail('the volume command was not attributed in the log');

  console.log('cold-start smoke: OK');
} finally {
  await cleanup();
}
