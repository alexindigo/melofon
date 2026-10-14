// Guest-only journal consumer gate; owns exactly one transient tester user unit.
import { assert, assertEquals } from '@std/assert';
import { parseLogfmt } from '../../tests/helpers/logging.ts';

const root = '/home/tester/melofon-output-preparation-01/shared-logging-01';
const source = `${root}/source`;
const arguments_ = new Map(Deno.args.map((arg) => {
  const equal = arg.indexOf('=');
  if (equal < 0) throw new Error('Expected --key=value');
  return [arg.slice(0, equal), arg.slice(equal + 1)];
}));
const unit = arguments_.get('--unit');
const evidence = arguments_.get('--evidence');
if (!unit || !/^melofon-logging-acceptance-[a-z0-9-]+$/.test(unit)) {
  throw new Error('Invalid owned unit');
}
if (
  !evidence || !evidence.startsWith(`${root}/evidence/`) ||
  evidence.includes('/../')
) throw new Error('Invalid evidence destination');
async function command(name: string, args: string[]) {
  const result = await new Deno.Command(name, {
    args,
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  return {
    ...result,
    text: new TextDecoder().decode(result.stdout),
    error: new TextDecoder().decode(result.stderr),
  };
}
assertEquals(
  (await command('sudo', ['-n', 'cat', '/sys/class/dmi/id/product_uuid'])).text
    .trim().toLowerCase(),
  '1af2f55f-5461-48c1-bb2d-b2d9d6c3d1c3',
);
assertEquals((await command('systemd-detect-virt', [])).text.trim(), 'kvm');
assertEquals(await Deno.realPath(Deno.cwd()), source);
async function absent(path: string) {
  try {
    await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  throw new Error(`Refusing existing destination: ${path}`);
}
await absent(evidence);
assertEquals(
  (await command('systemctl', [
    '--user',
    'show',
    `${unit}.service`,
    '--property=LoadState',
    '--value',
  ])).text.trim(),
  'not-found',
  'Refusing existing unit',
);
await Deno.mkdir(evidence, { mode: 0o700 });
const permissions = [
  '--allow-run',
  '--allow-net',
  '--allow-env',
  '--allow-read',
  '--allow-write',
  '--allow-ffi',
  '--allow-sys',
];
const fixture = [
  'run',
  '--frozen',
  '--cached-only',
  '--node-modules-dir=auto',
  ...permissions,
  `${source}/tests/fixtures/logging-consumer.ts`,
  'streams',
];
const argv = [
  '--user',
  `--unit=${unit}`,
  '--property=Type=exec',
  '--property=RemainAfterExit=yes',
  '--property=StandardOutput=journal',
  '--property=StandardError=inherit',
  '--property=SyslogLevelPrefix=yes',
  `--working-directory=${source}`,
  `--setenv=TMPDIR=${root}/tmp`,
  '/home/tester/.deno/bin/deno',
  ...fixture,
];
await Deno.writeTextFile(
  `${evidence}/command.json`,
  JSON.stringify(
    {
      argv: ['systemd-run', ...argv],
      cwd: source,
      guest: 'arch-niri-melofon-atv3-recycle',
      host: 'ark.home',
    },
    null,
    2,
  ),
  { createNew: true },
);
let owned = false;
try {
  const launch = await command('systemd-run', argv);
  await Deno.writeTextFile(`${evidence}/launch.stdout`, launch.text, {
    createNew: true,
  });
  await Deno.writeTextFile(`${evidence}/launch.stderr`, launch.error, {
    createNew: true,
  });
  assert(launch.success, launch.error);
  owned = true;
  let invocation = '';
  const deadline = performance.now() + 15000;
  for (;;) {
    const state = await command('systemctl', [
      '--user',
      'show',
      `${unit}.service`,
      '--property=InvocationID',
      '--property=ExecMainStatus',
      '--property=ExecMainExitTimestampMonotonic',
    ]);
    assert(state.success, state.error);
    const fields = Object.fromEntries(
      state.text.trim().split('\n').map((line) => {
        const split = line.indexOf('=');
        return [line.slice(0, split), line.slice(split + 1)];
      }),
    );
    if (Number(fields.ExecMainExitTimestampMonotonic) > 0) {
      assertEquals(fields.ExecMainStatus, '0');
      invocation = fields.InvocationID;
      assert(/^[a-f0-9]{32}$/.test(invocation));
      await Deno.writeTextFile(`${evidence}/unit-state.txt`, state.text, {
        createNew: true,
      });
      break;
    }
    if (performance.now() > deadline) {
      throw new Error('Owned fixture exit deadline');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  let rows: Record<string, unknown>[] = [];
  for (;;) {
    const journal = await command('journalctl', [
      '--user',
      `--user-unit=${unit}.service`,
      '--output=json',
      '--no-pager',
      `_SYSTEMD_INVOCATION_ID=${invocation}`,
    ]);
    assert(journal.success, journal.error);
    rows = journal.text.trim().split('\n').filter(Boolean).map((line) =>
      JSON.parse(line)
    );
    if (rows.length >= 3) {
      await Deno.writeTextFile(`${evidence}/journal.jsonl`, journal.text, {
        createNew: true,
      });
      break;
    }
    if (performance.now() > deadline) {
      throw new Error('Journal consumer delivery deadline');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assertEquals(rows.length, 3);
  const expected = { fixture_info: '6', fixture_warn: '4', fixture_error: '3' };
  for (const row of rows) {
    assertEquals(row._SYSTEMD_INVOCATION_ID, invocation);
    assert(typeof row.MESSAGE === 'string' && !row.MESSAGE.startsWith('<'));
    const record = parseLogfmt(row.MESSAGE);
    assert(record.event in expected);
    assertEquals(row.PRIORITY, expected[record.event as keyof typeof expected]);
    assert(
      !row.MESSAGE.includes('credential/CANARY') &&
        !row.MESSAGE.includes('pin-canary'),
    );
  }
  const pipe = await new Deno.Command(Deno.execPath(), {
    args: fixture,
    cwd: source,
    clearEnv: true,
    env: {
      HOME: '/home/tester',
      PATH: '/home/tester/.deno/bin:/usr/bin:/bin',
      TMPDIR: `${root}/tmp`,
      JOURNAL_STREAM: '1:2',
    },
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  await Deno.writeFile(`${evidence}/pipe.stdout`, pipe.stdout, {
    createNew: true,
  });
  await Deno.writeFile(`${evidence}/pipe.stderr`, pipe.stderr, {
    createNew: true,
  });
  assertEquals(pipe.code, 0);
  const parse = (bytes: Uint8Array) =>
    new TextDecoder().decode(bytes).trim().split('\n').map(parseLogfmt);
  assertEquals(parse(pipe.stdout).map((row) => row.level), ['info', 'warn']);
  assertEquals(parse(pipe.stderr).map((row) => row.level), ['error']);
  await Deno.writeTextFile(
    `${evidence}/assertions.json`,
    JSON.stringify(
      {
        invocation,
        priorities: expected,
        physicalJournalRecords: rows.length,
        pipeStreams: { stdout: ['info', 'warn'], stderr: ['error'] },
        redacted: true,
        prefixesRemovedByJournal: true,
        redirectedDescriptorsRejectJournalEnvironment: true,
      },
      null,
      2,
    ),
    { createNew: true },
  );
} finally {
  if (owned) {
    const stop = await command('systemctl', [
      '--user',
      'stop',
      `${unit}.service`,
    ]);
    await Deno.writeTextFile(
      `${evidence}/cleanup.txt`,
      `${stop.code}\n${stop.text}${stop.error}`,
      { createNew: true },
    );
    assert(stop.success, stop.error);
    const state = await command('systemctl', [
      '--user',
      'show',
      `${unit}.service`,
      '--property=LoadState',
      '--value',
    ]);
    assertEquals(state.text.trim(), 'not-found');
  }
}
console.log('LOGGING-JOURNAL-OK');
