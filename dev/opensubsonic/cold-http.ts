// Bounded socket consumer for the approved H1 protocol boundary. Exactly one
// owned main.ts child, private frozen inputs/data, retained evidence on failure.
// This driver never selects an output or touches a household database.
import { createHash } from 'node:crypto';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`OpenSubsonic cold consumer: ${message}`);
}

function option(name: string): string {
  const value = Deno.args.find((arg) => arg.startsWith(`--${name}=`))?.slice(
    name.length + 3,
  );
  check(value, `missing --${name}`);
  return value;
}

const started = performance.now();
const phase = option('phase');
check(phase === 'H1', 'only implemented phase H1 is accepted');
const candidate = await Deno.realPath(option('candidate-root'));
const item = candidate.slice(0, -'/source'.length);
check(
  /^\/home\/tester\/melofon-output-preparation-01\/opensubsonic-highest-01\/H01(?:\/verification-\d+)?\/source$/
    .test(candidate),
  'candidate outside approved disk root',
);
check(
  await Deno.realPath(new URL('../../', import.meta.url)) === candidate,
  'driver and candidate source differ',
);
const evidence = option('evidence');
check(
  evidence.startsWith(`${item}/evidence/`) && !evidence.includes('/../'),
  'evidence outside item',
);
check(Deno.uid() === 1000 && Deno.gid() === 1000, 'wrong guest account');
check(Deno.env.get('HOME') === '/home/tester', 'wrong guest home');
check(Deno.env.get('TMPDIR') === `${item}/tmp`, 'wrong private TMPDIR');
check(
  Deno.env.get('DENO_DIR') === `${item}/runtime/deno-dir`,
  'wrong private DENO_DIR',
);
check(Deno.execPath() === '/home/tester/.deno/bin/deno', 'wrong executable');
const native = Deno.env.get('MELOFON_RAOP_LIB');
check(
  native === `${item}/artifacts/libmelofon_raop.so`,
  'wrong private native input',
);
await Deno.mkdir(evidence, { mode: 0o700 }); // collision is a failure, never replay
check(
  await Deno.realPath(evidence) === evidence,
  'evidence path must be canonical',
);

async function hash(path: string): Promise<string> {
  const h = createHash('sha256');
  using file = await Deno.open(path);
  const buffer = new Uint8Array(64 * 1024);
  for (;;) {
    const size = await file.read(buffer);
    if (size === null) break;
    h.update(buffer.subarray(0, size));
  }
  return h.digest('hex');
}

async function write(name: string, value: unknown) {
  await Deno.writeTextFile(
    `${evidence}/${name}.json`,
    JSON.stringify(value, null, 2) + '\n',
    { createNew: true },
  );
}

const boot = (await Deno.readTextFile('/proc/sys/kernel/random/boot_id'))
  .trim();
async function identity(pid: number) {
  const raw = await Deno.readTextFile(`/proc/${pid}/stat`);
  return {
    pid,
    boot,
    startTicks: raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19],
    argv: (await Deno.readTextFile(`/proc/${pid}/cmdline`)).split('\0').filter(
      Boolean,
    ),
    cgroup: await Deno.readTextFile(`/proc/${pid}/cgroup`),
  };
}

const abort = new AbortController();
let failure: unknown;
let child: Deno.ChildProcess | undefined;
let childIdentity: Awaited<ReturnType<typeof identity>> | undefined;
let cleanup: Promise<void> | undefined;
let childStatus: Deno.CommandStatus | undefined;
const pumps: Promise<void>[] = [];
const assertions: string[] = [];
const receipts: unknown[] = [];
function latch(error: unknown) {
  failure ??= error;
  abort.abort(error);
}

function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('owned operation deadline exceeded')),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

