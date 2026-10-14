import { assert, assertEquals } from '@std/assert';
import { parseLogfmt } from './helpers/logging.ts';

const permissions = [
  '--allow-run',
  '--allow-net',
  '--allow-env',
  '--allow-read',
  '--allow-write',
  '--allow-ffi',
  '--allow-sys',
];
function child(mode: string, stdin: 'null' | 'piped' = 'null'): Deno.Command {
  return new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--frozen',
      '--cached-only',
      '--node-modules-dir=auto',
      ...permissions,
      'tests/fixtures/logging-consumer.ts',
      mode,
    ],
    clearEnv: true,
    env: {
      HOME: '/home/tester',
      PATH: '/home/tester/.deno/bin:/usr/bin:/bin',
      TMPDIR: Deno.env.get('TMPDIR')!,
      MELOFON_RAOP_LIB: Deno.env.get('MELOFON_RAOP_LIB') ??
        `${Deno.cwd()}/helper/raop/libmelofon_raop.so`,
      DEBUG: 'music-metadata:*',
      ...(Deno.env.get('MELOFON_LOGGING_EVIDENCE')
        ? {
          MELOFON_LOGGING_CHILD_EVIDENCE: `${
            Deno.env.get('MELOFON_LOGGING_EVIDENCE')
          }/assets/${mode}`,
        }
        : {}),
    },
    stdout: 'piped',
    stderr: 'piped',
    stdin,
  });
}
function records(bytes: Uint8Array) {
  return new TextDecoder().decode(bytes).trim().split('\n').filter(Boolean).map(
    parseLogfmt,
  );
}
async function retain(mode: string, result: Deno.CommandOutput) {
  const root = Deno.env.get('MELOFON_LOGGING_EVIDENCE');
  if (!root) return;
  if (
    !root.startsWith(
      '/home/tester/melofon-output-preparation-01/shared-logging-01/evidence/',
    )
  ) throw new Error('Evidence must remain in the owned guest workspace');
  await Deno.mkdir(root, { recursive: true, mode: 0o700 });
  const destination = `${root}/${mode}`;
  await Deno.mkdir(destination, { mode: 0o700 });
  await Deno.writeFile(`${destination}/stdout.log`, result.stdout, {
    createNew: true,
  });
  await Deno.writeFile(`${destination}/stderr.log`, result.stderr, {
    createNew: true,
  });
  await Deno.writeTextFile(`${destination}/exit`, `${result.code}\n`, {
    createNew: true,
  });
  await Deno.writeTextFile(
    `${destination}/consumer.json`,
    JSON.stringify(
      {
        mode,
        source: Deno.cwd(),
        deno: Deno.version.deno,
        clearEnv: true,
        faultEnvironmentRemoved: true,
      },
      null,
      2,
    ),
    { createNew: true },
  );
}

