// Bounded socket consumer for approved H1/H2 protocol boundaries. Exactly one
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
check(
  phase === 'H1' || phase === 'H2',
  'only implemented H1/H2 phases accepted',
);
const candidate = await Deno.realPath(option('candidate-root'));
const item = candidate.slice(0, -'/source'.length);
check(
  /^\/home\/tester\/melofon-output-preparation-01\/opensubsonic-highest-01\/H0[12](?:\/verification-\d+)?\/source$/
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

// Independent scan-input oracle. Known tags/paths define the expected IDs;
// no expected set is derived from a modified Library query or response.
const fixtureId = (key: string) =>
  createHash('sha256').update(key).digest('hex').slice(0, 32);
const same = (actual: string[], expected: string[]) =>
  JSON.stringify(actual) === JSON.stringify(expected);
type FixtureSong = {
  id: string;
  title: string;
  genre: string;
  year: number | null;
  source: number;
  albumId: string | null;
};

async function selectionConsumer() {
  const root = `${evidence}/selection-fixture`;
  await Deno.mkdir(root, { mode: 0o700 });
  const sourcePaths = [`${root}/A`, `${root}/B`];
  const sourceIds = sourcePaths.map((path) => fixtureId(`library\n${path}`));
  const mp3 = await Deno.readFile(
    `${candidate}/tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3`,
  );
  check(
    new TextDecoder().decode(mp3.subarray(0, 3)) === 'ID3' &&
      (mp3[5] & 0x10) === 0,
    'fixture has bounded leading ID3 without footer',
  );
  const tagSize = (mp3[6] << 21) | (mp3[7] << 14) | (mp3[8] << 7) | mp3[9];
  const audio = mp3.subarray(10 + tagSize);
  check(audio.length > 0, 'nonempty existing local MPEG audio');
  // ID3v2.3 ASCII text frames, big-endian frame sizes and syncsafe tag size.
  // No new media engine/package; production scan proves the actual tag readback.
  const tagged = (tags: Record<string, string>) => {
    const frames = Object.entries(tags).map(([name, value]) => {
      const text = new TextEncoder().encode(value);
      const frame = new Uint8Array(11 + text.length);
      frame.set(new TextEncoder().encode(name));
      new DataView(frame.buffer).setUint32(4, text.length + 1);
      frame.set(text, 11);
      return frame;
    });
    const length = frames.reduce((n, frame) => n + frame.length, 0);
    const out = new Uint8Array(10 + length + audio.length);
    out.set([
      73,
      68,
      51,
      3,
      0,
      0,
      (length >> 21) & 127,
      (length >> 14) & 127,
      (length >> 7) & 127,
      length & 127,
    ]);
    let offset = 10;
    for (const frame of frames) {
      out.set(frame, offset);
      offset += frame.length;
    }
    out.set(audio, offset);
    return out;
  };
  for (const path of sourcePaths) await Deno.mkdir(path, { mode: 0o700 });
  const small = [
    [0, 'Jazz', 2000],
    [0, 'Jazz', 2005],
    [0, 'Jazz', 2010],
    [0, 'Jazz', null],
    [0, 'Rock', 2005],
    [1, 'Jazz', 2005],
    [1, 'Jazz', 1999],
    [1, 'Rock', 2011],
  ] as const;
  const oracle: FixtureSong[] = [];
  for (let n = 0; n < small.length + 501; n++) {
    const bulk = n >= small.length;
    const [source, genre, year] = bulk ? [1, 'Bulk', 2005] as const : small[n];
    const album = bulk
      ? `Bulk-${String(n - small.length).padStart(3, '0')}`
      : 'Twin';
    const artist = source === 0 ? 'Source A' : 'Source B';
    const filename = `${String(n).padStart(3, '0')}.mp3`;
    const title = bulk ? 'Bulk' : 'Same';
    const tags: Record<string, string> = {
      TIT2: title,
      TPE1: artist,
      TPE2: artist,
      TALB: album,
      TCON: genre,
    };
    if (n === 2) {
      delete tags.TALB;
      delete tags.TPE2;
    }
    if (year !== null) tags.TYER = String(year);
    await Deno.writeFile(`${sourcePaths[source]}/${filename}`, tagged(tags), {
      createNew: true,
    });
    oracle.push({
      id: fixtureId(`file\n${sourceIds[source]}\n${filename}`),
      title,
      genre,
      year,
      source,
      albumId: n === 2 ? null : fixtureId(`album\n${artist}\n${album}`),
    });
  }
  await write('selection-oracle', { sourcePaths, sourceIds, songs: oracle });
  for (let n = 0; n < sourcePaths.length; n++) {
    const res = await request('/_/libraries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `H2 ${n}`, path: sourcePaths[n] }),
    });
    proved(
      res.status === 200 && res.json().library.id === sourceIds[n],
      `H2 source ${n} canonical ID`,
    );
  }
  const rest = async (
    op: string,
    extra: Record<string, string> = {},
    method = 'GET',
    format = 'json',
  ) => {
    const p = new URLSearchParams(AUTH);
    p.set('f', format);
    for (const [key, value] of Object.entries(extra)) p.set(key, value);
    return await request(
      `/rest/${op}${method === 'GET' ? '?' + p : ''}`,
      method === 'POST' ? { method, body: p } : {},
    );
  };
  const body = async (op: string, extra: Record<string, string> = {}) =>
    (await rest(op, extra)).json()['subsonic-response'];
  proved((await body('startScan')).status === 'ok', 'H2 sole-child scan start');
  const deadline = performance.now() + 30_000;
  let scanned = false;
  while (performance.now() < deadline && !scanned) {
    const value = await body('getScanStatus');
    scanned = value.status === 'ok' && value.scanStatus.scanning === false &&
      value.scanStatus.count === 513 && value.scanStatus.folderCount === 3;
    if (!scanned) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  proved(scanned, 'H2 513-song three-source scan consumer');
  const albumless = await body('getSong', { id: oracle[2].id });
  proved(
    albumless.status === 'ok' && albumless.song.albumId === undefined,
    'H2 actual scan albumless row',
  );
  const clip = await body('search3', {
    query: 'Clip',
    artistCount: '0',
    albumCount: '0',
    songCount: '99',
  });
  proved(
    clip.status === 'ok' && clip.searchResult3.song.length === 1 &&
      clip.searchResult3.song[0].isVideo === true,
    'H2 actual video retained in song enumeration',
  );
  const songsOf = (value: Record<string, unknown>, key: string) => {
    check(value.status === 'ok', `${key} status`);
    return (value[key] as {
      song: { id: string; genre?: string; year?: number }[];
    }).song;
  };
  const idsOf = (rows: { id: string }[]) => rows.map((row) => row.id);
  const expectedSmall = oracle.slice(0, 8).map((row) => row.id).sort();
  const originalSourceId = fixtureId(
    `library\n${candidate}/tests/fixtures/library`,
  );
  const originalSongs = [
    ['First Song', 'Fixture Artist/Fixture Album/01 - First Song.mp3'],
    ['Second Song', 'Fixture Artist/Fixture Album/02 - Second Song.mp3'],
    ['Clip', 'Fixture Artist/Fixture Album/03 - Clip.mp4'],
    ['Theme', 'Various Artists/Fixture OST/01 - Probe Performer - Theme.mp3'],
  ].map(([title, path]) => ({
    title,
    id: fixtureId(`file\n${originalSourceId}\n${path}`),
  }));
  const compare = (
    a: { label: string; id: string },
    b: { label: string; id: string },
  ) =>
    a.label < b.label
      ? -1
      : a.label > b.label
      ? 1
      : a.id < b.id
      ? -1
      : a.id > b.id
      ? 1
      : 0;
  const albumOracle = [
    {
      label: 'Fixture Album',
      id: fixtureId('album\nFixture Artist\nFixture Album'),
    },
    {
      label: 'Fixture OST',
      id: fixtureId('album\nVarious Artists\nFixture OST'),
    },
    { label: 'Twin', id: fixtureId('album\nSource A\nTwin') },
    { label: 'Twin', id: fixtureId('album\nSource B\nTwin') },
    ...oracle.slice(8).map((row, n) => ({
      label: `Bulk-${String(n).padStart(3, '0')}`,
      id: row.albumId!,
    })),
  ].sort(compare).map((row) => row.id);
  const pageOracles: Record<string, string[]> = {
    artist: ['Fixture Artist', 'Source A', 'Source B', 'Various Artists'].map(
      (name) => fixtureId(`artist\n${name}`),
    ),
    album: albumOracle,
    song: [...originalSongs, ...oracle].map((row) => ({
      label: row.title,
      id: row.id,
    })).sort(compare).map((row) => row.id),
  };
  for (const kind of ['artist', 'album', 'song']) {
    const union: string[] = [];
    const expected = pageOracles[kind];
    for (let offset = 0; offset <= expected.length + 100; offset += 100) {
      const value = await body('search3', {
        query: '',
        artistCount: '0',
        albumCount: '0',
        songCount: '0',
        [`${kind}Count`]: '100',
        [`${kind}Offset`]: String(offset),
      });
      const actual = idsOf(value.searchResult3[kind]);
      proved(
        value.status === 'ok' &&
          same(actual, expected.slice(offset, offset + 100)),
        `H2 full empty-query ${kind} page ${offset}`,
      );
      for (const other of ['artist', 'album', 'song']) {
        if (other !== kind) {
          proved(
            value.searchResult3[other].length === 0,
            `H2 ${kind} independent zero ${other} ${offset}`,
          );
        }
      }
      union.push(...actual);
    }
    proved(
      same(union, expected) && new Set(union).size === expected.length,
      `H2 complete empty-query ${kind} union`,
    );
  }
  for (const suffix of ['', '.view']) {
    for (const method of ['GET', 'POST']) {
      for (const format of ['json', 'xml']) {
        const res = await rest(
          `search3${suffix}`,
          {
            query: '',
            artistCount: '0',
            albumCount: '0',
            songCount: '99',
            musicFolderId: sourceIds[0],
          },
          method,
          format,
        );
        const actual = format === 'json'
          ? idsOf(songsOf(res.json()['subsonic-response'], 'searchResult3'))
          : [...res.body.matchAll(/<song id="([^"]+)"/g)].map((m) => m[1]);
        proved(
          same(actual, oracle.slice(0, 5).map((row) => row.id).sort()),
          `H2 empty ${method}${suffix} ${format} source enumeration`,
        );
        const absent = await rest(`search3${suffix}`, {}, method, format);
        proved(
          format === 'json'
            ? absent.json()['subsonic-response'].error.code === 10
            : absent.body.includes('<error code="10"'),
          `H2 absent ${method}${suffix} ${format} code10`,
        );
      }
    }
  }
  const union: string[] = [];
  for (let offset = 0; offset <= 8; offset += 2) {
    const value = await body('search3', {
      query: 'Same',
      artistCount: '0',
      albumCount: '0',
      songCount: '2',
      songOffset: String(offset),
    });
    const actual = idsOf(songsOf(value, 'searchResult3'));
    proved(
      same(actual, expectedSmall.slice(offset, offset + 2)),
      `H2 duplicate-title page ${offset}`,
    );
    union.push(...actual);
    proved(
      value.searchResult3.artist.length === 0 &&
        value.searchResult3.album.length === 0,
      `H2 independent zero groups ${offset}`,
    );
  }
  proved(
    same(union, expectedSmall) && new Set(union).size === 8,
    'H2 unchanged-catalog exact page union',
  );
  const filters: [Record<string, string>, number[]][] = [
    [{ genre: 'Jazz' }, [0, 1, 2, 3, 5, 6]],
    [{ genre: 'Jazz', fromYear: '2005' }, [1, 2, 5]],
    [{ genre: 'Jazz', toYear: '2000' }, [0, 6]],
    [{
      genre: 'Jazz',
      fromYear: '2000',
      toYear: '2005',
      musicFolderId: sourceIds[0],
    }, [0, 1]],
    [{ genre: 'Jazz', fromYear: '2005', toYear: '2005' }, [1, 5]],
    [{ fromYear: '2011', toYear: '1999' }, []],
    [{ genre: 'Jazz', fromYear: '2010', toYear: '2010' }, [2]],
    [{ genre: 'unknown' }, []],
    [{ musicFolderId: '2147483647' }, []],
  ];
  for (const [params, indexes] of filters) {
    const songs = songsOf(
      await body('getRandomSongs', { size: '500', ...params }),
      'randomSongs',
    );
    proved(
      same(idsOf(songs).sort(), indexes.map((n) => oracle[n].id).sort()) &&
        new Set(idsOf(songs)).size === songs.length,
      `H2 whole-pool predicate ${JSON.stringify(params)}`,
    );
  }
  const folders = await body('getMusicFolders');
  const wireA =
    folders.musicFolders.musicFolder.find((row: { name: string }) =>
      row.name === 'H2 0'
    ).id;
  const sourceRandom = songsOf(
    await body('getRandomSongs', {
      size: '500',
      genre: 'Jazz',
      musicFolderId: String(wireA),
    }),
    'randomSongs',
  );
  proved(
    same(
      idsOf(sourceRandom).sort(),
      oracle.slice(0, 4).map((row) => row.id).sort(),
    ),
    'H2 physical source wire int compatibility',
  );
  for (
    const raw of ['', 'NaN', 'Infinity', '2005x', '2005.5', '9007199254740992']
  ) {
    for (const bound of ['fromYear', 'toYear']) {
      proved(
        (await body('getRandomSongs', { [bound]: raw })).error.code === 10,
        `H2 malformed ${bound} ${raw}`,
      );
    }
  }
  const bulkIds = oracle.slice(8).map((row) => row.id).sort();
  for (
    const count of [
      '0',
      '10',
      '501',
      '9007199254740991',
      '9007199254740992',
      'Infinity',
    ]
  ) {
    const expectedCount = count === '0'
      ? 0
      : ['501', '9007199254740991'].includes(count)
      ? 500
      : 10;
    const random = songsOf(
      await body('getRandomSongs', { genre: 'Bulk', size: count }),
      'randomSongs',
    );
    proved(
      random.length === expectedCount &&
        new Set(idsOf(random)).size === expectedCount &&
        idsOf(random).every((id) => bulkIds.includes(id)),
      `H2 random cap ${count}`,
    );
    const genre = songsOf(
      await body('getSongsByGenre', { genre: 'Bulk', count }),
      'songsByGenre',
    );
    proved(
      same(idsOf(genre), bulkIds.slice(0, expectedCount)),
      `H2 genre cap ${count}`,
    );
    for (const op of ['getAlbumList', 'getAlbumList2']) {
      const value = await body(op, {
        type: 'byGenre',
        genre: 'Bulk',
        size: count,
      });
      const key = op === 'getAlbumList' ? 'albumList' : 'albumList2';
      const expected = oracle.slice(8, 8 + expectedCount).map((row) =>
        row.albumId!
      );
      proved(
        value.status === 'ok' && same(idsOf(value[key].album), expected),
        `H2 ${op} cap ${count}`,
      );
    }
  }
  const allBulk = songsOf(
    await body('search3', {
      query: 'Bulk',
      artistCount: '0',
      albumCount: '0',
      songCount: '501',
    }),
    'searchResult3',
  );
  proved(same(idsOf(allBulk), bulkIds), 'H2 search has no500 cap');
  const unsafe = await body('search3', {
    query: 'Bulk',
    artistCount: '0',
    albumCount: '0',
    songCount: '9007199254740992',
    songOffset: 'Infinity',
  });
  proved(
    same(idsOf(songsOf(unsafe, 'searchResult3')), bulkIds.slice(0, 20)),
    'H2 search safe fallback20/0',
  );
  const own = await request(
    '/api/library/albums?offset=500&limit=10',
    {},
    'http://127.0.0.1:14689',
  );
  // 501 new bulk albums + 2 Twin + 2 original H1 albums: actual OwnTone >500.
  proved(
    own.status === 200 && own.json().total === 505 &&
      own.json().items.length === 5,
    'H2 OwnTone actual whole-catalog expansion beyond500',
  );
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
    library: await hash(`${candidate}/src/library.ts`),
    params: await hash(`${candidate}/layers/opensubsonic/params.ts`),
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
  // H2 retains every H1 assertion before adding its own catalog consumer gate.
  if (phase === 'H2') await selectionConsumer();
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