async function stopOwnedChild() {
  if (cleanup) return await cleanup;
  cleanup = (async () => {
    if (!child) return;
    const owned = child;
    if (!childStatus) {
      const current = await identity(owned.pid).catch(() => undefined);
      if (current) {
        check(
          childIdentity && current.startTicks === childIdentity.startTicks &&
            current.boot === childIdentity.boot &&
            JSON.stringify(current.argv) ===
              JSON.stringify(childIdentity.argv) &&
            current.cgroup === childIdentity.cgroup,
          'child ownership changed',
        );
        owned.kill('SIGTERM');
      }
      try {
        childStatus = await bounded(owned.status, 5_000);
      } catch (error) {
        // The handle and observed start identity identify only this child.
        const current = await identity(owned.pid);
        check(
          current.startTicks === childIdentity?.startTicks,
          'cleanup identity changed',
        );
        owned.kill('SIGKILL');
        childStatus = await bounded(owned.status, 3_000);
        latch(error); // forced cleanup cannot produce a success marker
      }
    }
    await bounded(Promise.all(pumps), 1_500);
    check(
      childStatus.success && childStatus.code === 0,
      `child exit ${childStatus.code}`,
    );
  })();
  return await cleanup;
}

const onSignal = () => latch(new Error('driver interrupted'));
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  Deno.addSignalListener(signal, onSignal);
}
const activeTimer = setTimeout(
  () => latch(new Error('270s active-work deadline exceeded')),
  270_000,
);
const cleanupTimer = setTimeout(() => {
  latch(new Error('280s shutdown deadline'));
  void stopOwnedChild().catch(latch);
}, 280_000);
const hardTimer = setTimeout(() => {
  Deno.writeTextFileSync(
    `${evidence}/hard-timeout.json`,
    JSON.stringify({
      phase,
      incomplete: true,
      driverPid: Deno.pid,
      childPid: child?.pid,
      boot,
    }) + '\n',
    { createNew: true },
  );
  Deno.exit(1);
}, 300_000);

const BASE = 'http://127.0.0.1:14138';
const AUTH = new URLSearchParams({
  u: 'H1 + 雪',
  p: 'p&=+% café 🔑',
  v: '1.16.1',
  c: 'H1 + 雪',
  f: 'json',
});
const EXPECTED = [{ name: 'formPost', versions: [1] }];

async function request(
  path: string,
  init: RequestInit = {},
  base = BASE,
  remainingMs = 10_000,
) {
  check(performance.now() - started < 270_000, 'active work deadline');
  abort.signal.throwIfAborted();
  const url = new URL(path, base);
  const redacted = new URL(url);
  for (const key of ['u', 'p', 't', 's', 'apiKey']) {
    if (redacted.searchParams.has(key)) {
      redacted.searchParams.set(key, '[redacted]');
    }
  }
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.any([
      abort.signal,
      AbortSignal.timeout(
        Math.max(1, Math.ceil(Math.min(10_000, remainingMs))),
      ),
    ]),
  });
  const text = await response.text();
  const receipt = {
    at: new Date().toISOString(),
    method: init.method ?? 'GET',
    url: redacted.href,
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: text,
  };
  receipts.push(receipt);
  await Deno.writeTextFile(
    `${evidence}/requests.ndjson`,
    JSON.stringify(receipt) + '\n',
    { append: true },
  );
  return { ...receipt, json: () => JSON.parse(text) };
}

function proved(condition: unknown, name: string) {
  check(condition, name);
  assertions.push(name);
}

