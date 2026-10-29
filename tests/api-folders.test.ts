import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { apiFixture } from './helpers/api.ts';
import { tagged } from './helpers/tagged.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createFolders } from '../src/folders.ts';
import { scanLibrary } from '../src/scan.ts';

const base = '/api/v1/folders';
type Folder = { libraryId: string; path: string; name: string };
type Song = { id: string; path: string; title: string | null; label: string };
type Body = {
  folder: Folder | null;
  folders: { folders: Folder[]; total: number; offset: number; limit: number };
  songs: { songs: Song[]; total: number; offset: number; limit: number };
};
function query(library?: string, path = '', extra = '') {
  const params = new URLSearchParams({ path });
  if (library !== undefined) params.set('library', library);
  return `${base}?${params}${extra}`;
}
async function fixture() {
  const root = await Deno.makeTempDir({ prefix: 'melofon-api-folders-' });
  try {
    const f = await apiFixture({
      services: async (f) => {
        const libraries = createLibraries(f.store, { notify: f.notify });
        for (const name of ['Music🚀', 'Second', 'Empty', 'Offline']) {
          await Deno.mkdir(`${root}/${name}`);
          await libraries.add(name, `${root}/${name}`);
        }
        const files = [
          'Music🚀/z_root.mp3',
          'Music🚀/alpha_root.mp3',
          'Music🚀/Shared/Disc 1/first.mp3',
          'Music🚀/Shared/Disc 2/second.mp3',
          'Music🚀/Shared/immediate.mp3',
          'Music🚀/Sharedish/other.mp3',
          'Music🚀/alpha/a.mp3',
          'Music🚀/ELAN/a.mp3',
          'Music🚀/élan/a.mp3',
          "Music🚀/100%_it's 🚀/deep/file.mp3",
          'Music🚀/Zulu/a.mp3',
          'Second/Shared/elsewhere.mp3',
        ];
        for (const [i, file] of files.entries()) {
          await Deno.mkdir(`${root}/${file.slice(0, file.lastIndexOf('/'))}`, {
            recursive: true,
          });
          await tagged(
            `${root}/${file}`,
            i === 0 ? {} : {
              TIT2: `Song ${20 - i}`,
              TALB: 'Not a directory',
              TPE1: 'Not a folder',
            },
          );
        }
        await Deno.mkdir(`${root}/Music🚀/No media/Empty child`, {
          recursive: true,
        });
        await Deno.writeTextFile(
          `${root}/Music🚀/No media/readme.txt`,
          'not media',
        );
        await Deno.remove(`${root}/Offline`);
        await scanLibrary(f.store);
        return {
          libraries,
          library: createLibrary(f.store),
          folders: createFolders(f.store),
        };
      },
    });
    await f.auth.users.create(f.admin.id, {
      username: 'listener',
      password: 'password-listener',
      role: 'user',
    });
    const libraries = await f.store.catalog.listLibraries();
    return {
      ...f,
      root,
      libraries,
      id: (name: string) => libraries.find((l) => l.name === name)!.id,
      async close() {
        await f.close();
        await Deno.remove(root, { recursive: true });
      },
    };
  } catch (error) {
    await Deno.remove(root, { recursive: true });
    throw error;
  }
}
async function body(response: Response): Promise<Body> {
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json();
}
async function error(response: Response, status: number, code: string) {
  assertEquals(response.status, status, await response.clone().text());
  const value = await response.json();
  assertEquals(value.code, code);
  assertEquals(Object.keys(value).sort(), ['code', 'message']);
}

