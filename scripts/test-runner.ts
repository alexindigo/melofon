// Runs inside the shared dev image. No host runtime or test dependencies.
export function selectFiles(files: string[], changes?: string[]): string[] {
  if (changes === undefined) return files;
  const relevant = changes.filter((path) =>
    !path.endsWith('.md') || path.startsWith('tests/')
  );
  if (relevant.some((path) => !/^tests\/[^/]+\.ts$/.test(path))) return files;
  return files.filter((path) => relevant.includes(path));
}

export function shardFiles(
  files: string[],
  count: number,
  timings: Record<string, number> = {},
): string[][] {
  const shards: string[][] = Array.from({ length: count }, () => []);
  const measured = Object.values(timings).filter((time) =>
    time > 0 && Number.isFinite(time)
  );
  const fallback = measured.length
    ? measured.reduce((a, b) => a + b, 0) / measured.length
    : 1;
  const weight = (file: string) =>
    timings[file] > 0 && Number.isFinite(timings[file])
      ? timings[file]
      : fallback;
  const loads = Array<number>(count).fill(0);
  [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))
    .forEach((file) => {
      const index = loads.indexOf(Math.min(...loads));
      shards[index].push(file);
      loads[index] += weight(file);
    });
  return shards;
}

// Advisory weights from top-level test durations, excluding indented steps.
// Setup/typechecking overhead is included separately in shard wall times.
export function parseFileTimes(text: string): Record<string, number> {
  const times: Record<string, number> = {};
  let file: string | undefined;
  for (const line of text.split('\n')) {
    const heading = /^running \d+ tests? from \.\/(tests\/[^\s]+\.ts)$/.exec(
      line,
    );
    if (heading) {
      file = heading[1];
      times[file] = 0.01;
    } else if (file && /^\S.* \.\.\. (?:ok|FAILED) \(/.test(line)) {
      const duration = / \(([^()]*)\)$/.exec(line)?.[1] ?? '';
      for (const part of duration.matchAll(/([\d.]+)(ms|µs|s|m|h)/g)) {
        times[file] += +part[1] *
          ({ ms: 0.001, 'µs': 0.000001, s: 1, m: 60, h: 3600 }[part[2]] ?? 0);
      }
    }
  }
  return times;
}

export function parseSummary(text: string) {
  // Use the last top-level Deno summary, never counts printed by child tests.
  const summaries = [...text.matchAll(
    /^(?:ok|FAILED) \| (\d+) passed(?: \([^\n]*?\))? \| (\d+) failed(?: \([^\n]*?\))?(?: \| (\d+) ignored)?/gm,
  )];
  const summary = summaries.at(-1);
  return summary
    ? { passed: +summary[1], failed: +summary[2], ignored: +(summary[3] ?? 0) }
    : undefined;
}

async function command(cmd: string, args: string[]) {
  const status = await new Deno.Command(cmd, {
    args,
    stdout: 'inherit',
    stderr: 'inherit',
    env: { NO_COLOR: '1' },
  }).spawn().status;
  if (!status.success) {
    throw new Error(`${cmd} ${args.join(' ')}: exit ${status.code}`);
  }
}

// Processes, Workers and discovered routes are independent module entries, not
// necessarily imports of a test file. Include them all, never ambient caches or
// generated fixtures, and let the frozen lock resolve their dependencies.
export async function cacheEntries(root = '.'): Promise<string[]> {
  const entries: string[] = [];
  async function visit(directory: string) {
    for await (const entry of Deno.readDir(`${root}/${directory}`)) {
      if (
        entry.name.startsWith('.') || entry.name === 'node_modules' ||
        (directory === '' && entry.name === 'data')
      ) continue;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory) await visit(path);
      else if (entry.isFile && /\.(?:[cm]?ts|tsx)$/.test(entry.name)) {
        entries.push(path);
      }
    }
  }
  await visit('');
  return entries.sort();
}

export async function verifyCache(entries: string[], run = command) {
  // Resolution only: no test/server execution or duplicate typecheck. A missing
  // registry manifest, source or npm package fails preparation without a fetch.
  await run(Deno.execPath(), [
    'test',
    '--frozen',
    '--cached-only',
    '--no-run',
    '--no-check',
    ...entries,
  ]);
}

