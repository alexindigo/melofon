import { assertEquals, assertMatch, assertRejects } from '@std/assert';
import {
  buildNative,
  cacheEntries,
  parseFileTimes,
  parseSummary,
  prepareCache,
  selectFiles,
  shardFiles,
  verifyCache,
} from '../scripts/test-runner.ts';

Deno.test('test runner: shards are stable, disjoint and exhaustive', () => {
  const files = ['tests/c.ts', 'tests/a.ts', 'tests/b.ts'];
  assertEquals(shardFiles(files, 2), [['tests/a.ts', 'tests/c.ts'], [
    'tests/b.ts',
  ]]);
  assertEquals(shardFiles([], 4), [[], [], [], []]);
});

Deno.test('test runner: selection is conservative for shared changes', () => {
  const files = ['tests/a.ts', 'tests/b.ts'];
  assertEquals(selectFiles(files), files);
  assertEquals(selectFiles(files, ['tests/a.ts', 'tests/deleted.ts']), [
    'tests/a.ts',
  ]);
  assertEquals(selectFiles(files, ['README.md']), []);
  for (
    const path of [
      'src/a.ts',
      'deno.lock',
      'helper/raop/ffi.c',
      'tests/helpers/a.ts',
      'tests/fixtures/a.md',
    ]
  ) {
    assertEquals(selectFiles(files, [path]), files);
  }
});

