// tests/libraries.test.ts — M3 scan sources: app.libraries add/list/remove
// (remove cleans the catalog), the core /_/libraries CRUD the Settings UI
// will form over, and the two-fixture-roots flow the plan demands: sources
// are created through the HTTP API (never an env var), getMusicFolders
// returns both, getUser.folder carries the same ids, and musicFolderId
// filters the browse ops.
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from '@std/assert';
import { LibraryError } from '../src/library-errors.ts';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { seedFirstUser } from '../src/users.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createUserService } from '../src/user.ts';
import { createLibrary } from '../src/library.ts';
import { createShares } from '../src/shares.ts';
import { createPlaylists } from '../src/playlists.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { loadLayers } from '../src/layers.ts';
import { createState } from '../src/state.ts';
import { facade } from '../src/facade.ts';

const AUTH = 'u=admin&p=test&v=1.16.1&c=melofon-test';
const ROOT_A = await Deno.realPath('tests/fixtures/library/Fixture Artist');
const ROOT_B = await Deno.realPath('tests/fixtures/library/Various Artists');

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-libs-' });
  const store = await openStore(dir);
  const db = store;
  const cfg = {
    listen: undefined,
    dataDir: dir,
    user: 'admin',
    password: 'test',
    secret: 's3cret',
    version: '0.0.0-test',
  };
  await seedFirstUser(store, cfg);
  const libraries = createLibraries(store);
  const core = await pathfinder({
    roots: ['core/'],
    app: { store, cfg, libraries },
  });
  return {
    db,
    store,
    dir,
    cfg,
    libraries,
    core,
    close: async () => {
      await db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

async function addViaApi(
  core: (req: Request) => Promise<Response>,
  name: string,
  path: string,
): Promise<{ id: string; name: string; path: string }> {
  const res = await core(
    new Request('http://x/libraries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, path }),
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  return (body as { library: { id: string; name: string; path: string } })
    .library;
}

Deno.test('app.libraries rejects duplicate paths and lists by name', async () => {
  const { libraries, close } = await setup();
  try {
    const a = await libraries.add('B root', ROOT_B);
    const b = await libraries.add('A root', ROOT_A);
    const error = await assertRejects(
      () => libraries.add('other name', ROOT_B),
      LibraryError,
    );
    assertEquals(error.code, 'path_duplicate');
    const rows = await libraries.list();
    assertEquals(rows.map((r) => r.name), ['A root', 'B root']);
    assertNotEquals(a.id, b.id);
  } finally {
    await close();
  }
});

Deno.test('app.libraries remove drops the source and its catalog rows', async () => {
  const { db, store, libraries, close } = await setup();
  try {
    const a = await libraries.add('A root', ROOT_A);
    await libraries.add('B root', ROOT_B);
    await scanLibrary(store);
    const count = async (sql: string) => {
      const res = await rawSql(db).all(sql);
      return Number((res as { n: bigint }[])[0].n);
    };
    assertEquals(await count('SELECT COUNT(*) AS n FROM files'), 4);
    assertEquals(await libraries.remove(a.id), true);
    assertEquals(await count('SELECT COUNT(*) AS n FROM files'), 1);
    // Orphan albums/artists of the removed source are gone; B's remain.
    assertEquals(await count('SELECT COUNT(*) AS n FROM albums'), 1);
    const artists = await rawSql(db).all('SELECT name FROM artists');
    const names = artists.map((r) => (r as { name: string }).name);
    assert(!names.includes('Fixture Artist'));
    assertEquals(await libraries.remove(a.id), false);
  } finally {
    await close();
  }
});

Deno.test('core /_/libraries CRUD validates input and round-trips rows', async () => {
  const { core, close } = await setup();
  try {
    const badJson = await core(
      new Request('http://x/libraries', { method: 'POST', body: 'not json' }),
    );
    assertEquals(badJson.status, 400);
    const missing = await core(
      new Request('http://x/libraries', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'no path' }),
      }),
    );
    assertEquals(missing.status, 400);
    const notDir = await core(
      new Request('http://x/libraries', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'ghost', path: '/no/such/dir' }),
      }),
    );
    assertEquals(notDir.status, 400);

    const row = await addViaApi(core, 'A root', ROOT_A);
    assertEquals(row.name, 'A root');
    assertEquals(row.path, ROOT_A);
    const list = await core(new Request('http://x/libraries'));
    assertEquals(list.status, 200);
    const listed = (await list.json()) as {
      libraries: {
        id: string;
        name: string;
        path: string;
        available: boolean;
      }[];
    };
    assertEquals(listed.libraries, [{
      id: row.id,
      name: 'A root',
      path: ROOT_A,
      available: true,
    }]);

    const gone = await core(
      new Request(`http://x/libraries/${row.id}`, { method: 'DELETE' }),
    );
    assertEquals(gone.status, 200);
    const unknown = await core(
      new Request(`http://x/libraries/${row.id}`, { method: 'DELETE' }),
    );
    assertEquals(unknown.status, 404);
  } finally {
    await close();
  }
});