Deno.test('API folders: roots, real nested directories and immediate songs navigate with both credentials', async () => {
  const f = await fixture();
  try {
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      const read = async (url: string) =>
        await body(
          await f.get(url, credential, { Origin: 'http://foreign.home' }),
        );
      const roots = await read(base);
      assertEquals(Object.keys(roots).sort(), ['folder', 'folders', 'songs']);
      assertEquals(roots.folder, null);
      assertEquals(roots.folders.total, 4);
      assertEquals(roots.songs, { songs: [], total: 0, offset: 0, limit: 50 });
      assertEquals(roots.folders.folders.map((r) => r.path), ['', '', '', '']);
      const music = f.id('Music🚀');
      const top = await read(query(music));
      assertEquals(top.folder, { libraryId: music, path: '', name: 'Music🚀' });
      assertEquals(top.folders.folders.map((r) => r.name), [
        "100%_it's 🚀",
        'alpha',
        'ELAN',
        'élan',
        'Shared',
        'Sharedish',
        'Zulu',
      ]);
      assertEquals(top.songs.songs.map((r) => r.path), [
        'alpha_root.mp3',
        'z_root.mp3',
      ]);
      assertEquals(top.songs.songs[1].title, null);
      assertEquals(top.songs.songs[1].label, '[z root]');
      for (const row of top.folders.folders) assertEquals(row.path, row.name);
      const shared = await read(query(music, 'Shared'));
      assertEquals(
        shared.folders.folders,
        ['Disc 1', 'Disc 2'].map((name) => ({
          libraryId: music,
          path: `Shared/${name}`,
          name,
        })),
      );
      assertEquals(shared.songs.songs.map((r) => r.path), [
        'Shared/immediate.mp3',
      ]);
      const leaf = await read(query(music, shared.folders.folders[0].path));
      assertEquals(leaf.folder, {
        libraryId: music,
        path: 'Shared/Disc 1',
        name: 'Disc 1',
      });
      assertEquals(leaf.folders.total, 0);
      assertEquals(leaf.songs.songs.map((r) => r.path), [
        'Shared/Disc 1/first.mp3',
      ]);
      const second = await read(query(f.id('Second'), 'Shared'));
      assertEquals(second.songs.songs.map((r) => r.path), [
        'Shared/elsewhere.mp3',
      ]);
      assertNotEquals(second.songs.songs[0].id, shared.songs.songs[0].id);
      const literal = await read(query(music, "100%_it's 🚀"));
      assertEquals(literal.folders.folders[0].path, "100%_it's 🚀/deep");
      assertEquals(
        (await read(query(music, literal.folders.folders[0].path))).songs.total,
        1,
      );
      for (const page of [top, shared, leaf, second]) {
        for (const song of page.songs.songs) {
          assertEquals(
            song,
            (await (await f.get(`/api/v1/songs/${song.id}`, credential)).json())
              .song,
          );
          for (
            const key of [
              'libraryPath',
              'starred',
              'userRating',
              'averageRating',
              'playCount',
              'played',
              'lastPlayed',
            ]
          ) assert(!(key in song));
        }
        assert(!JSON.stringify(page).includes(f.root));
      }
      const admin = (await f.login('bearer')).credential;
      assertEquals(await body(await f.get(query(music), admin)), top);
    }
    assert(f.origin.startsWith('http://melofon.home:'));
    assert(f.peers.every((p) => p !== '127.0.0.1' && p !== '::1'));
  } finally {
    await f.close();
  }
});

Deno.test('API folders: independent pages partition folded immediate entries with exact past-end totals', async () => {
  const f = await fixture();
  try {
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      for (const library of [undefined, f.id('Music🚀')]) {
        const full = await body(await f.get(query(library), credential));
        for (const category of ['folders', 'songs'] as const) {
          const joined: unknown[] = [];
          const other = category === 'folders' ? 'songs' : 'folders';
          for (let offset = 0; offset <= full[category].total + 1; offset++) {
            const page = await body(
              await f.get(
                query(
                  library,
                  '',
                  `&${category.slice(0, -1)}Offset=${offset}&${
                    category.slice(0, -1)
                  }Limit=1`,
                ),
                credential,
              ),
            );
            assertEquals(page[category].total, full[category].total);
            assertEquals([page[category].offset, page[category].limit], [
              offset,
              1,
            ]);
            const rows = category === 'folders'
              ? page.folders.folders
              : page.songs.songs;
            const all = category === 'folders'
              ? full.folders.folders
              : full.songs.songs;
            assertEquals(rows, all.slice(offset, offset + 1));
            assertEquals(page[other], full[other]);
            joined.push(...rows);
          }
          assertEquals(
            joined,
            category === 'folders' ? full.folders.folders : full.songs.songs,
          );
        }
      }
    }
  } finally {
    await f.close();
  }
});