Deno.test('test runner: offline preparation includes independent subprocess and worker entries', async () => {
  const root = await Deno.makeTempDir();
  try {
    const files = [
      'main.ts',
      'src/worker.ts',
      'tests/fixtures/child.ts',
      'layers/routes/get.ts',
      '.test-tmp/generated.ts',
      'node_modules/ambient.ts',
      'data/runtime.ts',
    ];
    for (const path of files) {
      await Deno.mkdir(`${root}/${path.slice(0, path.lastIndexOf('/') + 1)}`, {
        recursive: true,
      });
      await Deno.writeTextFile(`${root}/${path}`, 'export {};');
    }
    const entries = await cacheEntries(root);
    assertEquals(entries, [
      'layers/routes/get.ts',
      'main.ts',
      'src/worker.ts',
      'tests/fixtures/child.ts',
    ]);
    const calls: string[][] = [];
    await prepareCache(entries, (_cmd, args) => {
      calls.push(args);
      return Promise.resolve();
    });
    assertEquals(calls, [
      ['cache', '--frozen', ...entries],
      [
        'test',
        '--frozen',
        '--cached-only',
        '--no-run',
        '--no-check',
        ...entries,
      ],
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('test runner: offline validation rejects an empty cache without network or lock changes', async () => {
  const cache = await Deno.makeTempDir();
  const lock = await Deno.readTextFile('deno.lock');
  try {
    await assertRejects(
      () =>
        verifyCache(['src/zip.ts'], async (cmd, args) => {
          const output = await new Deno.Command(cmd, {
            args,
            env: { DENO_DIR: cache, NO_COLOR: '1' },
            stdout: 'piped',
            stderr: 'piped',
          }).output();
          if (!output.success) {
            throw new Error(new TextDecoder().decode(output.stderr));
          }
        }),
      Error,
      'Specifier not found in cache',
    );
    assertEquals(await Deno.readTextFile('deno.lock'), lock);
  } finally {
    await Deno.remove(cache, { recursive: true });
  }
});

Deno.test('test runner: longest measured files are assigned to the lightest shard', () => {
  const timings = { a: 10, b: 8, c: 4, d: 2 };
  assertEquals(shardFiles(['d', 'c', 'b', 'a'], 2, timings), [['a', 'd'], [
    'b',
    'c',
  ]]);
  assertEquals(shardFiles(['new', 'a'], 2, timings), [['a'], ['new']]);
  assertEquals(shardFiles(['a', 'b'], 4, timings), [['a'], ['b'], [], []]);
});

Deno.test('test runner: file timings exclude nested steps and parse duration units', () => {
  const times = parseFileTimes(
    'running 2 tests from ./tests/a.ts\nfirst ... ok (1m2s)\n  step ... ok (2s)\nsecond ... FAILED (500ms)\nrunning 1 test from ./tests/b.ts\nfast ... ok (100µs)\n',
  );
  assertEquals(+times['tests/a.ts'].toFixed(2), 62.51);
  assertEquals(+times['tests/b.ts'].toFixed(4), 0.0101);
});

Deno.test('test runner: only the final summary counts, crashes lack a summary', () => {
  assertEquals(
    parseSummary(
      'ok | 9 passed | 0 failed\nFAILED | 3 passed (2 steps) | 1 failed | 2 ignored (1s)\n',
    ),
    { passed: 3, failed: 1, ignored: 2 },
  );
  assertEquals(parseSummary('ok | 1 passed | 0 failed (1s)\n'), {
    passed: 1,
    failed: 0,
    ignored: 0,
  });
  assertEquals(parseSummary('error: process crashed'), undefined);
});

Deno.test('test runner: prepared shards require native tests without ambient opt-in', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'native-runner-' });
  try {
    const fixture = `${dir}/native.test.ts`;
    await Deno.writeTextFile(
      fixture,
      `Deno.test('native suite enabled', () => {
  if (Deno.env.get('MELOFON_NATIVE_TESTS') !== '1') throw new Error('native suite not required');
});\n`,
    );
    await Deno.writeTextFile(
      `${dir}/plan.json`,
      JSON.stringify({ shards: [[fixture]], started: Date.now() }),
    );
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '--frozen',
        '--cached-only',
        '--allow-all',
        'scripts/test-runner.ts',
        'run-shard',
        dir,
        '1',
        '1',
      ],
      env: { MELOFON_NATIVE_TESTS: '' },
    }).output();
    const decoder = new TextDecoder();
    assertEquals(
      output.code,
      0,
      decoder.decode(output.stdout) + decoder.decode(output.stderr),
    );
    const result = JSON.parse(await Deno.readTextFile(`${dir}/shard-1.json`));
    assertEquals(result.summary, { passed: 1, failed: 0, ignored: 0 });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('test runner: native reuse requires the same image and unchanged outputs', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const image = `${dir}/image-id`;
    const native = `${dir}/native`;
    await Deno.mkdir(native);
    await Deno.writeTextFile(image, 'image-one');
    await Deno.writeTextFile(`${native}/ffi.o`, 'host object');
    const calls: string[][] = [];
    const run = async (_cmd: string, args: string[]) => {
      calls.push(args);
      if (args.at(-1) === 'test') {
        await Deno.writeTextFile(`${native}/ffi.o`, 'container object');
      }
    };
    await buildNative(native, image, run);
    assertEquals(calls.map((args) => args.at(-1)), ['clean', 'test']);
    calls.length = 0;
    await buildNative(native, image, run);
    assertEquals(calls.map((args) => args.at(-1)), ['test']);
    calls.length = 0;
    await Deno.writeTextFile(image, 'image-two');
    await buildNative(native, image, run);
    assertEquals(calls.map((args) => args.at(-1)), ['clean', 'test']);
    calls.length = 0;
    await Deno.writeTextFile(`${native}/ffi.o`, 'another host object');
    await buildNative(native, image, run);
    assertEquals(calls.map((args) => args.at(-1)), ['clean', 'test']);
    const stamp = await Deno.readTextFile(`${native}/.dev-image-id`);
    await assertRejects(() =>
      buildNative(
        native,
        image,
        () => Promise.reject(new Error('failed build')),
      )
    );
    assertEquals(await Deno.readTextFile(`${native}/.dev-image-id`), stamp);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('container engine: Docker/Podman arguments and network use one engine', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const log = `${dir}/calls`;
    for (const engine of ['docker', 'podman']) {
      await Deno.writeTextFile(
        `${dir}/${engine}`,
        `#!/bin/bash
if [[ "$1" == --version ]]; then echo '${engine} version stub'; exit; fi
printf '%s\\0' '${engine}' "$@" >> "$CALL_LOG"
printf '\\n' >> "$CALL_LOG"
[[ "$1 $2" != 'network inspect' ]]
`,
      );
      await Deno.chmod(`${dir}/${engine}`, 0o755);
    }
    await Deno.writeTextFile(
      `${dir}/nproc`,
      '#!/bin/bash\necho "$CPU_COUNT"\n',
    );
    await Deno.chmod(`${dir}/nproc`, 0o755);
    const invoke = async (
      script: string,
      args: string[],
      engine?: string,
      cpus = '4',
    ) => {
      await Deno.writeTextFile(log, '');
      const command = new Deno.Command('bash', {
        args: [script, ...args],
        env: {
          PATH: `${dir}:${Deno.env.get('PATH')}`,
          CONTAINER_ENGINE: engine ?? '',
          CALL_LOG: log,
          CPU_COUNT: cpus,
        },
      });
      assertEquals((await command.output()).code, 0);
      return (await Deno.readTextFile(log)).trim().split('\n').map((line) =>
        line.split('\0').filter(Boolean)
      );
    };
    assertEquals(
      await invoke(
        '.devcontainer/engine',
        ['run', '--cpus=8', 'image'],
        'docker',
      ),
      [
        ['docker', 'run', '--cpus=4', 'image'],
      ],
    );
    assertEquals(
      await invoke(
        '.devcontainer/engine',
        ['run', '--cpus=8', 'image'],
        'podman',
        '24',
      ),
      [
        ['podman', 'run', '--userns=keep-id', '--cpus=8', 'image'],
      ],
    );
    assertEquals(
      await invoke(
        '.devcontainer/engine',
        ['build', '--cpu-quota=800000'],
        'docker',
        '2',
      ),
      [
        ['docker', 'build', '--cpu-quota=200000'],
      ],
    );
    for (const engine of [undefined, 'docker', 'podman']) {
      assertEquals(
        await invoke('.devcontainer/network', ['melofon-test'], engine),
        [
          [engine || 'docker', 'network', 'inspect', 'melofon-test'],
          [engine || 'docker', 'network', 'create', 'melofon-test'],
        ],
      );
    }
    for (const engine of ['docker', 'podman']) {
      const runs = (await invoke('scripts/test', ['--shards', '1'], engine))
        .filter((call) => call[1] === 'run');
      assertEquals(runs.length, 3);
      for (const run of runs) {
        assertEquals(
          run.includes('--security-opt=seccomp=unconfined'),
          engine === 'docker' && run.includes('run-shard'),
        );
        assertEquals(run.includes('--privileged'), false);
        assertEquals(
          run.includes(`--user=${Deno.uid()}:${Deno.gid()}`),
          true,
        );
      }
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('test runner: launcher and check task reject incomplete locks without writing', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const config = JSON.parse(await Deno.readTextFile('deno.json'));
    config.tasks = { check: 'deno check fixture.ts' };
    delete config.lint;
    await Deno.writeTextFile(`${dir}/deno.json`, JSON.stringify(config));
    const lock = JSON.parse(await Deno.readTextFile('deno.lock'));
    delete lock.specifiers['jsr:@std/assert@1'];
    const text = JSON.stringify(lock);
    await Deno.writeTextFile(`${dir}/deno.lock`, text);
    await Deno.writeTextFile(`${dir}/fixture.ts`, "import '@std/assert';\n");
    for (const args of [['run', 'fixture.ts'], ['task', 'check']]) {
      const output = await new Deno.Command(Deno.execPath(), {
        args,
        cwd: dir,
        env: { NO_COLOR: '1' },
      }).output();
      assertEquals(output.success, false);
      assertMatch(new TextDecoder().decode(output.stderr), /lockfile.*frozen/s);
      assertEquals(await Deno.readTextFile(`${dir}/deno.lock`), text);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('test runner: launcher isolates concurrent shards and propagates failures', async () => {
  const dir = await Deno.makeTempDir({ dir: '.test-tmp', prefix: 'runner-' });
  try {
    const log = `${dir}/calls`;
    const stub = `${dir}/podman`;
    await Deno.writeTextFile(
      stub,
      `#!/bin/bash
set -eu
if [[ "$1" == --version ]]; then echo 'podman stub'; exit; fi
record_format=''
for arg in "$@"; do record_format+='%s\\0'; done
printf "\${record_format}\\n" "$@" >> "$CALL_LOG"
if [[ "$1" == network && "$2" == inspect ]]; then exit 1; fi
if [[ "$1" == image && "$2" == inspect ]]; then echo test-image-id; exit; fi
if [[ "$1" != run ]]; then exit; fi
while [[ "$1" != scripts/test-runner.ts ]]; do shift; done
shift
mode=$1; directory=$2
case "$mode" in
  prepare)
    printf '{"shards":[[],[],[]],"started":0}' > "$directory/plan.json" ;;
  run-shard)
    index=$3
    touch "$directory/started-$index"
    for ((attempt=0; attempt<200; attempt++)); do
      if [[ -f "$directory/started-1" && -f "$directory/started-2" && -f "$directory/started-3" ]]; then break; fi
      sleep 0.05
    done
    [[ -f "$directory/started-1" && -f "$directory/started-2" && -f "$directory/started-3" ]] || exit 1
    if [[ "\${FAIL_SHARD:-}" == "$index" ]]; then exit 1; fi
    printf '{"success":true,"seconds":0.3,"summary":{"passed":1,"failed":0,"ignored":0},"timings":{}}' > "$directory/shard-$index.json" ;;
  summarize) exec "$DENO_EXEC" run --frozen --allow-all scripts/test-runner.ts "$@" ;;
esac
`,
    );
    await Deno.chmod(stub, 0o755);
    await Deno.writeTextFile(
      `${dir}/nproc`,
      '#!/bin/bash\necho "${CPU_COUNT:-3}"\n',
    );
    await Deno.chmod(`${dir}/nproc`, 0o755);
    for (const fail of ['', '2']) {
      const results = `${dir}/results`;
      await Deno.writeTextFile(log, '');
      const output = await new Deno.Command('bash', {
        args: ['scripts/test', '--results', results],
        env: {
          PATH: `${Deno.cwd()}/${dir}:${Deno.env.get('PATH')}`,
          CONTAINER_ENGINE: 'podman',
          MELOFON_TEST_IMAGE: 'test-image',
          CALL_LOG: `${Deno.cwd()}/${log}`,
          DENO_EXEC: Deno.execPath(),
          FAIL_SHARD: fail,
        },
      }).output();
      assertEquals(
        output.code,
        fail ? 1 : 0,
        new TextDecoder().decode(output.stderr),
      );
      const stdout = new TextDecoder().decode(output.stdout);
      assertMatch(
        stdout,
        fail
          ? /Combined: 2 passed.*1 failing shards/
          : /Combined: 3 passed.*0 failing shards/,
      );
      const calls = (await Deno.readTextFile(log)).trim().split('\n').map((
        line,
      ) => line.split('\0').filter(Boolean));
      const runs = calls.filter((call) => call[0] === 'run');
      assertEquals(runs.length, 5); // one preparation, three shards, one summary
      for (const run of runs) {
        assertEquals(run.includes('--cached-only'), !run.includes('prepare'));
        for (
          const arg of [
            '--cpus=1',
            '--memory=2g',
            '--memory-swap=2g',
            '--pids-limit=512',
            'test-image-id',
          ]
        ) {
          assertEquals(run.includes(arg), true, arg);
        }
      }
      const shards = runs.filter((run) => run.includes('run-shard'));
      assertEquals(
        new Set(
          shards.map((run) => run.find((arg) => arg.startsWith('--network='))),
        ).size,
        3,
      );
      // Each stub waits for all three start markers before it can finish.
      for (const i of [1, 2, 3]) await Deno.stat(`${results}/started-${i}`);
    }
    const results = `${dir}/results`;
    for (
      const [args, count] of [
        [['--prepared', results, '--shard', '2/3'], undefined],
        [['--prepare-only', results], '8'],
        [['--prepare-only', results, '--shards', '2'], '2'],
      ] as const
    ) {
      await Deno.writeTextFile(log, '');
      const output = await new Deno.Command('bash', {
        args: ['scripts/test', ...args],
        env: {
          PATH: `${Deno.cwd()}/${dir}:${Deno.env.get('PATH')}`,
          CONTAINER_ENGINE: 'podman',
          MELOFON_TEST_IMAGE: 'test-image',
          CALL_LOG: `${Deno.cwd()}/${log}`,
          DENO_EXEC: Deno.execPath(),
          CPU_COUNT: '24',
        },
      }).output();
      assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
      const calls = (await Deno.readTextFile(log)).trim().split('\n').map((
        line,
      ) => line.split('\0').filter(Boolean));
      const runs = calls.filter((call) => call[0] === 'run');
      if (count) {
        assertEquals(runs.length, 1);
        assertEquals(runs[0].at(-1), count);
      } else {
        assertEquals(runs.length, 2);
        assertEquals(runs.some((run) => run.includes('prepare')), false);
        assertMatch(
          new TextDecoder().decode(output.stdout),
          /Combined: 1 passed.*0 failing shards/,
        );
      }
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
