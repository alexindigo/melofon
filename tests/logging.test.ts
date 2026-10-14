import { assert, assertEquals, assertThrows } from '@std/assert';
import { createLogger, journalDestination } from '../src/logging.ts';
import { captureLogs, parseLogfmt } from './helpers/logging.ts';

Deno.test('logfmt consumer sees full UTC, stable fields, types, framing and streams', async () => {
  const capture = captureLogs();
  capture.log.event('fixture_info', {
    payload: {
      finite: 1.25,
      yes: true,
      none: null,
      absent: undefined,
      nested: ['a b', 'quote"slash\\/\n\r\t\u0000', '\ud800'],
      controls: '\u001b[31mred\u001b[0m\u0085\u2028',
    },
  });
  capture.log.event('fixture_warn', { payload: 'warning' });
  capture.log.event('fixture_error', {
    payload: new Error('multiline\nsecond\rthird'),
  });
  await capture.log.flush();
  assertEquals(capture.stdout.length, 2);
  assertEquals(capture.stderr.length, 1);
  for (const line of [...capture.stdout, ...capture.stderr]) {
    assertEquals(line.split('\n').length, 2);
    assert(!line.slice(0, -1).includes('\r'));
    assert(!line.includes('\u001b'));
    const record = parseLogfmt(line.trimEnd());
    assertEquals(record.time, '2026-10-07T21:34:56.789Z');
    assertEquals(Object.keys(record).slice(0, 4), [
      'time',
      'level',
      'component',
      'event',
    ]);
    assertEquals(record.component, 'logging');
  }
  const payload = JSON.parse(capture.records()[0].payload);
  assertEquals(payload, {
    finite: 1.25,
    yes: true,
    none: null,
    nested: ['a b', 'quote"slash\\/\n\r\t\u0000', '\ufffd'],
    controls: '[ansi]red[ansi]\u0085\u2028',
  });
  assertEquals(capture.records().map((r) => r.level), [
    'info',
    'warn',
    'error',
  ]);
  assertThrows(() => parseLogfmt('bad.key=x'));
  assertThrows(() => parseLogfmt('key=x key=y'));
});

Deno.test('central HTTP projection redacts mixed-case, encoded queries, userinfo and headers without bodies', () => {
  const capture = captureLogs();
  const request = new Request(
    'http://localhost/path?U=auth-user&P=auth-password&%74=auth-token&S=auth-salt&API_key=auth-api&%2570=double-encoded&c=client',
    {
      method: 'POST',
      body: 'body-secret',
      headers: {
        Authorization: 'Bearer header-secret',
        Cookie: 'cookie-secret',
        'x-api-key': 'key-secret',
        'x-pin': 'pin-secret',
        'user-agent': 'fixture-client',
      },
    },
  );
  capture.log.event('http_accept', {
    request,
    req: 1,
    inflight: 1,
    peer: 'peer',
    traceHeaders: true,
  });
  const record = capture.records()[0];
  const url = new URL(record.url);
  for (const key of ['U', 'P', 't', 'S', 'API_key', '%70']) {
    assertEquals(url.searchParams.get(key), '[redacted]');
  }
  assertEquals(url.searchParams.get('c'), 'client');
  const headers = JSON.parse(record.headers);
  assertEquals(headers.authorization, '[redacted]');
  assertEquals(headers.cookie, '[redacted]');
  assertEquals(headers['x-api-key'], '[redacted]');
  assertEquals(headers['x-pin'], '[redacted]');
  assertEquals(headers['user-agent'], 'fixture-client');
  assertEquals(request.headers.get('authorization'), 'Bearer header-secret');
  assert(!capture.lines.join().includes('body-secret'));
});