Deno.test('two fixture roots via the API: getMusicFolders lists both, musicFolderId filters', async () => {
  const { store, cfg, core, libraries, close } = await setup();
  try {
    const a = await addViaApi(core, 'A root', ROOT_A);
    await addViaApi(core, 'B root', ROOT_B);
    await scanLibrary(store);
    const state = createState(store), library = createLibrary(store);
    const bag = {
      state,
      shares: createShares(store, state, library, createPlaylists(store)),
      cfg,
      libraries,
      user: createUserService(store, cfg),
      library,
      annotation: createAnnotation(store),
      listens: createListens(store),
    };
    const app = facade(core, await loadLayers({ app: bag }));
    const get = async (op: string, extra = '') => {
      const res = await app(
        new Request(`http://x/rest/${op}?${AUTH}&f=json${extra}`),
      );
      assertEquals(res.status, 200);
      const body = await res.json();
      return (body as Record<string, Record<string, unknown>>)[
        'subsonic-response'
      ];
    };

    const folders = await get('getMusicFolders');
    // Folder ids are spec ints on the wire; storage hashes stay server-side.
    const musicFolder = (
      folders.musicFolders as { musicFolder: { id: number; name: string }[] }
    ).musicFolder;
    assertEquals(
      musicFolder.map((f) => [f.name, typeof f.id]),
      [
        ['A root', 'number'],
        ['B root', 'number'],
      ],
    );

    // getUser.folder carries the same wire ids (never a synthetic 0).
    const user = await get('getUser', '&username=admin');
    const folder = (user.user as { folder: number[] }).folder;
    const byNum = (x: number, y: number) => x - y;
    assertEquals(
      [...folder].sort(byNum),
      musicFolder.map((f) => f.id).sort(byNum),
    );

    const artistNames = (body: Record<string, unknown>) => {
      const artists = body.artists as {
        index: { artist: { name: string }[] }[];
      };
      return artists.index.flatMap((i) => i.artist.map((a) => a.name));
    };
    const idA = musicFolder.find((f) => f.name === 'A root')!.id;
    const idB = musicFolder.find((f) => f.name === 'B root')!.id;
    // The wire int round-trips back to the right source.
    const onlyA = await get('getArtists', `&musicFolderId=${idA}`);
    assertEquals(artistNames(onlyA), ['Fixture Artist']);
    const onlyB = await get('getArtists', `&musicFolderId=${idB}`);
    assertEquals(artistNames(onlyB), ['Various Artists']);
    // Stale-client grace: a raw storage hash still filters.
    const byHash = await get('getArtists', `&musicFolderId=${a.id}`);
    assertEquals(artistNames(byHash), ['Fixture Artist']);
    const combined = await get('getArtists');
    assertEquals(artistNames(combined), ['Fixture Artist', 'Various Artists']);
  } finally {
    await close();
  }
});