Deno.test('bootstrap catches application import/startup failure with redacted diagnostics and failed exit', async () => {
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--frozen',
      '--cached-only',
      '--node-modules-dir=auto',
      ...permissions,
      'main.ts',
    ],
    clearEnv: true,
    env: {
      HOME: '/home/tester',
      PATH: '/home/tester/.deno/bin:/usr/bin:/bin',
      TMPDIR: Deno.env.get('TMPDIR')!,
      MELOFON_PASSWORD: 'credential/CANARY',
      MELOFON_LISTEN: 'invalid-listen-credential/CANARY',
    },
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  await retain('startup', result);
  assertEquals(result.code, 1);
  const error = records(result.stderr).find((record) =>
    record.event === 'startup_failed'
  )!;
  assertEquals(error.level, 'fatal');
  assert(JSON.parse(error.error).stack.includes('loadConfig'));
  assert(
    !new TextDecoder().decode(result.stderr).includes('credential/CANARY'),
  );
});
Deno.test('actual pipe consumers see correct streams, one-line records and redaction', async () => {
  const result = await child('streams').output();
  await retain('streams', result);
  assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
  const stdout = records(result.stdout), stderr = records(result.stderr);
  assertEquals(stdout.map((r) => r.level), ['info', 'warn']);
  assertEquals(stderr.map((r) => r.level), ['error']);
  const text = new TextDecoder().decode(result.stdout) +
    new TextDecoder().decode(result.stderr);
  assert(
    !text.includes('credential/CANARY') && !text.includes('pin-canary') &&
      !text.includes('\u001b'),
  );
});
Deno.test('ordinary native diagnostic queue reaches final consumer with before-handle, bounded overflow and truncation facts', async () => {
  const result = await child('queue').output();
  await retain('queue', result);
  assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
  const all = [...records(result.stdout), ...records(result.stderr)];
  assertEquals(all.length, 256);
  assert(
    all.some((r) =>
      r.payload?.includes('before-handle') && r.time_basis === 'captured'
    ),
  );
  assert(all.some((r) => Number(r.dropped) === 348));
  assert(
    all.some((r) =>
      r.nativeEvent === 'ffmpeg' && r.domain === '14' &&
      r.payload.includes('system-ffmpeg')
    ),
  );
  assert(
    all.some((r) =>
      r.nativeEvent === 'libevent' && r.domain === '11' &&
      r.payload.includes('libevent')
    ),
  );
  assert(all.some((r) => r.truncated === '1'));
  assert(
    !new TextDecoder().decode(result.stderr).includes('credential/CANARY'),
  );
});
Deno.test('actual HTTP, DB, command, Pathfinder, metadata debug and node-av events reach normalized stdout/stderr', async () => {
  const result = await child('families').output();
  await retain('families', result);
  assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
  const all = [...records(result.stdout), ...records(result.stderr)];
  for (
    const event of [
      'http_accept',
      'http_headers',
      'http_done',
      'db_begin',
      'db_end',
      'command',
      'dependency_console',
      'dependency_debug',
      'dependency_ffmpeg',
    ]
  ) assert(all.some((r) => r.event === event), event);
  const command = all.find((r) =>
    r.event === 'command' && r.command === 'volume'
  )!;
  assertEquals(command.username, 'attribution');
  assertEquals(command.client, 'logging-consumer');
  assertEquals(JSON.parse(command.facts).volume, 37);
  assert(
    all.some((r) =>
      r.event === 'dependency_debug' &&
      r.namespace === 'music-metadata:logging-fixture'
    ),
  );
  assert(
    all.some((r) =>
      r.event === 'dependency_ffmpeg' &&
      r.payload.includes('node-av-consumer') && r.time_basis === 'observed'
    ),
  );
  const text = new TextDecoder().decode(result.stdout) +
    new TextDecoder().decode(result.stderr);
  for (
    const canary of [
      'user-canary',
      'query-canary',
      'header-canary',
      'sql-canary',
      'credential/CANARY',
    ]
  ) assert(!text.includes(canary), canary);
});
Deno.test('compiled native graph has no enabled raw diagnostic/key-dump bypass; negative writer is rejected', async () => {
  const result = await child('inventory').output();
  await retain('inventory', result);
  assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
  assertEquals(JSON.parse(records(result.stdout)[0].payload), {
    compiledNativeObjects: 11,
    writerViolations: 0,
    negativeRejected: true,
    debugKeyDumpsAbsent: true,
  });
});
Deno.test('fake receiver decodes exact audio and metadata; owned release completes while diagnostics are queued', async () => {
  const result = await child('audio').output();
  await retain('audio', result);
  assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
  const all = [...records(result.stdout), ...records(result.stderr)];
  assert(
    all.some((r) =>
      r.event === 'native_record' && r.nativeEvent === 'device_start' &&
      r.metadata === '7'
    ),
  );
  assert(
    all.some((r) =>
      r.event === 'native_record' && r.nativeEvent === 'pcm_peak' &&
      Number(r.pcm_peak) > 0
    ),
  );
  assertEquals(all.filter((r) => r.nativeEvent === 'probe_queued').length, 100);
  assert(
    all.some((record) =>
      record.event === 'dependency_ffmpeg' &&
      record.payload.includes('node-av-after-raop-adapter') &&
      record.time_basis === 'observed'
    ),
  );
  const outcome = all.find((r) => r.event === 'fixture_info')!;
  assertEquals(JSON.parse(outcome.payload), {
    outcome: 'audio_metadata_release',
    frames: 7040,
    title: 'logging-title',
    queuedBeforeRelease: 100,
    released: true,
  });
  assert(
    all.some((record) =>
      record.nativeEvent === 'libevent' && record.level === 'warn'
    ),
  );
  assert(
    all.some((record) =>
      record.event === 'fixture_info' &&
      JSON.parse(record.payload).outcome === 'failure_release'
    ),
  );
  assert(
    !new TextDecoder().decode(result.stderr).includes('credential/CANARY'),
  );
});
Deno.test('machine RPC replies remain exact protocol bytes with dependency console adapter installed', async () => {
  const process = child('ipc', 'piped').spawn();
  const writer = process.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(
      '{"id":1,"command":"echo","input":{"v":"line\\nquote\\""}}\n{"id":2,"command":"close","input":{}}\n',
    ),
  );
  await writer.close();
  const result = await process.output();
  await retain('ipc', result);
  assertEquals(result.code, 0);
  assertEquals(
    new TextDecoder().decode(result.stdout),
    'DUALHOME:{"id":1,"value":{"v":"line\\nquote\\""}}\nDUALHOME:{"id":2,"value":true}\n',
  );
  assertEquals(result.stderr.length, 0);
});