Deno.test('known credentials and nested sensitive facts cannot escape through errors or external payloads', () => {
  const capture = captureLogs();
  const secret = 'credential/CANARY';
  capture.log.registerSecrets([secret]);
  const cause = new Error(`cause ${secret}`);
  Object.assign(cause, {
    code: 'E_CANARY',
    PIN: 'pin-canary',
    object: { apiKey: 'api-canary' },
  });
  const error = new Error(`failure ${encodeURIComponent(secret)}`, { cause });
  capture.log.event('content_failed', {
    output: 'fixture',
    generation: 9,
    error,
  });
  capture.log.event('native_record', {
    severity: 1,
    domain: 17,
    timeMs: 1234,
    nativeSequence: 7,
    nativeEvent: 'printf',
    payload: `opaque ${secret}\nforged-record\u001b[1m`,
  });
  capture.log.event('dependency_debug', {
    namespace: 'music-metadata:test',
    args: [{
      nested: { password: 'password-canary' },
      url: new URL('https://name:pass@example.test/?Token=url-canary'),
    }, secret],
  });
  const combined = capture.lines.join('\n');
  for (
    const canary of [
      secret,
      encodeURIComponent(secret),
      'pin-canary',
      'api-canary',
      'password-canary',
      'url-canary',
    ]
  ) assert(!combined.includes(canary), canary);
  const normalized = JSON.parse(capture.records()[0].error);
  assertEquals(normalized.name, 'Error');
  assertEquals(normalized.cause.code, 'E_CANARY');
  assert(normalized.stack.includes('[redacted]'));
  assertEquals(capture.records()[1].time, '1970-01-01T00:00:01.234Z');
  assertEquals(capture.records()[1].time_basis, 'captured');
});

Deno.test('SQL traces project operations and identifiers, never literals or unparseable full text', () => {
  const capture = captureLogs();
  for (
    const sql of [
      "SELECT 'literal-canary' FROM users",
      "-- comment-canary\nINSERT INTO state VALUES ('bind-canary')",
      'nonsense unknown-canary',
      'SELECT $$dollar-canary$$',
      'UPDATE output_state SET pin = ?',
    ]
  ) {
    capture.log.event('db_begin', { sql, qinflight: 1 });
  }
  assertEquals(capture.records().map((r) => r.operation), [
    'SELECT',
    'INSERT',
    'unknown',
    'SELECT',
    'UPDATE',
  ]);
  assertEquals(capture.records().map((r) => r.identifier), [
    'users',
    'state',
    undefined,
    undefined,
    'output_state',
  ]);
  assert(!capture.lines.join().includes('canary'));
});

Deno.test('native opaque authentication header diagnostics are centrally redacted', () => {
  const capture = captureLogs();
  capture.log.event('native_record', {
    severity: 4,
    domain: 17,
    timeMs: 1234,
    nativeSequence: 1,
    nativeEvent: 'printf',
    payload:
      'Authorization header: Digest username="native-user-canary",response="digest-canary"\nCookie: native-cookie-canary\n',
  });
  for (
    const canary of [
      'native-user-canary',
      'digest-canary',
      'native-cookie-canary',
    ]
  ) assert(!capture.lines.join().includes(canary), canary);
});

Deno.test('SQL lexical projection cannot promote comment/literal contents or malformed quoted text into identifiers', () => {
  const capture = captureLogs();
  for (
    const sql of [
      "SELECT '-- literal\n FROM secret_canary'",
      "SELECT 'unterminated FROM secret_canary",
      'SELECT $$--\n FROM secret_canary$$',
      '/* unfinished FROM secret_canary',
      "SELECT '/* literal */' FROM users",
    ]
  ) capture.log.event('db_begin', { sql, qinflight: 1 });
  assert(!capture.lines.join().includes('secret_canary'));
  assertEquals(capture.records().map((row) => row.operation), [
    'SELECT',
    'unknown',
    'SELECT',
    'unknown',
    'SELECT',
  ]);
  assertEquals(capture.records().at(-1)!.identifier, 'users');
});

Deno.test('normalization snapshots data without getters, inspection or toJSON; loss is explicit', async () => {
  const capture = captureLogs();
  let invoked = 0;
  const object: Record<string, unknown> = {
    text: 'before',
    long: 'x'.repeat(10000),
    toJSON() {
      invoked++;
    },
  };
  Object.defineProperty(object, 'getter', {
    enumerable: true,
    get() {
      invoked++;
      throw new Error('getter');
    },
  });
  object.cycle = object;
  capture.log.event('fixture_info', { payload: object });
  object.text = 'after';
  await capture.log.flush();
  assertEquals(invoked, 0);
  const record = capture.records()[0];
  assertEquals(JSON.parse(record.payload).text, 'before');
  assertEquals(record.accessors_omitted, '1');
  assertEquals(record.cycles, '1');
  assertEquals(record.truncated, '1');
  const proxy = new Proxy({}, {
    ownKeys() {
      throw new Error('uninspectable');
    },
  });
  capture.log.event('fixture_info', { payload: proxy });
  assertEquals(capture.records()[1].normalization_failures, '1');
});

