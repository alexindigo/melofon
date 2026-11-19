import { assertEquals, assertMatch, assertRejects } from '@std/assert';
import {
  buildNative,
  parseSummary,
  selectFiles,
  shardFiles,
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