Deno.test('API folders: catalog validators cover scope, path, both pages and publication while offline browsing uses the index', async () => {
  const f = await fixture();
  try {
    const music = f.id('Music🚀');
    const url = query(music, 'Shared');
    const tag = (r: Response) => {
      const value = r.headers.get('ETag');
      assert(value?.startsWith('W/"'));
      return value!;
    };
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      const first = await f.get(url, credential);
      const etag = tag(first);
      const original = await body(first);
      const again = await f.get(url, credential, {
        'If-None-Match': etag,
        Origin: 'http://foreign.home',
      });
      assertEquals(again.status, 304);
      assertEquals(await again.text(), '');
      assertEquals(tag(again), etag);
      assertEquals(again.headers.get('Cache-Control'), 'private, no-cache');
      const explicit = await f.get(
        url + '&folderOffset=0&folderLimit=50&songOffset=0&songLimit=50',
        credential,
      );
      assertEquals(tag(explicit), etag);
      await explicit.text();
      for (
        const changed of [
          base,
          query(f.id('Second'), 'Shared'),
          query(music),
          url + '&folderLimit=1',
          url + '&folderOffset=1',
          url + '&songLimit=1',
          url + '&songOffset=1',
        ]
      ) {
        const r = await f.get(changed, credential, { 'If-None-Match': etag });
        assertEquals(r.status, 200);
        assertNotEquals(tag(r), etag);
        await r.text();
      }
      // Filesystem loss without a publication must not erase indexed ancestors.
      await Deno.rename(`${f.root}/Music🚀`, `${f.root}/Away`);
      try {
        assertEquals(await body(await f.get(url, credential)), original);
      } finally {
        await Deno.rename(`${f.root}/Away`, `${f.root}/Music🚀`);
      }
      await Deno.remove(`${f.root}/Music🚀/Shared/Disc 2`, { recursive: true });
      await scanLibrary(f.store);
      const changed = await f.get(url, credential, { 'If-None-Match': etag });
      assertNotEquals(tag(changed), etag);
      assertEquals((await body(changed)).folders.folders.map((r) => r.name), [
        'Disc 1',
      ]);
      await error(
        await f.get(query(music, 'Shared/Disc 2'), credential, {
          'If-None-Match': '*',
        }),
        404,
        'not_found',
      );
      // Restore the fixture for the other credential using real scan acquisition.
      await Deno.mkdir(`${f.root}/Music🚀/Shared/Disc 2`);
      await tagged(`${f.root}/Music🚀/Shared/Disc 2/second.mp3`, {});
      await scanLibrary(f.store);
    }
    const admin = (await f.login('bearer')).credential;
    const before = await f.get(base, admin);
    const beforeTag = tag(before);
    await before.text();
    const removed = await f.json(
      `/api/v1/admin/libraries/${music}`,
      'DELETE',
      undefined,
      admin,
    );
    assertEquals(removed.status, 204);
    await removed.text();
    const after = await f.get(base, admin, { 'If-None-Match': beforeTag });
    assertNotEquals(tag(after), beforeTag);
    assertEquals((await body(after)).folders.total, 3);
    await error(
      await f.get(url, admin, { 'If-None-Match': '*' }),
      404,
      'not_found',
    );
  } finally {
    await f.close();
  }
});

