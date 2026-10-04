// dev/atv3/observe-live.ts — read-only live observation of a running
// candidate process (plan atv3-session-recycle §6.3). It NEVER launches or
// kills a process and NEVER sends a playback mutation: GET requests only,
// /proc reads only.
//
//   deno run --allow-net --allow-read --allow-sys dev/atv3/observe-live.ts \
//     --pid "$MELOFON_PID" --log "$MELOFON_LOG" --base-url "$MELOFON_URL" \
//     --output-id "$ARBAT_ID" --not-before-ms "$CANDIDATE_LAUNCH_FLOOR_MS" \
//     --seconds 900
//
// Preflight proves the process under observation is the candidate (its own
// cmdline/cwd, start time after the recorded floor, the candidate RAOP
// library mapped — not (deleted) — with the on-disk inode matching, the
// policy marker in its log, and the affected output's model identity on the
// Melofon-native surface with no extra OwnTone fields). If any proof fails
// the tool refuses to observe: nobody should test a stale process.

interface Args {
  pid: number;
  log: string;
  baseUrl: string;
  outputId: string;
  notBeforeMs: number;
  seconds: number;
}

function parseArgs(): Args {
  const args = new Map<string, string>();
  // Deno.args starts at the first CLI argument (no node/script entries).
  for (let i = 0; i < Deno.args.length; i += 2) {
    if (!Deno.args[i].startsWith('--') || i + 1 >= Deno.args.length) {
      fail(`bad argv at ${Deno.args[i]}`);
    }
    args.set(Deno.args[i].slice(2), Deno.args[i + 1]);
  }
  const num = (name: string): number => {
    const raw = args.get(name);
    if (raw === undefined || !/^\d+$/.test(raw)) {
      fail(`--${name} must be a non-negative integer`);
    }
    return Number(raw);
  };
  const str = (name: string): string => {
    const raw = args.get(name);
    if (raw === undefined || raw.trim() === '') fail(`--${name} is required`);
    return raw;
  };
  return {
    pid: num('pid'),
    log: str('log'),
    baseUrl: str('base-url').replace(/\/+$/, ''),
    outputId: str('output-id'),
    notBeforeMs: num('not-before-ms'),
    seconds: num('seconds'),
  };
}

function fail(msg: string): never {
  console.error(`observe-live: FAIL — ${msg}`);
  Deno.exit(1);
}

const args = parseArgs();
const repoRoot = decodeURIComponent(
  new URL('../../', import.meta.url).pathname,
);
const candidateLib = `${repoRoot}helper/raop/libmelofon_raop.so`;

// --- preflight 1: cmdline + cwd -------------------------------------------
const cmdlineRaw = await Deno.readFile(`/proc/${args.pid}/cmdline`)
  .catch(() => fail(`pid ${args.pid} is not readable (dead?)`));
const cmdline = new TextDecoder().decode(cmdlineRaw).split('\0').filter((s) =>
  s !== ''
);
if (
  !cmdline.some((a) => a.endsWith('deno')) ||
  !cmdline.includes('main.ts')
) {
  fail(
    `pid ${args.pid} is not the expected Deno main.ts: ${cmdline.join(' ')}`,
  );
}
const cwd = await Deno.readLink(`/proc/${args.pid}/cwd`)
  .catch(() => fail(`/proc/${args.pid}/cwd unreadable`));
if (cwd !== repoRoot.replace(/\/$/, '')) {
  fail(`pid ${args.pid} cwd is ${cwd}, not the candidate checkout ${repoRoot}`);
}

// --- preflight 2: start time after the recorded floor ----------------------
// /proc/<pid>/stat field 22 is starttime in clock ticks since boot; with
// /proc/uptime the epoch start is now - (uptime - starttime/HZ). USER_HZ is
// 100 on Linux/x86-64.
const statText = await Deno.readTextFile(`/proc/${args.pid}/stat`);
// Field 22 (starttime, clock ticks since boot). comm (field 2) may contain
// spaces/parens, so parse from the last ')' — field 22 is then index 19.
const afterComm = statText.slice(statText.lastIndexOf(')') + 2).split(' ');
const startTicks = Number(afterComm[19]);
const uptimeSec = Number(
  (await Deno.readTextFile('/proc/uptime')).split(' ')[0],
);
const startEpochMs = Date.now() -
  Math.round((uptimeSec - startTicks / 100) * 1000);
if (!(startEpochMs >= args.notBeforeMs)) {
  fail(
    `pid ${args.pid} started ${new Date(startEpochMs).toISOString()}, ` +
      `before the candidate floor ${new Date(args.notBeforeMs).toISOString()}`,
  );
}

