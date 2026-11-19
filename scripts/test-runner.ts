// Runs inside the shared dev image. No host runtime or test dependencies.
export function selectFiles(files: string[], changes?: string[]): string[] {
  if (changes === undefined) return files;
  const relevant = changes.filter((path) =>
    !path.endsWith('.md') || path.startsWith('tests/')
  );
  if (relevant.some((path) => !/^tests\/[^/]+\.ts$/.test(path))) return files;
  return files.filter((path) => relevant.includes(path));
}

export function shardFiles(files: string[], count: number): string[][] {
  const shards: string[][] = Array.from({ length: count }, () => []);
  [...files].sort().forEach((file, i) => shards[i % count].push(file));
  return shards;
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
  await run('make', ['-C', directory, '-j4', 'test']);
  await Deno.writeTextFile(stamp, await identity());
}

async function main() {
  const started = performance.now();
  let count = 4, only: number | undefined, checkOnly = false;
  let changes: string[] | undefined;
  for (let i = 0; i < Deno.args.length; i++) {
    const arg = Deno.args[i];
    if (arg === '--check-only') checkOnly = true;
    else if (arg === '--changed-file') {
      changes = (await Deno.readTextFile(Deno.args[++i])).split('\0').filter(
        Boolean,
      );
    } else if (arg === '--shards') {
      const value = Deno.args[++i];
      if (!/^[1-9]\d*$/.test(value ?? '')) {
        throw new Error('Invalid shard count');
      }
      count = Number(value);
    } else if (arg === '--shard') {
      const match = /^(\d+)\/([1-9]\d*)$/.exec(Deno.args[++i] ?? '');
      if (!match || +match[1] < 1 || +match[1] > +match[2]) {
        throw new Error('Use --shard i/N with 1 <= i <= N');
      }
      only = +match[1] - 1;
      count = +match[2];
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isSafeInteger(count) || (only !== undefined && only >= count)) {
    throw new Error('Invalid shard count');
  }
  await command(Deno.execPath(), ['task', 'check']);
  await command(Deno.execPath(), ['check', 'scripts/test-runner.ts']);
  if (checkOnly) return;
  await buildNative();
  const files: string[] = [];
  for await (const entry of Deno.readDir('tests')) {
    if (entry.isFile && entry.name.endsWith('.ts')) {
      files.push(`tests/${entry.name}`);
    }
  }
  const selected = selectFiles(files, changes);
  console.log(`Selected ${selected.length}/${files.length} test files`);
  const shards = shardFiles(selected, count);
  // Populate dependencies once before concurrent test processes share the cache.
  if (selected.length) {
    await command(Deno.execPath(), ['cache', '--frozen', ...selected]);
  }
  const results = await Promise.all(shards.map(async (files, index) => {
    if ((only !== undefined && index !== only) || !files.length) {
      return undefined;
    }
    const tmp = `${Deno.env.get('TMPDIR')}/shard-${index + 1}`;
    await Deno.mkdir(tmp, { recursive: true });
    console.log(`Shard ${index + 1}/${count}: ${files.length} files`);
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        'test',
        '--frozen',
        '--env',
        // Native identity probes read /proc/self/maps, which requires -A.
        // The rootless container remains the execution boundary.
        '--allow-all',
        '--node-modules-dir=auto',
        ...files,
      ],
      env: { TMPDIR: tmp, NO_COLOR: '1' },
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    const decoder = new TextDecoder();
    const stdout = decoder.decode(output.stdout);
    console.log(`\n--- Shard ${index + 1}/${count} (exit ${output.code}) ---`);
    console.log(stdout);
    const stderr = decoder.decode(output.stderr);
    if (stderr) console.error(stderr);
    const summary = parseSummary(stdout);
    if (!summary) console.error(`Shard ${index + 1}: no final test summary`);
    return {
      success: output.success && summary !== undefined && summary.failed === 0,
      summary,
    };
  }));
  const totals = { passed: 0, failed: 0, ignored: 0 };
  for (const result of results) {
    if (!result?.summary) continue;
    for (const key of ['passed', 'failed', 'ignored'] as const) {
      totals[key] += result.summary[key];
    }
  }
  console.log(
    `\nCombined: ${totals.passed} passed | ${totals.failed} failed | ${totals.ignored} ignored; ${
      results.filter((result) => result && !result.success).length
    } failing shards; ${
      ((performance.now() - started) / 1000).toFixed(2)
    }s wall`,
  );
  if (results.some((result) => result && !result.success)) {
    Deno.exitCode = 1;
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
