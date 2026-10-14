// Bounded socket consumer for approved H1/H2 protocol boundaries. Exactly one
// owned main.ts child, private frozen inputs/data, retained evidence on failure.
// This driver never selects an output or touches a household database.
import { createHash } from 'node:crypto';
import { OwnedRun } from '../helpers/owned-run.ts';
import {
  type ContainmentTicket,
  processIdentity,
} from '../helpers/transient-watchdog.ts';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`OpenSubsonic cold consumer: ${message}`);
}

// H1C common-protocol socket ledger: literal names, compared as an exact
// multiset here and by the cold-h1c observer oracle. Never part of the
// original or parsing ledgers.
export const H1C_ASSERTIONS: readonly string[] = Object.freeze([
  'H1C version 1.17.0 code30',
  'H1C version 1.99999999999999999999 code30',
  'H1C version 0.9.0 code20',
  'H1C version 1.16.x accepted',
  'H1C apiKey alone code42',
  'H1C apiKey with u/p code43',
  'H1C password with token/salt code43',
  'H1C token without salt code10',
  'H1C no credentials code10',
  'H1C empty form p with valid query fallback code10',
  'H1C JSONP off renders XML',
  'H1C JSONP setting on through core config',
  'H1C JSONP callback body',
  'H1C JSONP content type and nosniff',
  'H1C JSONP missing callback plain JSON code10',
  'H1C JSONP invalid callback plain JSON code0 unreflected',
  'H1C JSONP setting off through core config',
  'H1C JSONP off again renders XML',
  'H1C stream auth failure text/xml',
  'H1C stream not-found text/xml',
  'H1C getCoverArt auth failure text/xml',
  'H1C getCoverArt missing id text/xml',
  'H1C ping XML error stays application/xml',
]);

export function sameMultiset(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return JSON.stringify([...actual].sort()) ===
    JSON.stringify([...expected].sort());
}