// --- preflight 3: the candidate library is mapped, live, and matches disk --
const maps = await Deno.readTextFile(`/proc/${args.pid}/maps`);
const libLines = maps.split('\n').filter((l) => l.includes('melofon_raop'));
if (libLines.length === 0) {
  fail(`pid ${args.pid} has no melofon_raop library mapped`);
}
if (libLines.some((l) => l.includes('(deleted)'))) {
  fail(`pid ${args.pid} maps a DELETED library (stale build)`);
}
const mappedPaths = [
  ...new Set(
    libLines.map((l) => l.trim().split(/\s+/).slice(5).join(' ')),
  ),
];
if (mappedPaths.length !== 1 || mappedPaths[0] !== candidateLib) {
  fail(
    `pid ${args.pid} maps ${mappedPaths.join(', ')}, not ${candidateLib}`,
  );
}
const mapInodes = new Set(
  libLines.map((l) => l.trim().split(/\s+/)[4]),
);
const diskIno = (await Deno.stat(candidateLib)).ino?.toString();
if (mapInodes.size !== 1 || diskIno === undefined || !mapInodes.has(diskIno)) {
  fail(
    `mapped inode(s) ${[...mapInodes].join(',')} do not match the ` +
      `on-disk candidate inode ${diskIno}`,
  );
}

// --- preflight 4: policy marker + identity + wire purity -------------------
const logText = await Deno.readTextFile(args.log);
if (!logText.includes('policy=atv3-recycle-v1')) {
  fail(`${args.log} has no policy=atv3-recycle-v1 marker — stale process?`);
}

const get = async (path: string) => {
  const res = await fetch(`${args.baseUrl}${path}`);
  if (!res.ok) fail(`GET ${path}: ${res.status}`);
  return await res.json();
};

const native = (await get('/_/outputs')) as {
  outputs?: { id: string; model?: string }[];
};
const output = (native.outputs ?? []).find((o) => o.id === args.outputId);
if (output === undefined) {
  fail(`output ${args.outputId} not in /_/outputs`);
}
if (output.model !== 'AppleTV3,1') {
  fail(
    `output ${args.outputId} model is ${output.model ?? 'unknown'}, ` +
      'not AppleTV3,1 — the policy would not apply',
  );
}
const player = await get('/api/player');
const playerKeys = Object.keys(player).sort();
if (
  JSON.stringify(playerKeys) !==
    JSON.stringify(
      [
        'consume',
        'item_id',
        'item_length_ms',
        'item_progress_ms',
        'repeat',
        'shuffle',
        'state',
        'volume',
      ].sort(),
    )
) {
  fail(`/api/player carries non-OwnTone fields: ${playerKeys.join(',')}`);
}
const owntoneOutputs = (await get('/api/outputs')) as {
  outputs?: Record<string, unknown>[];
};
for (const o of owntoneOutputs.outputs ?? []) {
  if ('model' in o || 'last_command' in o) {
    fail('/api/outputs carries a non-OwnTone field');
  }
}

console.log(
  `observe-live: preflight OK — pid ${args.pid}, started ` +
    `${new Date(startEpochMs).toISOString()}, lib inode ${diskIno}, ` +
    `output ${args.outputId} model=AppleTV3,1`,
);

// --- observation loop (GET only) -------------------------------------------
let logOffset = logText.length;
const LIFECYCLE =
  /airplay: output \S+ (session gen \d+|retirement FAILED|blocked)/;
const startedAt = Date.now();
const endAt = startedAt + args.seconds * 1000;
while (Date.now() < endAt) {
  const sample: Record<string, unknown> = { t: new Date().toISOString() };
  try {
    const p = await get('/api/player');
    sample.state = p.state;
    sample.progressMs = p.item_progress_ms;
    sample.volume = p.volume;
    const outs = (await get('/api/outputs')) as {
      outputs?: { id: string; selected: boolean; volume: number }[];
    };
    const o = (outs.outputs ?? []).find((x) => x.id === args.outputId);
    sample.outputSelected = o?.selected;
    sample.outputVolume = o?.volume;
  } catch (err) {
    sample.error = String(err);
  }
  console.log(JSON.stringify(sample));
  // Follow the generation-tagged lifecycle in the candidate's log.
  const size = (await Deno.stat(args.log).catch(() => null))?.size;
  if (size !== undefined && size !== null && size >= logOffset) {
    const file = await Deno.open(args.log);
    await file.seek(logOffset, Deno.SeekMode.Start);
    const chunk = new Uint8Array(size - logOffset);
    await file.read(chunk);
    file.close();
    logOffset = size;
    for (const line of new TextDecoder().decode(chunk).split('\n')) {
      if (LIFECYCLE.test(line)) console.log(`log ${line.trim()}`);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}
console.log('observe-live: window complete');