try {
  await write('driver-identity', {
    taskRoot: item,
    candidateRoot: candidate,
    evidence,
    phase,
    identity: await identity(Deno.pid),
  });
  const pins = {
    deno: await hash(Deno.execPath()),
    native: await hash(native),
    lock: await hash(`${candidate}/deno.lock`),
    driver: await hash(new URL(import.meta.url).pathname),
    main: await hash(`${candidate}/main.ts`),
    capabilities: await hash(
      `${candidate}/layers/opensubsonic/capabilities.ts`,
    ),
    auth: await hash(`${candidate}/layers/opensubsonic/rest/10-auth.ts`),
  };
  await write('pins', pins);
  check(
    pins.deno ===
        'bceb5b6a6239b0b010418406d8c77a508f67cf4337d94288f1c19fe71304aab0' &&
      pins.native ===
        'abe4ef188c6bdf8d0a41064ee3c4f4f86067ee93da1b65ce9e211d576f04c873' &&
      pins.lock ===
        '081f34b078d049e32f4150c86667c60717a2bd78caae5a06381fb95f2f5cde67',
    'runtime/native/lock drift',
  );
  for (const port of [14138, 14689, 14688]) {
    const listener = Deno.listen({ hostname: '127.0.0.1', port });
    listener.close();
  }
  // Only the application child opens this fresh database. Fixture setup uses
  // its existing HTTP services, never a driver connection or second writer.
  const data = `${evidence}/fixture-data`;
  await Deno.mkdir(data, { mode: 0o700 });
  abort.signal.throwIfAborted();
  const args = [
    'run',
    `--config=${candidate}/deno.json`,
    '--frozen',
    '--cached-only',
    '--node-modules-dir=manual',
    '--allow-net',
    '--allow-env',
    '--allow-read',
    '--allow-write',
    '--allow-ffi',
    '--allow-sys',
    `${candidate}/main.ts`,
  ];
  const env = {
    HOME: '/home/tester',
    PATH: '/home/tester/.deno/bin:/usr/bin:/bin',
    DENO_DIR: `${item}/runtime/deno-dir`,
    TMPDIR: `${item}/tmp`,
    MELOFON_DATA: data,
    MELOFON_USER: AUTH.get('u')!,
    MELOFON_PASSWORD: AUTH.get('p')!,
    MELOFON_SECRET: 'H1-fixture-secret',
    MELOFON_LISTEN: '127.0.0.1:14138',
    MELOFON_LISTEN_owntone: '14689,14688',
    MELOFON_AIRPLAY_MDNS: 'off',
    MELOFON_RAOP_LIB: native,
  };
  await write('child-launch', {
    executable: Deno.execPath(),
    args,
    cwd: candidate,
    clearEnv: true,
    env,
    testOnlyCredentials: true,
    boot,
    driverPid: Deno.pid,
    childPid: null,
    taskRoot: item,
  });
  const stdout = await Deno.open(`${evidence}/child.stdout.log`, {
    createNew: true,
    write: true,
  });
  const stderr = await Deno.open(`${evidence}/child.stderr.log`, {
    createNew: true,
    write: true,
  });
  child = new Deno.Command(Deno.execPath(), {
    args,
    cwd: candidate,
    clearEnv: true,
    env,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  void child.status.then((status) => {
    childStatus = status;
    if (!cleanup) {
      latch(new Error(`child exited before owned shutdown: ${status.code}`));
    }
  });
  // Drain immediately, including early boot failures.
  pumps.push(
    child.stdout.pipeTo(stdout.writable),
    child.stderr.pipeTo(stderr.writable),
  );
  childIdentity = await identity(child.pid);
  await write('child-identity', childIdentity);
  const healthDeadline = performance.now() + 30_000;
  let healthy = false;
  while (performance.now() < healthDeadline && !healthy) {
    abort.signal.throwIfAborted();
    try {
      const health = await request(
        '/_/health',
        {},
        BASE,
        healthDeadline - performance.now(),
      );
      healthy = health.status === 200 && health.json().ok === true;
    } catch (error) {
      if (abort.signal.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  proved(healthy, 'cold socket health');
  const source = await request('/_/libraries', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'H1 fixture',
      path: `${candidate}/tests/fixtures/library`,
    }),
  });
  check(
    source.status === 200 &&
      source.json().library.path === `${candidate}/tests/fixtures/library`,
    'isolated source registration',
  );
  const scan =
    (await request(`/rest/startScan?${AUTH}`)).json()['subsonic-response'];
  check(scan.status === 'ok', 'authenticated fixture scan start');
  const scanDeadline = performance.now() + 30_000;
  let scanned = false;
  while (performance.now() < scanDeadline && !scanned) {
    const status = (await request(
      `/rest/getScanStatus?${AUTH}`,
      {},
      BASE,
      scanDeadline - performance.now(),
    )).json()['subsonic-response'];
    check(status.status === 'ok', 'authenticated scan status');
    scanned = status.scanStatus.scanning === false &&
      status.scanStatus.count === 4 && status.scanStatus.folderCount === 1;
    if (!scanned) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check(scanned, 'fixture scan completion deadline');
  const folders = (await request(`/rest/getMusicFolders?${AUTH}`))
    .json()['subsonic-response'];
  check(
    folders.status === 'ok' && folders.musicFolders.musicFolder.length === 1 &&
      folders.musicFolders.musicFolder[0].name === 'H1 fixture',
    'exact fixture source readback',
  );
  const catalog = (await request(`/rest/getRandomSongs?${AUTH}&size=10`))
    .json()['subsonic-response'];
  check(catalog.status === 'ok', 'fixture catalog readback');
  const catalogSongs = catalog.randomSongs.song as {
    id: string;
    title: string;
  }[];
  proved(
    catalogSongs.length === 4 && new Set(catalogSongs.map((s) =>
          s.id
        )).size === 4 &&
      JSON.stringify(catalogSongs.map((s) => s.title).sort()) ===
        JSON.stringify(['Clip', 'First Song', 'Second Song', 'Theme']),
    'exact expected fixture catalog rows observed through child HTTP',
  );
  for (const song of catalogSongs) {
    const row = (await request(`/rest/getSong?${AUTH}&id=${song.id}`))
      .json()['subsonic-response'];
    proved(
      row.status === 'ok' && row.song.id === song.id &&
        row.song.title === song.title,
      `fixture song consumer ${song.title}`,
    );
  }
  const op = 'getOpenSubsonicExtensions';
  for (const prefix of ['/rest/', '/_opensubsonic/rest/', '/_opensubsonic/']) {
    for (const suffix of ['', '.view']) {
      for (const method of ['GET', 'POST']) {
        for (const format of ['json', 'xml']) {
          for (const credentials of ['none', 'invalid']) {
            const p = new URLSearchParams({ f: format });
            if (credentials === 'invalid') {
              p.set('u', 'wrong');
              p.set('p', 'wrong');
            }
            const res = await request(
              `${prefix}${op}${suffix}?${method === 'GET' ? p : 'f=xml'}`,
              method === 'POST' ? { method, body: p } : { method },
            );
            proved(
              res.status === 200,
              `${method} ${prefix}${op}${suffix} ${format} ${credentials} status`,
            );
            if (format === 'json') {
              const body = res.json()['subsonic-response'];
              proved(
                body.status === 'ok' &&
                  JSON.stringify(body.openSubsonicExtensions) ===
                    JSON.stringify(EXPECTED),
                'JSON semantic capability array',
              );
            } else {
              proved(
                res.contentType?.startsWith('application/xml') &&
                  res.body.includes(
                    'xmlns="http://subsonic.org/restapi" status="ok"',
                  ) &&
                  res.body.includes(
                    '<openSubsonicExtensions name="formPost"><versions>1</versions></openSubsonicExtensions>',
                  ) && !res.body.includes('<openSubsonicExtension>') &&
                  !res.body.includes('<version>'),
                'XML capability/version grammar',
              );
            }
          }
        }
      }
    }
  }
  for (const method of ['GET', 'POST']) {
    for (
      const path of [
        `/rest/${op}XYZ`,
        `/rest/${op}.json`,
        `/rest/${op}.viewXYZ`,
        `/rest/${op}/`,
        `/rest/${op}.view/`,
        `/rest/${op}/getMusicFolders`,
        `/rest/${op}.view/getMusicFolders`,
        `/rest/not${op}`,
        `/rest/${op.toLowerCase()}`,
        `/restping/${op}`,
        '/rest/getMusicFolders',
        '/rest/ping.view',
      ]
    ) {
      const value = (await request(`${path}?f=json`, { method }))
        .json()['subsonic-response'];
      proved(
        value?.status !== 'ok' && value?.openSubsonicExtensions === undefined,
        `${method} rejects public bypass ${path}`,
      );
    }
    for (const port of [14689, 14688]) {
      for (const path of [`/rest/${op}`, `/_opensubsonic/rest/${op}.view`]) {
        const value = await request(
          `${path}?f=json`,
          { method },
          `http://127.0.0.1:${port}`,
        );
        proved(
          value.status === 404 &&
            value.json()['subsonic-response'] === undefined,
          `${method} discovery absent on OwnTone ${port}`,
        );
      }
    }
  }
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const value = (await request(`/rest/${op}?f=json`, { method }))
      .json()['subsonic-response'];
    proved(value?.status !== 'ok', `${method} discovery not public`);
  }
  const missing =
    (await request('/rest/getMusicFolders?f=json')).json()['subsonic-response'];
  proved(
    missing.status === 'failed' && missing.error.code === 10,
    'protected catalog missing auth',
  );
  const bad = (await request(
    '/rest/getMusicFolders?u=wrong&p=wrong&v=1.16.1&c=H1&f=json',
  )).json()['subsonic-response'];
  proved(
    bad.status === 'failed' && bad.error.code === 40,
    'protected catalog bad auth',
  );
  const user = (await request('/rest/getUser', { method: 'POST', body: AUTH }))
    .json()['subsonic-response'];
  proved(
    user.status === 'ok' && user.user.username === AUTH.get('u'),
    'encoded unicode form credentials reach actual user consumer',
  );
  const songs = (await request(`/rest/getRandomSongs?${AUTH}&size=3`))
    .json()['subsonic-response'].randomSongs.song;
  check(
    songs.length === 3 &&
      new Set(songs.map((s: { id: string }) => s.id)).size === 3,
    'fixture song setup',
  );
  const form = new URLSearchParams(AUTH);
  for (const song of songs.slice(0, 2)) form.append('id', song.id);
  const star =
    (await request(`/rest/star.view?u=wrong&p=wrong&f=xml&id=${songs[2].id}`, {
      method: 'POST',
      body: form,
    })).json()['subsonic-response'];
  proved(
    star.status === 'ok',
    'form credentials/format precede conflicting query',
  );
  const starred =
    (await request(`/rest/getStarred2?${AUTH}`)).json()['subsonic-response'];
  proved(
    starred.status === 'ok' &&
      JSON.stringify(
          starred.starred2.song.map((s: { id: string }) => s.id).sort(),
        ) === JSON.stringify(songs.map((s: { id: string }) => s.id).sort()),
    'repeated form then query IDs reach canonical star readback',
  );
  const bookmark = new URLSearchParams(AUTH);
  bookmark.set('id', songs[0].id);
  bookmark.set('position', '1234');
  bookmark.set('comment', 'café + 雪 & 🔖');
  const created =
    (await request('/rest/createBookmark?position=1&comment=wrong', {
      method: 'POST',
      body: bookmark,
    })).json()['subsonic-response'];
  proved(created.status === 'ok', 'scalar form mutation accepted');
  const bookmarks =
    (await request(`/rest/getBookmarks?${AUTH}`)).json()['subsonic-response']
      .bookmarks.bookmark;
  proved(
    bookmarks.length === 1 && bookmarks[0].position === 1234 &&
      bookmarks[0].comment === bookmark.get('comment') &&
      bookmarks[0].entry.id === songs[0].id,
    'scalar/unicode form precedence observed at bookmark consumer',
  );
} catch (error) {
  latch(error);
} finally {
  clearTimeout(activeTimer);
  try {
    await bounded(stopOwnedChild(), 10_000);
  } catch (error) {
    latch(error);
  }
  try {
    await bounded(
      write('result', {
        phase,
        complete: failure === undefined,
        error: failure instanceof Error
          ? failure.message
          : failure === undefined
          ? null
          : String(failure),
        elapsedMs: performance.now() - started,
        assertions,
        requests: receipts.length,
        childStatus,
        cleanupComplete: cleanup !== undefined && childStatus?.success === true,
      }),
      20_000,
    );
  } catch (error) {
    latch(error);
  }
  clearTimeout(cleanupTimer);
  clearTimeout(hardTimer);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    Deno.removeSignalListener(signal, onSignal);
  }
}
if (failure !== undefined) throw failure;
console.log(`OPENSUBSONIC-COLD-CONSUMER-OK phase=${phase}`);