export async function runCold(driverArgs = Deno.args) {
  const owner = new OwnedRun({ lease: driverArgs.includes('--lease=stdin') });
  const assertions: string[] = [];
  const parsingAssertions: string[] = [];
  const h1cAssertions: string[] = [];
  const receipts: {
    ledger: string;
    adaptive: boolean;
    [key: string]: unknown;
  }[] = [];
  let phase = '';
  let evidence = '';
  const result = await owner.run(async () => {
    function option(name: string): string {
      const value = driverArgs.find((arg) => arg.startsWith(`--${name}=`))
        ?.slice(
          name.length + 3,
        );
      check(value, `missing --${name}`);
      return value;
    }

    phase = option('phase');
    check(
      phase === 'H1' || phase === 'H2' || phase === 'H1C',
      'only implemented H1/H2/H1C phases accepted',
    );
    const candidate = await owner.operation(
      'candidate root',
      () => Deno.realPath(option('candidate-root')),
    );
    const item = candidate.slice(0, -'/source'.length);
    const historical =
      /^\/home\/tester\/melofon-output-preparation-01\/opensubsonic-highest-01\/H0[12](?:\/verification-\d+)?\/source$/
        .test(candidate);
    const correction =
      /^\/home\/tester\/melofon-output-preparation-01\/opensubsonic-prefix-correction-01\/(?:candidate|verification-\d{2,})\/source$/
        .test(candidate) ||
      /^\/home\/tester\/melofon-output-preparation-01\/opensubsonic-h1c-01\/(?:candidate|verification-\d{2,})\/source$/
        .test(candidate);
    check(
      historical || correction,
      'candidate outside approved disk root',
    );
    check(phase !== 'H1C' || correction, 'H1C runs only as a corrected owner');
    check(
      await owner.operation(
        'driver import root',
        () => Deno.realPath(new URL('../../', import.meta.url)),
      ) === candidate,
      'driver and candidate source differ',
    );
    const requestedEvidence = option('evidence');
    check(
      requestedEvidence.startsWith(`${item}/evidence/`) &&
        !requestedEvidence.includes('/../'),
      'evidence outside item',
    );
    check(Deno.uid() === 1000 && Deno.gid() === 1000, 'wrong guest account');
    check(Deno.env.get('HOME') === '/home/tester', 'wrong guest home');
    check(Deno.env.get('TMPDIR') === `${item}/tmp`, 'wrong private TMPDIR');
    check(
      Deno.env.get('DENO_DIR') === `${item}/runtime/deno-dir`,
      'wrong private DENO_DIR',
    );
    check(
      Deno.execPath() === '/home/tester/.deno/bin/deno',
      'wrong executable',
    );
    const native = Deno.env.get('MELOFON_RAOP_LIB');
    check(
      native === `${item}/artifacts/libmelofon_raop.so`,
      'wrong private native input',
    );
    const evidenceParent = requestedEvidence.slice(
      0,
      requestedEvidence.lastIndexOf('/'),
    );
    check(
      await owner.operation(
        'canonical evidence parent',
        () => Deno.realPath(evidenceParent),
      ) === evidenceParent,
      'evidence parent must be canonical',
    );
    await owner.operation(
      'exclusive evidence',
      () => Deno.mkdir(requestedEvidence, { mode: 0o700 }),
    );
    evidence = requestedEvidence;
    check(
      await owner.operation(
        'canonical evidence',
        () => Deno.realPath(evidence),
      ) === evidence,
      'evidence path must be canonical',
    );

    const hash = (path: string) => owner.hash(path);

    async function write(name: string, value: unknown) {
      await owner.writeJSON(`${evidence}/${name}.json`, value);
    }

    const boot = (await owner.operation('fresh boot', () =>
      Deno.readTextFile('/proc/sys/kernel/random/boot_id')))
      .trim();
    const identity = (pid: number) =>
      owner.operation('process identity', () =>
        processIdentity(pid));
    if (correction) {
      check(
        driverArgs.includes('--lease=stdin') &&
          driverArgs.includes('--corrections=enabled'),
        'corrected driver requires lease/correction inputs',
      );
      await owner.writeJSON(
        `${evidence}/subject-ready.json`,
        await identity(Deno.pid),
      );
      const ticketPath = option('supervisor-ticket');
      const ticketDeadline = Math.min(
        performance.now() + 30_000,
        owner.activeDeadline,
      );
      let ticket: ContainmentTicket | undefined;
      while (!ticket) {
        owner.assertWork(ticketDeadline);
        try {
          ticket = JSON.parse(
            await owner.operation(
              'read containment ticket',
              () =>
                Deno.readTextFile(ticketPath),
              'work',
              false,
            ),
          );
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) {
            throw error;
          }
          await owner.sleep(20, ticketDeadline);
        }
      }
      await owner.attachSupervisor(ticket);
      await write('ticket-checked', await identity(Deno.pid));
    }

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
      phaseDeadline = owner.activeDeadline,
      ledger = 'original',
      retryableConnect = false,
    ) {
      owner.assertWork(phaseDeadline);
      const url = new URL(path, base);
      const redacted = new URL(url);
      for (const key of ['u', 'p', 't', 's', 'apiKey']) {
        if (redacted.searchParams.has(key)) {
          redacted.searchParams.set(key, '[redacted]');
        }
      }
      let receipt!: typeof receipts[number] & {
        body: string;
        status: number;
        contentType: string | null;
        headers: Record<string, string>;
      };
      await owner.request(url, init, {
        phaseDeadline,
        retryableConnect,
        receipt: async (response, signal) => {
          receipt = {
            ...response,
            at: new Date().toISOString(),
            method: init.method ?? 'GET',
            url: redacted.href,
            ledger,
            adaptive: url.pathname === '/_/health' ||
              url.pathname === '/rest/getScanStatus',
            requestContentType: new Headers(init.headers).get('content-type'),
          };
          await Deno.writeTextFile(
            `${evidence}/requests.ndjson`,
            JSON.stringify(receipt) + '\n',
            { append: true, signal },
          );
          receipts.push(receipt);
        },
      });
      return {
        ...receipt,
        json: () =>
          JSON.parse(receipt.body),
      };
    }

    function proved(condition: unknown, name: string) {
      check(condition, name);
      assertions.push(name);
    }
    function correctedProof(condition: unknown, name: string) {
      check(condition, name);
      parsingAssertions.push(name);
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
      await owner.operation(
        'selection fixture root',
        () => Deno.mkdir(root, { mode: 0o700 }),
      );
      const sourcePaths = [`${root}/A`, `${root}/B`];
      const sourceIds = sourcePaths.map((path) =>
        fixtureId(`library\n${path}`)
      );
      const mp3 = await owner.operation(
        'fixture audio input',
        () =>
          Deno.readFile(
            `${candidate}/tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3`,
          ),
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
      for (const path of sourcePaths) {
        await owner.operation(
          'selection source dir',
          () => Deno.mkdir(path, { mode: 0o700 }),
        );
      }
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
        const [source, genre, year] = bulk
          ? [1, 'Bulk', 2005] as const
          : small[n];
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
        await owner.operation(
          'selection fixture write',
          () =>
            Deno.writeFile(`${sourcePaths[source]}/${filename}`, tagged(tags), {
              createNew: true,
              signal: owner.workSignal,
            }),
        );
        oracle.push({
          id: fixtureId(`file\n${sourceIds[source]}\n${filename}`),
          title,
          genre,
          year,
          source,
          albumId: n === 2 ? null : fixtureId(`album\n${artist}\n${album}`),
        });
      }
      await write('selection-oracle', {
        sourcePaths,
        sourceIds,
        songs: oracle,
      });
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
        deadline = owner.activeDeadline,
      ) => {
        const p = new URLSearchParams(AUTH);
        p.set('f', format);
        for (const [key, value] of Object.entries(extra)) p.set(key, value);
        return await request(
          `/rest/${op}${method === 'GET' ? '?' + p : ''}`,
          method === 'POST' ? { method, body: p } : {},
          BASE,
          deadline,
        );
      };
      const body = async (
        op: string,
        extra: Record<string, string> = {},
        deadline = owner.activeDeadline,
      ) =>
        (await rest(op, extra, 'GET', 'json', deadline))
          .json()['subsonic-response'];
      proved(
        (await body('startScan')).status === 'ok',
        'H2 sole-child scan start',
      );
      const deadline = Math.min(
        performance.now() + 30_000,
        owner.activeDeadline,
      );
      await owner.poll(
        deadline,
        (deadline) => body('getScanStatus', {}, deadline),
        (value) =>
          value.status === 'ok' && value.scanStatus.scanning === false &&
          value.scanStatus.count === 513 && value.scanStatus.folderCount === 3,
      );
      const scanned = true;
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
        [
          'Theme',
          'Various Artists/Fixture OST/01 - Probe Performer - Theme.mp3',
        ],
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
        artist: ['Fixture Artist', 'Source A', 'Source B', 'Various Artists']
          .map(
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
        const raw of [
          '',
          'NaN',
          'Infinity',
          '2005x',
          '2005.5',
          '9007199254740992',
        ]
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
      if (correction) {
        const correctedBody = async (
          op: string,
          extra: Record<string, string> = {},
        ) => {
          const p = new URLSearchParams(AUTH);
          for (const [key, value] of Object.entries(extra)) p.set(key, value);
          return (await request(
            `/rest/${op}?${p}`,
            {},
            BASE,
            owner.activeDeadline,
            'correction',
          )).json()['subsonic-response'];
        };
        for (const bound of ['fromYear', 'toYear']) {
          correctedProof(
            (await correctedBody('getRandomSongs', {
              [bound]: '1999.9999999999999999999',
            })).error.code === 10,
            `correction random exact ${bound}`,
          );
          for (const op of ['getAlbumList', 'getAlbumList2']) {
            correctedProof(
              (await correctedBody(op, {
                type: 'byYear',
                fromYear: '1999',
                toYear: '2010',
                [bound]: '1999.9999999999999999999',
              })).error.code === 10,
              `correction ${op} exact ${bound}`,
            );
          }
        }
        const fallback = await correctedBody('search3', {
          query: '',
          artistCount: '0',
          albumCount: '0',
          songCount: '1.0000000000000001',
          songOffset: '1.0000000000000001',
          musicFolderId: sourceIds[0],
        });
        correctedProof(
          same(
            idsOf(fallback.searchResult3.song),
            oracle.slice(0, 5).map((s) => s.id).sort(),
          ),
          'correction fractional search3 count/offset fallback at consumer',
        );
        const legacy = await correctedBody('search2', {
          query: 'Bulk',
          artistCount: '0',
          albumCount: '0',
          songCount: '9007199254740993',
        });
        correctedProof(
          same(idsOf(legacy.searchResult2.song), bulkIds),
          'correction search2 unsafe whole integer remains uncapped',
        );
        const safe = await correctedBody('search3', {
          query: 'Bulk',
          artistCount: '0',
          albumCount: '0',
          songCount: '9007199254740993',
        });
        correctedProof(
          same(idsOf(safe.searchResult3.song), bulkIds.slice(0, 20)),
          'correction search3 unsafe exact fallback',
        );
        const rated = [
          fixtureId('album\nSource A\nTwin'),
          fixtureId('album\nSource B\nTwin'),
        ];
        for (let n = 0; n < rated.length; n++) {
          correctedProof(
            (await correctedBody('setRating', {
              id: rated[n],
              rating: String(4 - n),
            })).status === 'ok',
            `correction seed rating ${n}`,
          );
        }
        const highest = async () =>
          (await correctedBody('getAlbumList2', {
            type: 'highest',
            size: '10',
          })).albumList2.album.map((a: { id: string }) => a.id);
        correctedProof(
          same(await highest(), rated),
          'correction rating initial canonical highest ordering',
        );
        for (const rating of ['1.0000000000000001', '1e-400']) {
          correctedProof(
            (await correctedBody('setRating', { id: rated[0], rating })).error
              .code === 10,
            `correction rating exact rejection ${rating}`,
          );
          correctedProof(
            same(await highest(), rated),
            `correction rating preserved highest consumer ${rating}`,
          );
        }
        const tracks = oracle.slice(0, 3).map((s) => s.id);
        const p = new URLSearchParams(AUTH);
        p.set('name', 'Numeric correction');
        for (const id of tracks) p.append('songId', id);
        const created = (await request(
          '/rest/createPlaylist',
          { method: 'POST', body: p },
          BASE,
          owner.activeDeadline,
          'correction',
        )).json()['subsonic-response'].playlist;
        const removal = new URLSearchParams(AUTH);
        removal.set('playlistId', created.id);
        for (const value of ['1.0000000000000001', '1e-400']) {
          removal.append('songIndexToRemove', value);
        }
        correctedProof(
          (await request(
            '/rest/updatePlaylist',
            { method: 'POST', body: removal },
            BASE,
            owner.activeDeadline,
            'correction',
          )).json()['subsonic-response'].status === 'ok',
          'correction invalid-only playlist update accepted',
        );
        const readPlaylist = async () =>
          (await correctedBody('getPlaylist', { id: created.id })).playlist;
        correctedProof(
          same(idsOf((await readPlaylist()).entry), tracks),
          'correction invalid-only removal preserves track0/1',
        );
        removal.append('songIndexToRemove', '2.0');
        removal.append('songIndexToRemove', '9007199254740993');
        removal.append('songIdToAdd', oracle[3].id);
        removal.set('name', 'Valid edits preserved');
        correctedProof(
          (await request(
            '/rest/updatePlaylist',
            { method: 'POST', body: removal },
            BASE,
            owner.activeDeadline,
            'correction',
          )).json()['subsonic-response'].status === 'ok',
          'correction mixed playlist update',
        );
        const edited = await readPlaylist();
        correctedProof(
          edited.name === 'Valid edits preserved' &&
            same(idsOf(edited.entry), [tracks[0], tracks[1], oracle[3].id]),
          'correction playlist valid edits and ordered readback',
        );
        const ownBad = await request(
          '/api/library/albums?offset=1.0000000000000001&limit=1',
          {},
          'http://127.0.0.1:14689',
          owner.activeDeadline,
          'correction',
        );
        correctedProof(
          ownBad.status === 400,
          'correction OwnTone paging fraction rejected',
        );
        const ownLarge = await request(
          '/api/library/albums?offset=9007199254740993&limit=-1.0',
          {},
          'http://127.0.0.1:14689',
          owner.activeDeadline,
          'correction',
        );
        correctedProof(
          ownLarge.status === 200 &&
            ownLarge.json().offset === 9007199254740992 &&
            ownLarge.json().limit === -1 && ownLarge.json().total === 505 &&
            ownLarge.json().items.length === 0,
          'correction OwnTone legacy paging echoed',
        );
        const master = await request(
          '/api/player',
          {},
          'http://127.0.0.1:14689',
          owner.activeDeadline,
          'correction',
        );
        correctedProof(
          master.status === 200 && master.json().volume === 50 &&
            master.json().state === 'stop',
          'correction OwnTone master readback without engine playback',
        );
        await write('numeric-oracle', {
          ratedAlbums: rated,
          initialPlaylistTracks: tracks,
          editedPlaylistTracks: [tracks[0], tracks[1], oracle[3].id],
          playlistId: created.id,
          originalCaseCount: 191,
        });
      }
    }

    // H1C common protocol over the sole application child's socket. Its own
    // ledger and receipts; the JSONP setting changes only through the child's
    // core config route (fixture setup, like library seeding).
    async function commonProtocolConsumer() {
      const h1c = (condition: unknown, name: string) => {
        check(condition, name);
        h1cAssertions.push(name);
      };
      const send = (path: string, init: RequestInit = {}) =>
        request(path, init, BASE, owner.activeDeadline, 'h1c');
      const auth = (
        extra: Record<string, string> = {},
        drop: string[] = [],
      ) => {
        const p = new URLSearchParams(AUTH);
        for (const key of drop) p.delete(key);
        for (const [key, value] of Object.entries(extra)) p.set(key, value);
        return p;
      };
      const envelope = async (path: string, init: RequestInit = {}) =>
        (await send(path, init)).json()['subsonic-response'];
      const failed = (value: { status?: string; error?: { code?: number } }) =>
        value.status === 'failed' ? value.error?.code : undefined;
      const XML = 'application/xml; charset=utf-8';
      const TEXT_XML = 'text/xml; charset=utf-8';
      const xmlCode = (body: string) => /<error code="(\d+)"/.exec(body)?.[1];
      const versions: [string, number][] = [
        ['1.17.0', 30],
        ['1.99999999999999999999', 30],
        ['0.9.0', 20],
      ];
      for (const [v, code] of versions) {
        h1c(
          failed(await envelope(`/rest/ping?${auth({ v })}`)) === code,
          `H1C version ${v} code${code}`,
        );
      }
      h1c(
        (await envelope(`/rest/ping?${auth({ v: '1.16.x' })}`)).status === 'ok',
        'H1C version 1.16.x accepted',
      );
      const keyOnly = new URLSearchParams({
        apiKey: 'fixture-key',
        v: '1.16.1',
        c: 'H1C',
        f: 'json',
      });
      const unsupported = await envelope(`/rest/ping?${keyOnly}`);
      h1c(
        failed(unsupported) === 42 &&
          unsupported.error.message ===
            'Provided authentication mechanism not supported.',
        'H1C apiKey alone code42',
      );
      const keyMixed = await envelope(
        `/rest/ping?${auth({ apiKey: 'fixture-key' })}`,
      );
      h1c(
        failed(keyMixed) === 43 &&
          keyMixed.error.message ===
            'Multiple conflicting authentication mechanisms provided.',
        'H1C apiKey with u/p code43',
      );
      h1c(
        failed(
          await envelope(
            `/rest/ping?${auth({ t: 'fixture-token', s: 'fixture-salt' })}`,
          ),
        ) === 43,
        'H1C password with token/salt code43',
      );
      h1c(
        failed(
          await envelope(`/rest/ping?${auth({ t: 'fixture-token' }, ['p'])}`),
        ) === 10,
        'H1C token without salt code10',
      );
      h1c(
        failed(await envelope(`/rest/ping?${auth({}, ['p'])}`)) === 10,
        'H1C no credentials code10',
      );
      h1c(
        failed(
          await envelope(`/rest/ping?${AUTH}`, {
            method: 'POST',
            body: auth({ p: '' }),
          }),
        ) === 10,
        'H1C empty form p with valid query fallback code10',
      );
      const callback = 'angular.callbacks._0';
      const jsonpXml = async (name: string) => {
        const res = await send(`/rest/ping?${auth({ f: 'jsonp', callback })}`);
        h1c(
          res.status === 200 && res.contentType === XML &&
            res.body.includes('status="ok"') &&
            res.body.includes('version="1.16.1"') &&
            !res.body.includes(callback),
          name,
        );
      };
      await jsonpXml('H1C JSONP off renders XML');
      const setting = async (value: string) =>
        await send('/_/config/opensubsonic.jsonp', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value }),
        });
      const on = await setting('on');
      h1c(
        on.status === 200 && on.json().ok === true,
        'H1C JSONP setting on through core config',
      );
      const jsonp = await send(`/rest/ping?${auth({ f: 'jsonp', callback })}`);
      const prefix = `${callback}(`;
      const wrapped = jsonp.body.startsWith(prefix) &&
          jsonp.body.endsWith(')')
        ? JSON.parse(jsonp.body.slice(prefix.length, -1))
        : undefined;
      const inner = wrapped?.['subsonic-response'];
      h1c(
        jsonp.status === 200 && inner?.status === 'ok' &&
          inner.version === '1.16.1' && inner.type === 'melofon' &&
          inner.openSubsonic === true &&
          jsonp.body === `${prefix}${JSON.stringify(wrapped)})`,
        'H1C JSONP callback body',
      );
      h1c(
        jsonp.contentType === 'application/javascript' &&
          jsonp.headers['x-content-type-options'] === 'nosniff',
        'H1C JSONP content type and nosniff',
      );
      const missing = await send(`/rest/ping?${auth({ f: 'jsonp' })}`);
      h1c(
        missing.contentType === 'application/json' &&
          failed(missing.json()['subsonic-response']) === 10 &&
          missing.json()['subsonic-response'].error.message ===
            'Required parameter is missing',
        'H1C JSONP missing callback plain JSON code10',
      );
      const rejected = 'alert(document.domain)//';
      const invalid = await send(
        `/rest/ping?${auth({ f: 'jsonp', callback: rejected })}`,
      );
      h1c(
        invalid.contentType === 'application/json' &&
          failed(invalid.json()['subsonic-response']) === 0 &&
          invalid.json()['subsonic-response'].error.message ===
            'invalid callback parameter' &&
          !invalid.body.includes('alert(') &&
          !invalid.body.includes('document.domain'),
        'H1C JSONP invalid callback plain JSON code0 unreflected',
      );
      const off = await setting('off');
      h1c(
        off.status === 200 && off.json().ok === true,
        'H1C JSONP setting off through core config',
      );
      await jsonpXml('H1C JSONP off again renders XML');
      const xmlError = async (path: string, code: string, name: string) => {
        const res = await send(path);
        h1c(
          res.status === 200 && res.contentType === TEXT_XML &&
            xmlCode(res.body) === code &&
            res.body.includes('xmlns="http://subsonic.org/restapi"'),
          name,
        );
      };
      await xmlError(
        `/rest/stream?${auth({ p: 'wrong', f: 'xml', id: 'x' })}`,
        '40',
        'H1C stream auth failure text/xml',
      );
      await xmlError(
        `/rest/stream.view?${auth({ f: 'xml', id: 'h1c-missing' })}`,
        '70',
        'H1C stream not-found text/xml',
      );
      await xmlError(
        `/rest/getCoverArt?${auth({ p: 'wrong', f: 'xml', id: 'x' })}`,
        '40',
        'H1C getCoverArt auth failure text/xml',
      );
      await xmlError(
        `/rest/getCoverArt.view?${auth({ f: 'xml' })}`,
        '10',
        'H1C getCoverArt missing id text/xml',
      );
      const control = await send(
        `/rest/ping?${auth({ p: 'wrong', f: 'xml' })}`,
      );
      h1c(
        control.contentType === XML && xmlCode(control.body) === '40',
        'H1C ping XML error stays application/xml',
      );
    }

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
    await owner.operation(
      'exclusive private data',
      () => Deno.mkdir(data, { mode: 0o700 }),
    );
    owner.assertWork();
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
    const childIdentity = await owner.launch({
      executable: Deno.execPath(),
      args,
      cwd: candidate,
      env,
      stdout: `${evidence}/child.stdout.log`,
      stderr: `${evidence}/child.stderr.log`,
    });
    await write('child-identity', childIdentity);
    if (correction) {
      await write('child-ready', childIdentity);
      const releaseDeadline = Math.min(
        performance.now() + 30_000,
        owner.activeDeadline,
      );
      for (;;) {
        owner.assertWork(releaseDeadline);
        try {
          await owner.operation(
            'observer release',
            () => Deno.stat(`${evidence}/release.json`),
            'work',
            false,
          );
          break;
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
          await owner.sleep(20, releaseDeadline);
        }
      }
    }
    const healthDeadline = Math.min(
      performance.now() + 30_000,
      owner.activeDeadline,
    );
    let healthy = false;
    while (performance.now() < healthDeadline && !healthy) {
      owner.assertWork(healthDeadline);
      try {
        const health = await request(
          '/_/health',
          {},
          BASE,
          healthDeadline,
          'original',
          true,
        );
        owner.assertWork(healthDeadline);
        healthy = health.status === 200 && health.json().ok === true;
      } catch (error) {
        if (owner.workSignal.aborted) throw error;
        await owner.sleep(100, healthDeadline);
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
    const scanDeadline = Math.min(
      performance.now() + 30_000,
      owner.activeDeadline,
    );
    let scanned = false;
    while (performance.now() < scanDeadline && !scanned) {
      const status = (await request(
        `/rest/getScanStatus?${AUTH}`,
        {},
        BASE,
        scanDeadline,
      )).json()['subsonic-response'];
      check(status.status === 'ok', 'authenticated scan status');
      owner.assertWork(scanDeadline);
      scanned = status.scanStatus.scanning === false &&
        status.scanStatus.count === 4 && status.scanStatus.folderCount === 1;
      if (!scanned) await owner.sleep(100, scanDeadline);
    }
    check(scanned, 'fixture scan completion deadline');
    const folders = (await request(`/rest/getMusicFolders?${AUTH}`))
      .json()['subsonic-response'];
    check(
      folders.status === 'ok' &&
        folders.musicFolders.musicFolder.length === 1 &&
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
      catalogSongs.length === 4 &&
        new Set(catalogSongs.map((s) => s.id)).size === 4 &&
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
    for (
      const prefix of ['/rest/', '/_opensubsonic/rest/', '/_opensubsonic/']
    ) {
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
    const missing = (await request('/rest/getMusicFolders?f=json'))
      .json()['subsonic-response'];
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
    const user =
      (await request('/rest/getUser', { method: 'POST', body: AUTH }))
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
    const star = (await request(
      `/rest/star.view?u=wrong&p=wrong&f=xml&id=${songs[2].id}`,
      {
        method: 'POST',
        body: form,
      },
    )).json()['subsonic-response'];
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
    if (correction) {
      const sourcePath = `${candidate}/tests/fixtures/library`;
      const sourceId = fixtureId(`library\n${sourcePath}`);
      const inputRows = [
        ['First Song', 'Fixture Artist/Fixture Album/01 - First Song.mp3'],
        ['Second Song', 'Fixture Artist/Fixture Album/02 - Second Song.mp3'],
        ['Clip', 'Fixture Artist/Fixture Album/03 - Clip.mp4'],
        [
          'Theme',
          'Various Artists/Fixture OST/01 - Probe Performer - Theme.mp3',
        ],
      ];
      const inputs = [];
      for (const [title, relative] of inputRows) {
        inputs.push({
          title,
          relative,
          id: fixtureId(`file\n${sourceId}\n${relative}`),
          sha256: await hash(`${sourcePath}/${relative}`),
        });
      }
      for (
        const contentType of [
          'Application/X-Www-Form-Urlencoded',
          'APPLICATION/X-WWW-FORM-URLENCODED',
          'application/x-www-form-urlencoded ; charset="utf-8"; fixture="a;b"',
        ]
      ) {
        const value = (await request(
          '/rest/getUser?u=wrong&p=wrong&f=xml',
          {
            method: 'POST',
            headers: { 'content-type': contentType },
            body: AUTH,
          },
          BASE,
          owner.activeDeadline,
          'correction',
        )).json()['subsonic-response'];
        correctedProof(
          value.status === 'ok' && value.user.username === AUTH.get('u'),
          `correction MIME Unicode authentication ${contentType}`,
        );
      }
      const empty = new URLSearchParams(AUTH);
      empty.set('u', '');
      correctedProof(
        (await request(
          `/rest/getMusicFolders?${AUTH}`,
          {
            method: 'POST',
            headers: { 'content-type': 'APPLICATION/X-WWW-FORM-URLENCODED' },
            body: empty,
          },
          BASE,
          owner.activeDeadline,
          'correction',
        )).json()['subsonic-response'].error.code === 10,
        'correction empty credential keeps first form precedence',
      );
      for (
        const type of [
          'application/x-www-form-urlencodedjunk',
          'application/x-www-form-urlencoded+json',
          'application/json',
        ]
      ) {
        const res = await request(
          `/rest/getMusicFolders?${AUTH}`,
          {
            method: 'POST',
            headers: { 'content-type': type },
            body: 'u=wrong&p=wrong&f=xml',
          },
          BASE,
          owner.activeDeadline,
          'correction',
        );
        correctedProof(
          res.status === 200 && res.json()['subsonic-response'].status === 'ok',
          `correction non-form query retained ${type}`,
        );
      }
      const first = inputs.find((r) => r.title === 'First Song')!.id;
      const second = inputs.find((r) => r.title === 'Second Song')!.id;
      const clip = inputs.find((r) => r.title === 'Clip')!.id;
      const playlist = new URLSearchParams(AUTH);
      playlist.set('name', 'MIME + 雪 & playlist');
      for (const id of [clip, first, clip]) playlist.append('songId', id);
      const created = (await request(
        `/rest/createPlaylist?songId=${second}&name=wrong&f=xml`,
        {
          method: 'POST',
          headers: { 'content-type': 'APPLICATION/X-WWW-FORM-URLENCODED' },
          body: playlist,
        },
        BASE,
        owner.activeDeadline,
        'correction',
      )).json()['subsonic-response'].playlist;
      const expectedTracks = [clip, first, clip, second];
      correctedProof(
        created.name === playlist.get('name') &&
          same(created.entry.map((s: { id: string }) => s.id), expectedTracks),
        'correction repeated form/query duplicates in playlist response',
      );
      const canonical = (await request(
        `/rest/getPlaylist?${AUTH}&id=${created.id}`,
        {},
        BASE,
        owner.activeDeadline,
        'correction',
      )).json()['subsonic-response'].playlist;
      correctedProof(
        same(canonical.entry.map((s: { id: string }) => s.id), expectedTracks),
        'correction ordered repeated fields persisted at playlist consumer',
      );
      const blank = new URLSearchParams(AUTH);
      blank.set('id', first);
      blank.set('position', '+1234.75');
      blank.set('comment', '');
      correctedProof(
        (await request(
          '/rest/createBookmark?position=9&comment=wrong',
          {
            method: 'POST',
            headers: { 'content-type': 'Application/X-Www-Form-Urlencoded' },
            body: blank,
          },
          BASE,
          owner.activeDeadline,
          'correction',
        )).json()['subsonic-response'].status === 'ok',
        'correction empty scalar bookmark accepted',
      );
      const canonicalBookmarks = (await request(
        `/rest/getBookmarks?${AUTH}`,
        {},
        BASE,
        owner.activeDeadline,
        'correction',
      )).json()['subsonic-response'].bookmarks.bookmark;
      correctedProof(
        canonicalBookmarks.some((
          b: { entry: { id: string }; position: number; comment?: string },
        ) => b.entry.id === first && b.position === 1234 && b.comment === ''),
        'correction empty scalar and fractional bookmark canonical readback',
      );
      await write('fixture-manifest', {
        sourcePath,
        sourceId,
        inputs,
        orderedPlaylistId: created.id,
        expectedTracks,
      });
    }
    // H2 retains every H1 assertion before adding its own catalog consumer gate.
    // H1C retains the complete H2 phase, then appends its own ledger.
    if (phase === 'H2' || phase === 'H1C') await selectionConsumer();
    if (phase === 'H1C') await commonProtocolConsumer();
  }, async (owner, summary) => {
    check(evidence, 'preflight did not establish evidence root');
    const expected = phase === 'H1' ? 144 : 277;
    const original = receipts.filter((r) => r.ledger === 'original');
    const originalCaseCount = original.filter((r) => !r.adaptive).length;
    if (summary.success) {
      check(
        assertions.length === expected &&
          originalCaseCount === (phase === 'H1' ? 99 : 191),
        'original assertion/request-case ledger changed',
      );
      check(
        phase === 'H1C'
          ? sameMultiset(h1cAssertions, H1C_ASSERTIONS)
          : h1cAssertions.length === 0,
        'H1C ledger differs from its literal multiset',
      );
    }
    const logHashes: Record<string, string> = {};
    for (
      const name of ['child.stdout.log', 'child.stderr.log', 'requests.ndjson']
    ) {
      try {
        const bytes = await owner.operation(
          `seal ${name}`,
          () => Deno.readFile(`${evidence}/${name}`),
          'publication',
        );
        logHashes[name] = createHash('sha256').update(bytes).digest('hex');
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }
    await owner.writeJSON(`${evidence}/lifetime.json`, {
      ...summary,
      events: owner.events,
      logHashes,
    }, true);
    await owner.writeJSON(`${evidence}/result.json`, {
      phase,
      complete: summary.success,
      error: summary.failure ?? null,
      elapsedMs: performance.now() - owner.started,
      assertions,
      parsingAssertions,
      h1cAssertions,
      requests: original.length,
      originalCaseCount,
      adaptivePolls: original.filter((r) => r.adaptive).length,
      correctionResponses: receipts.filter((r) =>
        r.ledger === 'correction'
      ).length,
      h1cResponses: receipts.filter((r) => r.ledger === 'h1c').length,
      totalResponses: receipts.length,
      childStatus: summary.childStatus,
      cleanupComplete: summary.workJoined && summary.resourcesClosed &&
        summary.childReaped && summary.unresolved.length === 0,
      owner: summary,
      logHashes,
    }, true);
  });
  if (!result.success) throw new Error(result.failure ?? 'cold run incomplete');
  console.log(`OPENSUBSONIC-COLD-CONSUMER-OK phase=${phase}`);
  return result;
}

if (import.meta.main) await runCold();