export async function prepareCache(entries: string[], run = command) {
  await run(Deno.execPath(), ['cache', '--frozen', ...entries]);
  await verifyCache(entries, run);
}

async function nativeOutputs(directory: string): Promise<string> {
  const files: string[] = [];
  async function visit(path: string) {
    for await (const entry of Deno.readDir(path)) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory) await visit(child);
      else if (
        entry.isFile &&
        (/\.(o|so)$/.test(entry.name) || child === `${directory}/test/driver`)
      ) files.push(child);
    }
  }
  await visit(directory);
  const hashes = await Promise.all(
    files.sort().map(async (path) => {
      const hash = await crypto.subtle.digest(
        'SHA-256',
        await Deno.readFile(path),
      );
      return [path, Array.from(new Uint8Array(hash))];
    }),
  );
  return JSON.stringify(hashes);
}

export async function buildNative(
  directory = 'helper/raop',
  imageIdFile = '/usr/local/share/melofon-native-build-id',
  run = command,
) {
  const imageId = await Deno.readTextFile(imageIdFile);
  const identity = () =>
    nativeOutputs(directory).then((outputs) =>
      JSON.stringify({ imageId, outputs })
    );
  const stamp = `${directory}/.dev-image-id`;
  let previous: string | undefined;
  try {
    previous = await Deno.readTextFile(stamp);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (previous !== await identity()) {
    await run('make', ['-C', directory, 'clean']);
  }
  await run('make', ['-C', directory, '-j1', 'test']);
  await Deno.writeTextFile(stamp, await identity());
}

type Plan = { shards: string[][]; started: number };
type Result = {
  success: boolean;
  seconds: number;
  summary?: ReturnType<typeof parseSummary>;
  timings: Record<string, number>;
};

async function prepare(directory: string, count: number, changesFile?: string) {
  await command(Deno.execPath(), ['task', 'check']);
  await command(Deno.execPath(), ['check', 'scripts/test-runner.ts']);
  if (Deno.args.includes('--check-only')) return;
  await buildNative();
  const files: string[] = [];
  for await (const entry of Deno.readDir('tests')) {
    // The browser job runs this file separately; still check and cache it.
    if (
      entry.isFile && entry.name.endsWith('.ts') &&
      entry.name !== 'api-browser-media.test.ts'
    ) {
      files.push(`tests/${entry.name}`);
    }
  }
  const changes = changesFile
    ? (await Deno.readTextFile(changesFile)).split('\0').filter(Boolean)
    : undefined;
  const selected = selectFiles(files, changes);
  console.log(`Selected ${selected.length}/${files.length} test files`);
  const timings = JSON.parse(
    await Deno.readTextFile('scripts/test-timings.json'),
  );
  const shards = shardFiles(selected, count, timings);
  const entries = await cacheEntries();
  await prepareCache(entries);
  console.log(`Offline cache verified: ${entries.length} module entries`);
  await Deno.writeTextFile(
    `${directory}/plan.json`,
    JSON.stringify({ shards, started: Date.now() }),
  );
  for (let i = 0; i < shards.length; i++) {
    const estimate = shards[i].reduce(
      (sum, file) => sum + (timings[file] ?? 0),
      0,
    );
    console.log(
      `Planned shard ${i + 1}/${count}: ${shards[i].length} files, ${
        estimate.toFixed(2)
      }s measured tests`,
    );
  }
}

async function runShard(directory: string, plan: Plan, index: number) {
  const started = performance.now();
  const files = plan.shards[index - 1];
  if (!files) throw new Error('Invalid shard index');
  let result: Result = {
    success: true,
    seconds: 0,
    summary: { passed: 0, failed: 0, ignored: 0 },
    timings: {},
  };
  if (files.length) {
    const tmp = `${Deno.env.get('TMPDIR')}/shard-${index}`;
    await Deno.mkdir(tmp, { recursive: true });
    console.log(`Shard ${index}/${plan.shards.length}: ${files.length} files`);
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        'test',
        '--frozen',
        '--cached-only',
        '--env',
        // Native identity probes read /proc/self/maps, which requires -A.
        // The rootless container remains the execution boundary.
        '--allow-all',
        '--node-modules-dir=auto',
        ...files,
      ],
      // Preparation builds the native graph. Never let clean-checkout or
      // inaccessible-worktree git metadata decide coverage in a prepared shard.
      env: { TMPDIR: tmp, NO_COLOR: '1', MELOFON_NATIVE_TESTS: '1' },
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    const decoder = new TextDecoder();
    const stdout = decoder.decode(output.stdout);
    console.log(
      `\n--- Shard ${index}/${plan.shards.length} (exit ${output.code}) ---`,
    );
    console.log(stdout);
    const stderr = decoder.decode(output.stderr);
    if (stderr) console.error(stderr);
    const summary = parseSummary(stdout);
    if (!summary) console.error(`Shard ${index}: no final test summary`);
    result = {
      success: output.success && summary !== undefined && summary.failed === 0,
      seconds: 0,
      summary,
      timings: parseFileTimes(stdout),
    };
  }
  result.seconds = (performance.now() - started) / 1000;
  await Deno.writeTextFile(
    `${directory}/shard-${index}.json`,
    JSON.stringify(result),
  );
  console.log(
    `Shard ${index}/${plan.shards.length}: ${
      result.seconds.toFixed(2)
    }s wall; ${result.success ? 'passed' : 'FAILED'}`,
  );
  if (!result.success) Deno.exitCode = 1;
}

