import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { cp } from 'node:fs/promises';
import { apiFixture, error } from './helpers/api.ts';
import { createLibraries } from '../src/libraries.ts';
import { createScan, type ScanService } from '../src/scan.ts';
import { createLibrary } from '../src/library.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { createMedia } from '../src/media.ts';
import { captureLogs, parseLogfmt } from './helpers/logging.ts';

const base = '/api/v1/admin';
const auth = new URLSearchParams({
  u: 'admin',
  p: 'password-admin',
  c: 'a7',
  v: '1.16.1',
  f: 'json',
});

async function fixture() {
  const root = await Deno.makeTempDir({ prefix: 'melofon-api-libraries-' });
  let scan: ScanService;
  let fail = false;
  const capture = captureLogs();
  let barrier: {
    entered: PromiseWithResolvers<void>;
    released: PromiseWithResolvers<void>;
  } | undefined;
  let updateBarrier: typeof barrier;
  const f = await apiFixture({
    allLayers: true,
    services: (f) => {
      const media = createMedia();
      scan = createScan(f.store, {
        ...media,
        describeAudio: async (path) => {
          if (barrier) {
            const current = barrier;
            barrier = undefined;
            current.entered.resolve();
            await current.released.promise;
          }
          if (fail) throw new Error('fixture scan failure');
          return media.describeAudio(path);
        },
      }, { state: f.state, notify: f.notify });
      return Promise.resolve({
        libraries: createLibraries({
          ...f.store,
          catalog: {
            ...f.store.catalog,
            async updateLibrary(id, input) {
              if (updateBarrier) {
                const current = updateBarrier;
                updateBarrier = undefined;
                current.entered.resolve();
                await current.released.promise;
              }
              return f.store.catalog.updateLibrary(id, input);
            },
          },
        }, {
          dataDir: f.dir,
          scan,
          notify: f.notify,
          log: capture.log,
        }),
        scan,
        library: createLibrary(f.store),
        annotation: createAnnotation(f.store),
        listens: createListens(f.store),
      });
    },
  });
  const { credential } = await f.login('bearer');
  const status = async () => {
    const res = await f.get(`${base}/scans/current`, credential);
    assertEquals(res.status, 200);
    return (await res.json()).scan;
  };
  const idle = async () => {
    for (let n = 0; n < 500; n++) {
      const value = await status();
      if (!value.scanning) return value;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('scan did not finish');
  };
  const rest = async (op: string, extra: Record<string, string> = {}) => {
    const response = await f.get(
      `/rest/${op}?${new URLSearchParams([...auth, ...Object.entries(extra)])}`,
    );
    assertEquals(response.status, 200);
    const body = (await response.json())['subsonic-response'];
    assertEquals(body.status, 'ok', JSON.stringify(body));
    return body;
  };
  const add = async (path: string, name = 'Music') => {
    const response = await f.json(
      `${base}/libraries`,
      'POST',
      { name, path },
      credential,
    );
    assertEquals(response.status, 201, await response.clone().text());
    return (await response.json()).library as {
      id: string;
      name: string;
      path: string;
    };
  };
  return {
    ...f,
    root,
    credential,
    status,
    idle,
    rest,
    add,
    logs: capture.lines,
    holdNextUpdate() {
      const current = {
        entered: Promise.withResolvers<void>(),
        released: Promise.withResolvers<void>(),
      };
      updateBarrier = current;
      return {
        entered: current.entered.promise,
        release: () => current.released.resolve(),
      };
    },
    fail: (value: boolean) => {
      fail = value;
    },
    holdNext() {
      const current = {
        entered: Promise.withResolvers<void>(),
        released: Promise.withResolvers<void>(),
      };
      barrier = current;
      return {
        entered: current.entered.promise,
        release: () => current.released.resolve(),
      };
    },
    async close() {
      await idle();
      await f.close();
      await Deno.remove(root, { recursive: true });
    },
  };
}

Deno.test('API libraries: canonical paths, every validation code and atomic disjointness', async () => {
  const f = await fixture();
  const blocked = `${f.root}/blocked`;
  try {
    await Deno.mkdir(`${f.root}/music/nested`, { recursive: true });
    await Deno.mkdir(`${f.root}/music-other`);
    await Deno.mkdir(blocked);
    await Deno.chmod(blocked, 0);
    await Deno.writeTextFile(`${f.root}/file`, 'not a directory');
    await Deno.mkdir(`${f.dir}/internal`);
    await Deno.symlink(`${f.dir}/internal`, `${f.root}/data-link`);
    for (
      const [path, code] of [
        ['relative', 'path_not_absolute'],
        [`${f.root}/missing`, 'path_not_found'],
        [`${f.root}/file`, 'path_not_directory'],
        [blocked, 'path_unreadable'],
        [`${f.dir}/internal`, 'path_in_data_dir'],
        [`${f.root}/data-link`, 'path_in_data_dir'],
      ]
    ) {
      await error(
        await f.json(
          `${base}/libraries`,
          'POST',
          { name: 'Invalid', path },
          f.credential,
        ),
        400,
        code,
      );
    }
    const a = await f.add(`${f.root}/music/../music/`);
    assertEquals(a.path, `${f.root}/music`);
    await f.idle();
    for (
      const [path, code] of [
        ['relative', 'path_not_absolute'],
        [`${f.root}/missing`, 'path_not_found'],
        [`${f.root}/file`, 'path_not_directory'],
        [blocked, 'path_unreadable'],
        [`${f.dir}/internal`, 'path_in_data_dir'],
      ]
    ) {
      await error(
        await f.json(
          `${base}/libraries/${a.id}`,
          'PATCH',
          { path },
          f.credential,
        ),
        400,
        code,
      );
    }
    const { stats, ...unchanged } =
      (await (await f.get(`${base}/libraries/${a.id}`, f.credential)).json())
        .library;
    assertEquals(unchanged, a);
    assertEquals(stats.songs, 0);
    assertEquals(stats.lastScanMode, 'full');
    await Deno.symlink(a.path, `${f.root}/alias`);
    for (
      const [path, code] of [
        [a.path, 'path_duplicate'],
        [`${f.root}/alias`, 'path_duplicate'],
        [`${a.path}/nested`, 'path_overlaps'],
        [f.root, 'path_overlaps'],
      ]
    ) {
      await error(
        await f.json(
          `${base}/libraries`,
          'POST',
          { name: 'Invalid', path },
          f.credential,
        ),
        400,
        code,
      );
    }
    // A textual prefix without a directory boundary is disjoint.
    await f.add(`${f.root}/music-other`, 'Other');
    await f.idle();
    const listed = await (await f.get(`${base}/libraries`, f.credential))
      .json();
    assertEquals(listed.libraries.length, 2);
    // Concurrent adds cannot pass a pre-write overlap check together.
    await Deno.mkdir(`${f.root}/race/child`, { recursive: true });
    const results = await Promise.all([
      f.json(`${base}/libraries`, 'POST', {
        name: 'Parent',
        path: `${f.root}/race`,
      }, f.credential),
      f.json(`${base}/libraries`, 'POST', {
        name: 'Child',
        path: `${f.root}/race/child`,
      }, f.credential),
    ]);
    assertEquals(results.map((r) => r.status).sort(), [201, 400]);
    for (const response of results) {
      const body = await response.json();
      if (response.status === 400) assertEquals(body.code, 'path_overlaps');
    }
  } finally {
    await Deno.chmod(blocked, 0o700);
    await f.close();
  }
});

Deno.test('API libraries: mutation during an in-flight scan cannot publish removed sources or miss added ones', async () => {
  const f = await fixture();
  const hold = f.holdNext();
  try {
    await Deno.mkdir(`${f.root}/first`);
    await Deno.copyFile(
      'tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3',
      `${f.root}/first/first.mp3`,
    );
    const first = await f.add(`${f.root}/first`, 'First');
    await hold.entered;
    const running = await f.status();
    assertEquals(running.scanning, true);
    const start = await f.json(`${base}/scans`, 'POST', {}, f.credential);
    assertEquals(start.status, 202);
    assertEquals(
      (await start.json()).scan.lastScanStartedMs,
      running.lastScanStartedMs,
    );
    await Deno.mkdir(`${f.root}/second`);
    await Deno.copyFile(
      'tests/fixtures/library/Various Artists/Fixture OST/01 - Probe Performer - Theme.mp3',
      `${f.root}/second/theme.mp3`,
    );
    await f.add(`${f.root}/second`, 'Second');
    const removed = await f.json(
      `${base}/libraries/${first.id}`,
      'DELETE',
      undefined,
      f.credential,
    );
    assertEquals(removed.status, 204);
    await removed.text();
    hold.release();
    const finished = await f.idle();
    assertEquals(finished.lastError, null);
    assertEquals(finished.count, 1);
    assertEquals(finished.folderCount, 1);
    const songs = (await f.rest('search3', { query: '' })).searchResult3.song;
    assertEquals(songs.map((song: { title: string }) => song.title), ['Theme']);
    assertEquals(
      f.notifications.filter((names) => names.includes('database')).length,
      1,
    );
  } finally {
    hold.release();
    await f.close();
  }
});

Deno.test('API libraries: concurrent path edits scan the path changed by each commit', async () => {
  const f = await fixture();
  const hold = f.holdNextUpdate();
  let restoring: Promise<Response> | undefined;
  try {
    await Deno.mkdir(`${f.root}/original`);
    await Deno.mkdir(`${f.root}/other`);
    await Deno.copyFile(
      'tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3',
      `${f.root}/original/song.mp3`,
    );
    await Deno.copyFile(
      'tests/fixtures/library/Various Artists/Fixture OST/01 - Probe Performer - Theme.mp3',
      `${f.root}/other/song.mp3`,
    );
    const library = await f.add(`${f.root}/original`);
    await f.idle();
    const titles = async () =>
      (await f.rest('search3', { query: '' })).searchResult3.song.map(
        (song: { title: string }) => song.title,
      );
    assertEquals(await titles(), ['First Song']);
    // Both requests see original before either commits. Hold the restoring
    // request just outside the real atomic store operation while the other
    // edit commits and finishes its scan. No wall-clock race or fake scanner.
    restoring = f.json(`${base}/libraries/${library.id}`, 'PATCH', {
      path: library.path,
    }, f.credential);
    await hold.entered;
    const other = await f.json(`${base}/libraries/${library.id}`, 'PATCH', {
      path: `${f.root}/other`,
    }, f.credential);
    assertEquals(other.status, 200);
    assertEquals((await other.json()).library.id, library.id);
    await f.idle();
    assertEquals(await titles(), ['Theme']);
    const before = f.notifications.filter((n) => n.includes('scan')).length;
    hold.release();
    const restored = await restoring;
    assertEquals(restored.status, 200);
    assertEquals((await restored.json()).library, library);
    assertEquals((await f.idle()).lastError, null);
    assertEquals(await titles(), ['First Song']);
    assertEquals(
      f.notifications.filter((n) => n.includes('scan')).length,
      before + 2,
    );
  } finally {
    hold.release();
    if (restoring) {
      const response = await restoring;
      if (!response.bodyUsed) await response.text();
    }
    await f.close();
  }
});

Deno.test('API libraries: a moved library does not reserve its former path for new libraries', async () => {
  const f = await fixture();
  try {
    await Deno.mkdir(`${f.root}/original`);
    await Deno.mkdir(`${f.root}/other`);
    await Deno.copyFile(
      'tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3',
      `${f.root}/original/first.mp3`,
    );
    await Deno.copyFile(
      'tests/fixtures/library/Various Artists/Fixture OST/01 - Probe Performer - Theme.mp3',
      `${f.root}/other/theme.mp3`,
    );
    const moved = await f.add(`${f.root}/original`);
    await f.idle();
    const edited = await f.json(`${base}/libraries/${moved.id}`, 'PATCH', {
      path: `${f.root}/other`,
    }, f.credential);
    assertEquals(edited.status, 200);
    assertEquals((await edited.json()).library.id, moved.id);
    await f.idle();
    const added = await f.add(`${f.root}/original`, 'New source');
    assertNotEquals(added.id, moved.id);
    assertEquals((await f.idle()).count, 2);
    const songs = (await f.rest('search3', { query: '' })).searchResult3.song;
    assertEquals(songs.map((song: { title: string }) => song.title).sort(), [
      'First Song',
      'Theme',
    ]);
    const libraries =
      (await (await f.get(`${base}/libraries`, f.credential)).json()).libraries;
    assertEquals(libraries.length, 2);
    assertEquals(
      libraries.find((library: { id: string }) => library.id === moved.id).path,
      `${f.root}/other`,
    );
  } finally {
    await f.close();
  }
});

Deno.test('API libraries: add indexes songs, path edit keeps ids, removal and re-add restore stars', async () => {
  const f = await fixture();
  try {
    await cp('tests/fixtures/library', `${f.root}/music`, { recursive: true });
    const added = await f.add(`${f.root}/music`);
    const initial = await f.idle();
    assertEquals(initial.count, 4);
    assertEquals(initial.lastError, null);
    assertEquals(initial.folderCount, 1);
    assert(initial.lastScanMs >= initial.lastScanStartedMs);
    const artists = (await f.rest('getArtists')).artists.index.flatMap((
      i: { artist: { name: string }[] },
    ) => i.artist.map((a) => a.name));
    assertEquals(artists.sort(), ['Fixture Artist', 'Various Artists']);
    const songs = (await f.rest('search3', { query: '' })).searchResult3
      .song as { id: string }[];
    assertEquals(songs.length, 4);
    const ids = songs.map((s) => s.id).sort();
    await f.rest('star', { id: ids[0] });
    const before = f.notifications.length;
    const renamed = await f.json(`${base}/libraries/${added.id}`, 'PATCH', {
      name: 'Renamed',
    }, f.credential);
    assertEquals((await renamed.json()).library, { ...added, name: 'Renamed' });
    assertEquals(
      (await f.status()).lastScanStartedMs,
      initial.lastScanStartedMs,
    );
    assertEquals(f.notifications.slice(before), [['libraries']]);
    await Deno.rename(`${f.root}/music`, `${f.root}/moved`);
    const moved = await f.json(`${base}/libraries/${added.id}`, 'PATCH', {
      path: `${f.root}/moved`,
    }, f.credential);
    assertEquals(moved.status, 200);
    assertEquals((await moved.json()).library.id, added.id);
    await f.idle();
    assertEquals(
      (await f.rest('search3', { query: '' })).searchResult3.song.map((
        s: { id: string },
      ) => s.id).sort(),
      ids,
    );
    const item =
      await (await f.get(`${base}/libraries/${added.id}`, f.credential)).json();
    assertEquals(item.library.path, `${f.root}/moved`);
    const removed = await f.json(
      `${base}/libraries/${added.id}`,
      'DELETE',
      undefined,
      f.credential,
    );
    assertEquals(removed.status, 204);
    assertEquals(await removed.text(), '');
    assertEquals((await f.rest('getStarred2')).starred2.song ?? [], []);
    // Re-add the edited mount: retained song identity, rather than a fresh
    // path-derived library id, is what brings the user's star back.
    const again = await f.add(`${f.root}/moved`);
    assertNotEquals(again.id, added.id);
    await f.idle();
    const stars = (await f.rest('getStarred2')).starred2.song as {
      id: string;
      starred: string;
    }[];
    assertEquals(stars.map((s) => s.id), [ids[0]]);
    assert(stars[0].starred);
    assert(
      f.notifications.filter((names) => names.includes('scan')).length >= 6,
    );
    assert(f.notifications.some((names) => names.includes('database')));
    const changes = f.logs.map(parseLogfmt).filter((line) =>
      line.event === 'libraries_changed'
    );
    assertEquals(changes.map((line) => line.operation), [
      'add',
      'update',
      'update',
      'remove',
      'add',
    ]);
    for (const line of changes) {
      assertEquals(line.kind, 'http');
      assertEquals(line.via, 'melofon');
      assertEquals(line.username, 'admin');
      assertEquals(line.userAgent, 'Melofon API test');
      assert(line.peer && line.peer !== '127.0.0.1' && line.peer !== '::1');
    }
    await error(
      await f.get(`${base}/libraries/missing`, f.credential),
      404,
      'not_found',
    );
    await error(
      await f.json(
        `${base}/libraries/missing`,
        'PATCH',
        { name: 'Missing' },
        f.credential,
      ),
      404,
      'not_found',
    );
    await error(
      await f.json(
        `${base}/libraries/missing`,
        'DELETE',
        undefined,
        f.credential,
      ),
      404,
      'not_found',
    );
  } finally {
    await f.close();
  }
});

Deno.test('API scans: status preserves fields, failures end with lastError and a successful scan clears it', async () => {
  const f = await fixture();
  try {
    assertEquals(await f.status(), {
      scanning: false,
      count: 0,
      folderCount: 0,
      lastScanMs: null,
      lastScanStartedMs: null,
      lastError: null,
      queued: null,
    });
    await cp('tests/fixtures/library', `${f.root}/music`, { recursive: true });
    f.fail(true);
    await f.add(`${f.root}/music`);
    const failed = await f.idle();
    assertEquals(failed.scanning, false);
    assertEquals(failed.lastError, 'fixture scan failure');
    assertEquals(failed.lastScanMs, null);
    assertEquals(
      f.notifications.filter((names) => names.includes('scan')).length,
      2,
    );
    assertEquals(
      f.notifications.filter((names) => names.includes('database')).length,
      0,
    );
    f.fail(false);
    const response = await f.json(`${base}/scans`, 'POST', {}, f.credential);
    assertEquals(response.status, 202);
    const started = (await response.json()).scan;
    assertEquals(started.scanning, true);
    assertEquals(started.lastError, null);
    const concurrent = await f.json(`${base}/scans`, 'POST', {}, f.credential);
    assertEquals(concurrent.status, 202);
    assertEquals(
      (await concurrent.json()).scan.lastScanStartedMs,
      started.lastScanStartedMs,
    );
    assertEquals((await f.idle()).count, 4);
    assertEquals((await f.status()).lastError, null);
    assertEquals(
      (await f.rest('search3', { query: '' })).searchResult3.song.length,
      4,
    );
  } finally {
    await f.close();
  }
});

Deno.test('API libraries and scans: every endpoint requires admin, Origin and strict JSON', async () => {
  const f = await fixture();
  try {
    await f.auth.users.create(f.admin.id, {
      username: 'listener',
      password: 'password-listener',
      role: 'user',
    });
    const user =
      (await f.login('cookie', 'listener', 'password-listener')).credential;
    for (
      const [path, method, body] of [
        [`${base}/libraries`, 'GET', undefined],
        [`${base}/libraries`, 'POST', {}],
        [`${base}/libraries/missing`, 'GET', undefined],
        [`${base}/libraries/missing`, 'PATCH', {}],
        [`${base}/libraries/missing`, 'DELETE', undefined],
        [`${base}/scans`, 'POST', {}],
        [`${base}/scans/current`, 'GET', undefined],
      ] as const
    ) {
      await error(await f.json(path, method, body), 401, 'unauthenticated');
      await error(await f.json(path, method, body, user), 403, 'forbidden');
    }
    for (const path of [`${base}/libraries`, `${base}/scans`]) {
      await error(
        await f.json(path, 'POST', {}, f.credential, 'http://foreign.home'),
        403,
        'origin',
      );
      await error(
        await f.request(path, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${f.credential}`,
            'Content-Type': 'application/json',
          },
          body: '[',
        }),
        400,
        'not_json',
      );
      await error(
        await f.json(path, 'POST', { extra: true }, f.credential),
        400,
        'unknown_field',
      );
    }
  } finally {
    await f.close();
  }
});