Deno.test('Error projection retains intrinsic stacks without custom accessor, formatter or coercion execution', () => {
  const capture = captureLogs();
  let calls = 0;
  const normal = new Error('ordinary-stack');
  Object.defineProperty(normal, 'toString', {
    value() {
      calls++;
      return 'unsafe';
    },
  });
  capture.log.event('fixture_error', { payload: normal });
  assert(
    JSON.parse(capture.records()[0].payload).stack.includes('ordinary-stack'),
  );
  const custom = new Error('custom');
  Object.defineProperty(custom, 'stack', {
    get() {
      calls++;
      return 'unsafe';
    },
  });
  capture.log.event('fixture_error', { payload: custom });
  assertEquals(
    JSON.parse(capture.records()[1].payload).stack_unavailable,
    'custom_accessor',
  );
  const formatter = Error as typeof Error & { prepareStackTrace?: unknown };
  const previous = Object.getOwnPropertyDescriptor(
    formatter,
    'prepareStackTrace',
  );
  try {
    Object.defineProperty(formatter, 'prepareStackTrace', {
      configurable: true,
      value() {
        calls++;
        return 'unsafe';
      },
    });
    capture.log.event('fixture_error', { payload: new Error('formatter') });
    assertEquals(
      JSON.parse(capture.records()[2].payload).stack_unavailable,
      'custom_formatter',
    );
    Object.defineProperty(formatter, 'prepareStackTrace', {
      configurable: true,
      get() {
        calls++;
        return undefined;
      },
    });
    capture.log.event('fixture_error', {
      payload: new Error('formatter-getter'),
    });
    assertEquals(
      JSON.parse(capture.records()[3].payload).stack_unavailable,
      'custom_formatter',
    );
  } finally {
    if (previous) {
      Object.defineProperty(formatter, 'prepareStackTrace', previous);
    } else Reflect.deleteProperty(formatter, 'prepareStackTrace');
  }
  const name = new Error('name');
  Object.defineProperty(name, 'name', {
    get() {
      calls++;
      return 'unsafe';
    },
  });
  capture.log.event('fixture_error', { payload: name });
  assertEquals(
    JSON.parse(capture.records()[4].payload).stack_unavailable,
    'unsafe_error_field',
  );
  const message = new Error('message');
  Object.defineProperty(message, 'message', {
    value: {
      toString() {
        calls++;
        return 'unsafe';
      },
    },
  });
  capture.log.event('fixture_error', { payload: message });
  assertEquals(
    JSON.parse(capture.records()[5].payload).stack_unavailable,
    'unsafe_error_field',
  );
  assertEquals(calls, 0);
});

Deno.test('provenance keeps attribution and rejects reserved-key injection', () => {
  const capture = captureLogs();
  capture.log.event('command', {
    command: 'seek',
    source: {
      kind: 'http',
      peer: 'peer',
      user: 'attributed-user',
      client: 'client',
      userAgent: 'agent',
    },
    facts: {
      position_ms: 4000,
      time: 'forged',
      level: 'fatal',
      PIN: 'secret-pin',
    },
  });
  const record = capture.records()[0];
  assertEquals(record.username, 'attributed-user');
  assertEquals(record.kind, 'http');
  assertEquals(record.level, 'info');
  assertEquals(JSON.parse(record.facts).PIN, '[redacted]');
});

Deno.test('public attribution identities remain distinct from identical authentication/opaque values', () => {
  const capture = captureLogs();
  capture.log.registerSecrets(['smoke']);
  capture.log.event('command', {
    command: 'volume',
    facts: { volume: 75 },
    source: {
      kind: 'http',
      peer: '127.0.0.1',
      user: 'smoke',
      client: 'atv3-smoke',
      userAgent: 'opaque smoke agent',
    },
  });
  capture.log.event('dependency_console', { method: 'log', args: ['smoke'] });
  capture.log.event('http_accept', {
    request: new Request('http://localhost/?u=smoke&p=smoke'),
    req: 1,
    inflight: 1,
    peer: '127.0.0.1',
    traceHeaders: true,
  });
  const records = capture.records();
  assertEquals(records[0].username, 'smoke');
  assertEquals(records[0].client, 'atv3-smoke');
  assert(!records[0].userAgent.includes('smoke'));
  assert(!records[1].args.includes('smoke'));
  assert(!records[2].url.includes('smoke'));
});