Deno.test('logging correction: ordinary native owner drains before first handle, after last free and after reload', async () => {
  const result = await child('idle-lifecycle').output();
  await retain('idle-lifecycle', result);
  assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
  const all = [...records(result.stdout), ...records(result.stderr)];
  const outcome = JSON.parse(
    all.find((r) =>
      r.event === 'fixture_info' && r.payload.includes('idle_lifecycle')
    )!.payload,
  );
  assertEquals(
    outcome.phases.map((row: { automatic: boolean }) => row.automatic),
    [true, true, true, true],
    'automatic native delivery must occur in each phase before another handle or shutdown can flush it',
  );
  assertEquals(outcome.consumerReleased, true);
  assertEquals(outcome.releaseCompleted, true);
  assertEquals(all.filter((r) => r.nativeEvent === 'probe_queued').length, 100);
  for (
    const marker of [
      'correction_before_first',
      'correction_after_last_free',
      'correction_new_handle',
      'correction_queued_at_shutdown',
      'correction_reloaded_idle',
    ]
  ) {
    assertEquals(all.filter((r) => r.nativeEvent === marker).length, 1, marker);
  }
  assert(
    all.some((r) => r.nativeEvent === 'pcm_peak' && Number(r.pcm_peak) > 0),
  );
  assert(
    all.filter((r) => r.event === 'native_record').every((r) =>
      !r.dropped || r.dropped === '0'
    ),
  );
  assert(
    !new TextDecoder().decode(result.stderr).includes('credential/CANARY'),
  );
});

Deno.test('logging correction: diagnostic ownership alone never keeps an ordinary child alive', async () => {
  const process = child('idle-exit').spawn();
  let timeout = false;
  const timer = setTimeout(() => {
    timeout = true;
    process.kill('SIGTERM');
  }, 5000);
  try {
    const result = await process.output();
    await retain('idle-exit', result);
    assertEquals(timeout, false);
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    assert(records(result.stdout).some((r) => r.payload === 'idle-owner-exit'));
  } finally {
    clearTimeout(timer);
  }
});