async function summarize(directory: string, plan: Plan, only?: number) {
  const totals = { passed: 0, failed: 0, ignored: 0 };
  const timings: Record<string, number> = {};
  let failed = 0;
  for (let index = 1; index <= plan.shards.length; index++) {
    if (only !== undefined && index !== only) continue;
    try {
      const result: Result = JSON.parse(
        await Deno.readTextFile(`${directory}/shard-${index}.json`),
      );
      if (!result.success) failed++;
      if (result.summary) {
        for (const key of ['passed', 'failed', 'ignored'] as const) {
          totals[key] += result.summary[key];
        }
      }
      Object.assign(timings, result.timings);
      console.log(
        `Shard ${index}/${plan.shards.length}: ${
          result.seconds.toFixed(2)
        }s wall; ${result.success ? 'passed' : 'FAILED'}`,
      );
    } catch (error) {
      console.error(`Shard ${index}: missing/invalid result`, error);
      failed++;
    }
  }
  const sorted = Object.fromEntries(
    Object.keys(timings).sort().map((
      file,
    ) => [file, +timings[file].toFixed(3)]),
  );
  await Deno.writeTextFile(
    `${directory}/timings.json`,
    JSON.stringify(sorted, null, 2) + '\n',
  );
  console.log(
    `\nCombined: ${totals.passed} passed | ${totals.failed} failed | ${totals.ignored} ignored; ${failed} failing shards; ${
      ((Date.now() - plan.started) / 1000).toFixed(2)
    }s shard wall`,
  );
  if (failed) Deno.exitCode = 1;
}

async function main() {
  const [mode, directory, ...args] = Deno.args;
  if (!directory) throw new Error('A run directory is required');
  if (mode === 'prepare') {
    const count = Number(args[0]);
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error('Invalid shard count');
    }
    await prepare(
      directory,
      count,
      args[1] === '--check-only' ? undefined : args[1],
    );
  } else {
    const plan: Plan = JSON.parse(
      await Deno.readTextFile(`${directory}/plan.json`),
    );
    if (mode === 'run-shard' && plan.shards.length !== Number(args[1])) {
      throw new Error('Prepared shard count differs from --shard i/N');
    }
    if (mode === 'run-shard') await runShard(directory, plan, Number(args[0]));
    else if (mode === 'summarize') {
      await summarize(directory, plan, args[0] ? Number(args[0]) : undefined);
    } else throw new Error(`Unknown mode: ${mode}`);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    Deno.exitCode = 1;
  }
}