Deno.test('destination identity controls prefixes and normalized severity controls priority', () => {
  assert(journalDestination('12:34', { dev: 12, ino: 34 }));
  assert(!journalDestination('12:34', { dev: 12, ino: 35 }));
  assert(!journalDestination('garbage', { dev: 12, ino: 34 }));
  const stdout: string[] = [], stderr: string[] = [];
  const log = createLogger({
    journal: { stdout: true, stderr: true },
    sinks: {
      stdout: (line) => {
        stdout.push(line);
      },
      stderr: (line) => {
        stderr.push(line);
      },
    },
  });
  log.event('fixture_info', {});
  log.event('fixture_warn', {});
  log.event('fixture_error', {});
  assert(stdout[0].startsWith('<6>time='));
  assert(stdout[1].startsWith('<4>time='));
  assert(stderr[0].startsWith('<3>time='));
});

Deno.test('serialized sinks, failure and overflow preserve the application error and observable loss', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lines: string[] = [];
  const log = createLogger({
    maxQueued: 1,
    sinks: {
      stdout: (line) => {
        lines.push(line);
        return lines.length === 1 ? gate : undefined;
      },
      stderr() {
        throw new Error('sink unavailable');
      },
    },
  });
  const original = new Error('application error');
  log.event('fixture_info', { payload: 'one' });
  log.event('fixture_info', { payload: 'two' });
  log.event('fixture_info', { payload: 'overflow' });
  log.event('fixture_error', { payload: original });
  assertEquals(lines.length, 1);
  release();
  await log.flush();
  assertEquals<Record<string, number>>(log.stats(), {
    failures: 1,
    dropped: 1,
    sinkFailures: 1,
    normalizationFailures: 0,
  });
  log.event('fixture_info', { payload: 'after' });
  const record = parseLogfmt(lines.at(-1)!.trimEnd());
  assertEquals(record.sink_failures, '1');
  assertEquals(record.sink_dropped, '1');
  assertEquals(original.message, 'application error');
});

Deno.test('serialized UTF-8 record size remains bounded and independently parsable after escape expansion', () => {
  const capture = captureLogs();
  capture.log.event('fixture_info', {
    payload: Array.from({ length: 64 }, () => '\u0000😀'.repeat(1000)),
  });
  assert(new TextEncoder().encode(capture.stdout[0]).length <= 12000);
  assertEquals(JSON.parse(capture.records()[0].record_truncated_fields), [
    'payload',
  ]);
  assertEquals(
    JSON.parse(capture.records()[0].payload).truncated,
    'record_size_bound',
  );
});

Deno.test('uninspectable raw event facts produce an explicit diagnostic without executing proxy traps', () => {
  const capture = captureLogs();
  let calls = 0;
  const raw = new Proxy({}, {
    ownKeys() {
      calls++;
      throw new Error('trap');
    },
  });
  capture.log.event('fixture_info', raw);
  assertEquals(calls, 0);
  assertEquals(capture.records()[0].event, 'normalization_failed');
  assertEquals(capture.records()[0].failedEvent, 'fixture_info');
});