Deno.test('API folders: strict path/query validation, authentication and live page settings precede conditional reads', async () => {
  const f = await fixture();
  try {
    const cookie =
      (await f.login('cookie', 'listener', 'password-listener')).credential;
    await error(await f.get(base), 401, 'unauthenticated');
    await error(
      await f.get(base, cookie, {
        Authorization: 'Bearer invalid',
        'If-None-Match': '*',
      }),
      401,
      'unauthenticated',
    );
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      for (
        const path of [
          '..',
          '.',
          '../Shared',
          'Shared/..',
          'Shared/./Disc 1',
          '/Shared',
          '//Shared',
          'Shared//Disc 1',
          'Shared/',
          'C:/music',
          'C:\\music',
          'Shared\\Disc 1',
          'bad\0name',
          'bad\nname',
        ]
      ) {
        await error(
          await f.get(query(f.id('Music🚀'), path), credential, {
            'If-None-Match': '*',
          }),
          400,
          'invalid_field',
        );
      }
      for (
        const suffix of [
          '?unknown=1',
          '?library=',
          '?library=x&library=y',
          '?path=a&path=b',
          '?folderLimit=0',
          '?songLimit=501',
          '?folderOffset=-1',
          '?songOffset=1.5',
          '?folderLimit=1&folderLimit=2',
          '?songOffset=9007199254740992',
          '?offset=0',
          '?sort=name',
          '?path=Shared',
        ]
      ) {
        await error(
          await f.get(base + suffix, credential, { 'If-None-Match': '*' }),
          400,
          'invalid_field',
        );
      }
      await error(
        await f.get(query('missing'), credential, { 'If-None-Match': '*' }),
        404,
        'not_found',
      );
      for (const path of ['missing', 'No media', 'z_root.mp3', 'Shared/Disc']) {
        await error(
          await f.get(query(f.id('Music🚀'), path), credential, {
            'If-None-Match': '*',
          }),
          404,
          'not_found',
        );
      }
      const method = await f.json(base, 'POST', {}, credential);
      assertEquals(method.status, 405);
      assertEquals(method.headers.get('Allow'), 'GET');
      await method.text();
    }
    await f.state.set('melofon.browseMaxPageRecords', '2');
    const limited = await body(await f.get(query(f.id('Music🚀')), cookie));
    assertEquals([limited.folders.limit, limited.songs.limit], [2, 2]);
    assertEquals([limited.folders.total, limited.songs.total], [7, 2]);
    await error(
      await f.get(base + '?folderLimit=3', cookie),
      400,
      'invalid_field',
    );
    await error(
      await f.get(base + '?songLimit=3', cookie),
      400,
      'invalid_field',
    );
  } finally {
    await f.close();
  }
});

Deno.test('API folders: configured empty and unavailable roots exist, non-media directories do not, empty catalog has zero roots', async () => {
  const f = await fixture();
  try {
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      for (const name of ['Empty', 'Offline']) {
        const page = await body(
          await f.get(
            query(f.id(name), '', '&folderOffset=90&songOffset=80'),
            credential,
          ),
        );
        assertEquals(page.folder, { libraryId: f.id(name), path: '', name });
        assertEquals(page.folders, {
          folders: [],
          total: 0,
          offset: 90,
          limit: 50,
        });
        assertEquals(page.songs, {
          songs: [],
          total: 0,
          offset: 80,
          limit: 50,
        });
        await error(
          await f.get(query(f.id(name), 'No media'), credential),
          404,
          'not_found',
        );
      }
    }
  } finally {
    await f.close();
  }
  const empty = await apiFixture({
    services: (f) => Promise.resolve({ folders: createFolders(f.store) }),
  });
  try {
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await empty.login(use);
      const page = await body(
        await empty.get(base + '?folderOffset=99&songOffset=88', credential),
      );
      assertEquals(page, {
        folder: null,
        folders: { folders: [], total: 0, offset: 99, limit: 50 },
        songs: { songs: [], total: 0, offset: 88, limit: 50 },
      });
    }
  } finally {
    await empty.close();
  }
});
