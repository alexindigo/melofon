import { assert, assertEquals } from '@std/assert';
import { parseLogfmt } from './helpers/logging.ts';
import { NATIVE_CHANGED } from './helpers/native-changes.ts';

const permissions = [
  '--allow-run',
  '--allow-net',
  '--allow-env',
  '--allow-read',
  '--allow-write',
  '--allow-ffi',
  '--allow-sys',
];
const inherited: Record<string, string> = {};
for (const key of ['HOME', 'PATH', 'DENO_DIR', 'TMPDIR', 'MELOFON_RAOP_LIB']) {
  const value = Deno.env.get(key);
  if (value) inherited[key] = value;
}
function child(
  mode: string,
  options: { env?: Record<string, string>; signal?: AbortSignal } = {},
): Deno.Command {
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
    env: { ...inherited, DEBUG: 'music-metadata:*', ...options.env },
    stdout: 'piped',
    stderr: 'piped',
    stdin: 'null',
    signal: options.signal,
  });
}
function records(bytes: Uint8Array) {
  return new TextDecoder().decode(bytes).trim().split('\n').filter(Boolean).map(
    parseLogfmt,
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
      ...inherited,
      MELOFON_PASSWORD: 'credential/CANARY',
      MELOFON_LISTEN: 'invalid-listen-credential/CANARY',
    },
    stdout: 'piped',
    stderr: 'piped',
  }).output();
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
  // Forged JOURNAL_STREAM (not this pipe's dev:ino): no priority prefix.
  const forged = await child('streams', {
    env: { JOURNAL_STREAM: '1:2' },
  }).output();
  assertEquals(forged.code, 0, new TextDecoder().decode(forged.stderr));
  assert(!/^<\d>/m.test(new TextDecoder().decode(forged.stdout)));
  assert(!/^<\d>/m.test(new TextDecoder().decode(forged.stderr)));
});
Deno.test({
  name:
    'ordinary native diagnostic queue reaches final consumer with before-handle, bounded overflow and truncation facts',
  ignore: !NATIVE_CHANGED,
  fn: async () => {
    const result = await child('queue').output();
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
  },
});
Deno.test('actual HTTP, DB, command, Pathfinder, metadata debug and node-av events reach normalized stdout/stderr', async () => {
  const result = await child('families').output();
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
Deno.test({
  name:
    'compiled native graph has no enabled raw diagnostic/key-dump bypass; negative writer is rejected',
  ignore: !NATIVE_CHANGED,
  fn: async () => {
    const result = await child('inventory').output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    assertEquals(JSON.parse(records(result.stdout)[0].payload), {
      compiledNativeObjects: 11,
      writerViolations: 0,
      negativeRejected: true,
      debugKeyDumpsAbsent: true,
    });
  },
});

Deno.test({
  name:
    'logging correction: ordinary native owner drains before first handle, after last free and after reload',
  ignore: !NATIVE_CHANGED,
  fn: async () => {
    const result = await child('idle-lifecycle').output();
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
    assertEquals(
      all.filter((r) => r.nativeEvent === 'probe_queued').length,
      100,
    );
    for (
      const marker of [
        'correction_before_first',
        'correction_after_last_free',
        'correction_new_handle',
        'correction_queued_at_shutdown',
        'correction_reloaded_idle',
      ]
    ) {
      assertEquals(
        all.filter((r) => r.nativeEvent === marker).length,
        1,
        marker,
      );
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
  },
});

Deno.test('logging correction: diagnostic ownership alone never keeps an ordinary child alive', async () => {
  const result = await child('idle-exit', {
    signal: AbortSignal.timeout(5000),
  }).output();
  assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
  assert(records(result.stdout).some((r) => r.payload === 'idle-owner-exit'));
});