Deno.test('logging correction: SQL executable tokens exclude escape strings and nested comments', () => {
  const capture = captureLogs();
  const canary = 'secret_canary'; // Deliberately never registered as a secret.
  const protectedRegions = [
    String.raw`E'it\'s FROM secret_canary --'`,
    String.raw`e'back\\slash \' FROM secret_canary --'`,
    "'doubled '' FROM secret_canary'",
    '"quoted "" FROM secret_canary"',
    '$$ FROM secret_canary /* -- $$',
    '$tag$ FROM secret_canary \' "$tag$',
    '/* outer /* inner */ FROM secret_canary */',
    '/* outer /* middle /* inner */ FROM secret_canary */ still outer */',
  ];
  const cases: { sql: string; operation: string; identifier?: string }[] = [];
  for (const region of protectedRegions) {
    for (const prefix of ['', '/* leading */ ', '-- leading\n']) {
      for (
        const suffix of [
          '',
          ' FROM safe_relation',
          ' /* between */ FROM safe_schema.safe_relation',
        ]
      ) {
        cases.push({
          sql: `${prefix}SELECT ${region}${suffix}`,
          operation: 'SELECT',
          identifier: suffix.includes('FROM')
            ? (suffix.includes('safe_schema')
              ? 'safe_schema.safe_relation'
              : 'safe_relation')
            : undefined,
        });
      }
    }
  }
  for (const region of protectedRegions.filter((r) => r.startsWith('/*'))) {
    cases.push({
      sql: `SELECT 1 ${region} FROM safe_relation`,
      operation: 'SELECT',
      identifier: 'safe_relation',
    });
  }
  for (
    const sql of [
      String.raw`SELECT E'it\'s FROM secret_canary`,
      "SELECT 'unfinished FROM secret_canary",
      'SELECT "unfinished FROM secret_canary',
      'SELECT $tag$ FROM secret_canary',
      'SELECT 1 /* outer /* inner */ FROM secret_canary',
      'SELECT 1 */ FROM secret_canary',
      "SELECT U&'unsupported FROM secret_canary'",
      `SELECT '${'x'.repeat(70000)}' FROM secret_canary`,
    ]
  ) cases.push({ sql, operation: 'unknown' });
  cases.push(
    {
      sql: 'INSERT INTO safe_relation VALUES (?)',
      operation: 'INSERT',
      identifier: 'safe_relation',
    },
    {
      sql: 'UPDATE safe_relation SET value = ?',
      operation: 'UPDATE',
      identifier: 'safe_relation',
    },
    {
      sql: 'CREATE TABLE IF NOT EXISTS safe_relation (value INTEGER)',
      operation: 'CREATE',
      identifier: 'safe_relation',
    },
    {
      sql: 'DROP TABLE IF EXISTS safe_relation',
      operation: 'DROP',
      identifier: 'safe_relation',
    },
    { sql: 'nonsense FROM secret_canary', operation: 'unknown' },
    { sql: 'SELECT 1 FROM "secret_canary"', operation: 'SELECT' },
  );
  for (const { sql } of cases) {
    capture.log.event('db_begin', { sql, qinflight: 1 });
    capture.log.event('db_end', { sql, waitMs: 1 });
  }
  for (let i = 0; i < cases.length; i++) {
    for (const row of capture.records().slice(i * 2, i * 2 + 2)) {
      assert(
        !JSON.stringify(row).includes(canary),
        `opaque SQL leaked in ${i}`,
      );
      assertEquals(row.operation, cases[i].operation, `operation ${i}`);
      assertEquals(row.identifier, cases[i].identifier, `identifier ${i}`);
      assertEquals(row.sql, undefined);
    }
  }
});

Deno.test('logging correction: exhausted Error field lookup never authorizes custom getters or coercion', () => {
  const capture = captureLogs();
  const counts = { name: 0, message: 0, coercion: 0, proxy: 0 };
  for (const key of ['name', 'message'] as const) {
    const error = new Error();
    const holder = Object.create(Error.prototype);
    Object.defineProperty(holder, key, {
      get() {
        counts[key]++;
        return 'custom';
      },
    });
    let chain = holder;
    for (let i = 0; i < 10; i++) chain = Object.create(chain);
    Object.setPrototypeOf(error, chain);
    capture.log.event('fixture_error', { payload: error });
  }
  const unsafe = new Error();
  const holder = Object.create(Error.prototype, {
    message: {
      value: {
        toString() {
          counts.coercion++;
          return 'custom';
        },
      },
    },
  });
  let chain = holder;
  for (let i = 0; i < 10; i++) chain = Object.create(chain);
  Object.setPrototypeOf(unsafe, chain);
  capture.log.event('fixture_error', { payload: unsafe });
  const proxy = new Error();
  Object.setPrototypeOf(
    proxy,
    new Proxy(Error.prototype, {
      getPrototypeOf() {
        counts.proxy++;
        return null;
      },
      getOwnPropertyDescriptor() {
        counts.proxy++;
        return undefined;
      },
      get() {
        counts.proxy++;
        return 'custom';
      },
    }),
  );
  capture.log.event('fixture_error', { payload: proxy });
  const ordinary = new Error('ordinary-retained');
  capture.log.event('fixture_error', { payload: ordinary });
  const absent = new Error();
  Object.setPrototypeOf(absent, null);
  capture.log.event('fixture_error', { payload: absent });
  const materialized = new Error();
  Object.setPrototypeOf(materialized, chain);
  Object.defineProperty(materialized, 'stack', {
    value: 'already-materialized',
  });
  capture.log.event('fixture_error', { payload: materialized });
  assertEquals(counts, { name: 0, message: 0, coercion: 0, proxy: 0 });
  const payloads = capture.records().map((row) => JSON.parse(row.payload));
  for (const payload of payloads.slice(0, 4)) {
    assert(payload.stack_unavailable);
    assertEquals(payload.stack, undefined);
  }
  assert(payloads[4].stack.includes('ordinary-retained'));
  assert(typeof payloads[5].stack === 'string');
  assertEquals(payloads[6].stack, 'already-materialized');
});

Deno.test('logging correction: exhausted constructor formatter lookup is uninspectable rather than absent', () => {
  const capture = captureLogs();
  let calls = 0;
  const original = Object.getPrototypeOf(Error);
  const own = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  try {
    Reflect.deleteProperty(Error, 'prepareStackTrace');
    const holder = Object.create(original, {
      prepareStackTrace: {
        value() {
          calls++;
          return 'custom-formatted';
        },
      },
    });
    let chain = holder;
    for (let i = 0; i < 10; i++) chain = Object.create(chain);
    Object.setPrototypeOf(Error, chain);
    capture.log.event('fixture_error', {
      payload: new Error('formatter-bound'),
    });
  } finally {
    Object.setPrototypeOf(Error, original);
    if (own) Object.defineProperty(Error, 'prepareStackTrace', own);
    else Reflect.deleteProperty(Error, 'prepareStackTrace');
  }
  assertEquals(calls, 0);
  const payload = JSON.parse(capture.records()[0].payload);
  assert(payload.stack_unavailable);
  assertEquals(payload.stack, undefined);
});

Deno.test('logging correction: normalization rejection cannot be attributed to a healthy sink', async () => {
  const capture = captureLogs();
  let calls = 0;
  capture.log.event(
    'fixture_info',
    new Proxy({}, {
      ownKeys() {
        calls++;
        throw new Error('custom trap');
      },
    }),
  );
  capture.log.event('fixture_info', {
    payload: {
      nested: new Proxy({}, {
        get() {
          calls++;
        },
      }),
    },
  });
  capture.log.event('fixture_info', { payload: 'healthy-after' });
  await capture.log.flush();
  assertEquals(calls, 0);
  const rows = capture.records();
  assertEquals(rows[0].event, 'normalization_failed');
  assertEquals(rows[1].normalization_failures, '1');
  assertEquals(rows[2].sink_failures, undefined);
  assertEquals(rows[2].normalization_failed_events, '1');
  assertEquals(rows[2].normalization_failures, undefined);
  assertEquals<Record<string, number>>(capture.log.stats(), {
    failures: 1,
    dropped: 0,
    sinkFailures: 0,
    normalizationFailures: 1,
  });
});

Deno.test('logging correction: sync and async sink faults have independent cumulative accounting and overflow', async () => {
  const lines: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  const log = createLogger({
    maxQueued: 1,
    sinks: {
      stdout(line) {
        lines.push(line);
        writes++;
        if (writes === 1) throw new Error('sync sink');
        if (writes === 2) return Promise.reject(new Error('async sink'));
        if (writes === 3) return pending;
      },
      stderr(line) {
        lines.push(line);
      },
    },
  });
  const error = new Error('original-application-error');
  log.event('fixture_info', {});
  log.event('fixture_info', {});
  await log.flush();
  log.event('fixture_info', new Proxy({}, {}));
  log.event('fixture_info', { payload: error });
  log.event('fixture_info', {});
  log.event('fixture_info', {});
  release();
  await log.flush();
  log.event('fixture_info', { payload: 'final' });
  assertEquals<Record<string, number>>(log.stats(), {
    failures: 3,
    dropped: 1,
    sinkFailures: 2,
    normalizationFailures: 1,
  });
  const final = parseLogfmt(lines.at(-1)!.trimEnd());
  assertEquals(final.sink_failures, '2');
  assertEquals(final.normalization_failed_events, '1');
  assertEquals(final.sink_dropped, '1');
  assertEquals(error.message, 'original-application-error');
});
