import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { apiFixture, error } from './helpers/api.ts';
import { tagged } from './helpers/tagged.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createFolders } from '../src/folders.ts';
import { createScan } from '../src/scan.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { createUserService } from '../src/user.ts';
import { createReferenceMatcher } from '../src/reference-matcher.ts';
import { createState } from '../src/state.ts';
import { openStore } from '../src/store/index.ts';

const names = ['The Zebra', 'Beta', 'El Alpha', 'Zulu', 'Theatre'];
const defaults = [
  'The',
  'El',
  'La',
  'Los',
  'Las',
  'Le',
  'Les',
  'Os',
  'As',
  'O',
  'A',
];
const defaultOrder = ['El Alpha', 'Beta', 'Theatre', 'The Zebra', 'Zulu'];
const noArticles = ['Beta', 'El Alpha', 'The Zebra', 'Theatre', 'Zulu'];
const onlyThe = ['Beta', 'El Alpha', 'Theatre', 'The Zebra', 'Zulu'];
type Entity = 'artists' | 'albums' | 'songs' | 'genres';
type Row = { name?: string; title?: string };

async function orderFixture(entity: Entity = 'artists') {
  const root = await Deno.makeTempDir({ prefix: 'melofon-browse-order-' });
  try {
    const f = await apiFixture({
      allLayers: true,
      services: async (f) => {
        const libraries = createLibraries(f.store);
        await libraries.add('Music', root);
        for (const name of names) {
          await Deno.mkdir(`${root}/${name}`);
          await tagged(`${root}/${name}/${name}.mp3`, {
            TIT2: name,
            TALB: name,
            TPE1: entity === 'artists' ? name : 'Member',
            TPE2: entity === 'artists' ? name : 'Member',
            TCON: entity === 'genres' ? name : 'Fixture',
          });
        }
        const scan = createScan(f.store);
        await scan.run();
        return {
          libraries,
          library: createLibrary(f.store, undefined, {
            state: f.state,
            notify: f.notify,
          }),
          folders: createFolders(f.store),
          scan,
          user: createUserService(f.store, f.cfg),
          annotation: createAnnotation(f.store),
          listens: createListens(f.store),
        };
      },
    });
    await f.auth.users.create(f.admin.id, {
      username: 'listener',
      password: 'password-listener',
      role: 'user',
    });
    return {
      ...f,
      root,
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
type Fixture = Awaited<ReturnType<typeof orderFixture>>;

async function setting(f: Fixture, admin: string) {
  const response = await f.get(
    '/api/v1/admin/settings/catalog.ignoredArticles',
    admin,
  );
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json();
}
async function change(
  f: Fixture,
  admin: string,
  value: string[],
  revision?: number,
) {
  const response = await f.json('/api/v1/admin/settings', 'PATCH', {
    changes: [{
      key: 'catalog.ignoredArticles',
      value,
      ...(revision === undefined ? {} : { revision }),
    }],
  }, admin);
  assertEquals(response.status, 200, await response.clone().text());
  return (await response.json()).settings[0];
}
async function read(
  f: Fixture,
  path: string,
  credential: string,
  etag?: string,
) {
  const response = await f.get(path, credential, {
    Origin: 'http://foreign.home',
    ...(etag ? { 'If-None-Match': etag } : {}),
  });
  assertEquals(response.status, 200, await response.clone().text());
  assertEquals(response.headers.get('cache-control'), 'private, no-cache');
  assert(response.headers.get('etag'));
  return { body: await response.json(), etag: response.headers.get('etag')! };
}

for (const entity of ['artists', 'albums', 'songs', 'genres'] as const) {
  Deno.test(`browse articles: ${entity} use the live core list before native paging`, async () => {
    const f = await orderFixture(entity);
    try {
      const admin = (await f.login('bearer')).credential;
      const clients = await Promise.all(
        ['cookie', 'bearer'].map(async (mode) =>
          (await f.login(
            mode as 'cookie' | 'bearer',
            'listener',
            'password-listener',
          )).credential
        ),
      );
      const paths = [`/api/v1/${entity}`];
      if (entity === 'albums') {
        const artist = (await f.store.catalog.listArtists())[0];
        paths.push(`/api/v1/artists/${artist.id}/albums`);
      }
      const library = (await f.store.catalog.listLibraries())[0].id;
      const label = (row: Row) => entity === 'songs' ? row.title : row.name;
      for (
        const [articles, expected] of [[defaults, defaultOrder], [
          [],
          noArticles,
        ], [['The'], onlyThe]] as const
      ) {
        if (articles !== defaults) await change(f, admin, [...articles]);
        for (const credential of clients) {
          for (const path of paths) {
            for (const scope of ['', `library=${library}&`]) {
              const all = await read(f, `${path}?${scope}limit=50`, credential);
              assertEquals(all.body[entity].map(label), expected);
              assertEquals(all.body.total, names.length);
              const pages = [];
              for (let offset = 0; offset <= names.length; offset++) {
                const page = await read(
                  f,
                  `${path}?${scope}limit=1&offset=${offset}`,
                  credential,
                );
                assertEquals(page.body.total, names.length);
                pages.push(...page.body[entity].map(label));
              }
              assertEquals(pages, expected);
              if (
                path === `/api/v1/${entity}` &&
                (entity === 'albums' || entity === 'songs')
              ) {
                assertEquals(
                  (await read(f, `${path}?${scope}sort=artist`, credential))
                    .body[entity].map(label),
                  expected,
                );
              }
            }
          }
          const search = await read(f, '/api/v1/search?query=', credential);
          if (entity !== 'genres') {
            assertEquals(search.body[entity][entity].map(label), expected);
          }
        }
      }
      assert(f.peers.every((p) => p !== '127.0.0.1' && p !== '::1'));
      // Legacy unoptioned catalog reads remain opt-in, never implicitly changed.
      assertEquals(
        (await f.store.catalog.listAlbums({
          sort: 'name',
          size: 50,
          offset: 0,
        })).map((a) => a.name),
        noArticles,
      );
    } finally {
      await f.close();
    }
  });
}

async function legacy(f: Fixture, operation: string, extra = '') {
  const response = await f.get(
    `/rest/${operation}.view?u=admin&p=password-admin&v=1.16.1&c=articles&f=json${extra}`,
  );
  assertEquals(response.status, 200);
  const envelope = (await response.json())['subsonic-response'];
  assertEquals(envelope.status, 'ok');
  return envelope;
}
async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert(Date.now() < deadline, 'waiting for library change');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

Deno.test('browse articles: admin HTTP edit → public WS → changed native validator and matching OpenSubsonic index', async () => {
  const f = await orderFixture();
  const sockets: WebSocket[] = [];
  try {
    const matcher = createReferenceMatcher(f.store, f.state);
    const admin = (await f.login('bearer')).credential;
    const original = await setting(f, admin);
    assertEquals(original.owner, 'core');
    assertEquals(original.default, defaults);
    assertEquals(original.value, defaults);
    assertEquals(original.revision, 0);
    const beforeMatch = await matcher.artists([{ name: 'Zebra' }]);
    assertEquals(beforeMatch[0].present, true);
    const clients = [];
    const library = (await f.store.catalog.listLibraries())[0].id;
    const paths = [
      '/api/v1/artists',
      '/api/v1/albums',
      '/api/v1/songs',
      '/api/v1/genres',
      '/api/v1/search',
      `/api/v1/folders?library=${library}`,
    ];
    for (const mode of ['cookie', 'bearer'] as const) {
      const credential =
        (await f.login(mode, 'listener', 'password-listener')).credential;
      const frames: { type: string; events?: Record<string, unknown> }[] = [];
      const ws = new WebSocket(
        `${f.origin.replace('http:', 'ws:')}/api/v1/events`,
        {
          headers: {
            Origin: f.origin,
            ...(mode === 'cookie'
              ? { Cookie: credential }
              : { Authorization: `Bearer ${credential}` }),
          },
        },
      );
      sockets.push(ws);
      ws.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
      await waitFor(() => frames.some((frame) => frame.type === 'hello'));
      frames.length = 0;
      const previous = await Promise.all(
        paths.map((path) => read(f, path, credential)),
      );
      clients.push({ credential, frames, previous });
    }
    await error(await f.get('/api/v1/artists'), 401, 'unauthenticated');
    await error(
      await f.json('/api/v1/admin/settings', 'PATCH', {
        changes: [{ key: 'catalog.ignoredArticles', value: [] }],
      }, clients[0].credential),
      403,
      'forbidden',
    );
    const baseline = await legacy(f, 'getArtists');
    assertEquals(baseline.artists.ignoredArticles, defaults.join(' '));
    assertEquals(baseline.artists.index.map((g: { name: string }) => g.name), [
      'A',
      'B',
      'T',
      'X-Z',
    ]);

    const edited = await change(f, admin, [], original.revision);
    assertEquals(edited.value, []);
    assertEquals(edited.revision, 1);
    assertEquals((await setting(f, admin)).value, []);
    for (const client of clients) {
      await waitFor(() => client.frames.some((frame) => frame.events?.library));
      assertEquals(client.frames.filter((frame) => frame.events?.library), [{
        type: 'changed',
        events: { library: [] },
      }]);
      assert(!client.frames.some((frame) => frame.events?.settings));
      for (const [i, path] of paths.entries()) {
        const next = await read(
          f,
          path,
          client.credential,
          client.previous[i].etag,
        );
        assertNotEquals(next.etag, client.previous[i].etag);
        const repeat = await f.get(path, client.credential, {
          'If-None-Match': next.etag,
        });
        assertEquals(repeat.status, 304);
        assertEquals(await repeat.text(), '');
        if (path === '/api/v1/artists') {
          assertEquals(next.body.artists.map((a: Row) => a.name), noArticles);
        }
        if (path.startsWith('/api/v1/folders')) {
          assertEquals(
            next.body.folders.folders.map((a: Row) => a.name),
            noArticles,
          );
        }
      }
    }
    for (
      const [operation, field] of [['getArtists', 'artists'], [
        'getIndexes',
        'indexes',
      ]]
    ) {
      const result = (await legacy(f, operation))[field];
      assertEquals(result.ignoredArticles, '');
      assertEquals(
        result.index.map((
          g: { name: string; artist: Row[] },
        ) => [g.name, g.artist.map((a) => a.name)]),
        [
          ['B', ['Beta']],
          ['E', ['El Alpha']],
          ['T', ['The Zebra', 'Theatre']],
          ['X-Z', ['Zulu']],
        ],
      );
    }
    for (const operation of ['getAlbumList', 'getAlbumList2']) {
      const field = operation === 'getAlbumList' ? 'albumList' : 'albumList2';
      const result = await legacy(f, operation, '&type=alphabeticalByName');
      assertEquals(
        result[field].album.map((a: { name?: string; title?: string }) =>
          a.name ?? a.title
        ),
        noArticles,
      );
    }
    const xml = await f.get(
      '/rest/getArtists.view?u=admin&p=password-admin&v=1.16.1&c=articles',
    );
    assert((await xml.text()).includes('ignoredArticles=""'));
    assertEquals(await matcher.artists([{ name: 'Zebra' }]), beforeMatch);
    assertEquals(await f.state.getTyped('reference.ignoredArticles'), defaults);

    // A new revision must invalidate even when its effective list is unchanged.
    const prior = await read(f, paths[0], clients[0].credential);
    await change(f, admin, [], 1);
    const same = await read(f, paths[0], clients[0].credential, prior.etag);
    assertEquals(same.body, prior.body);
    assertNotEquals(same.etag, prior.etag);
    const referenceEdit = await f.json('/api/v1/admin/settings', 'PATCH', {
      changes: [{ key: 'reference.ignoredArticles', value: [] }],
    }, admin);
    assertEquals(referenceEdit.status, 200);
    await referenceEdit.body?.cancel();
    assertEquals(
      (await matcher.artists([{ name: 'Zebra' }]))[0].present,
      false,
    );
    assertEquals(await read(f, paths[0], clients[0].credential), same);
    await change(f, admin, ['The'], 2);
    for (
      const [operation, field] of [['getArtists', 'artists'], [
        'getIndexes',
        'indexes',
      ]]
    ) {
      const result = (await legacy(f, operation))[field];
      assertEquals(result.ignoredArticles, 'The');
      assertEquals(result.index.map((group: { name: string }) => group.name), [
        'B',
        'E',
        'T',
        'X-Z',
      ]);
    }
    assertEquals(
      (await read(f, paths[0], clients[0].credential)).body.artists.map((
        a: Row,
      ) => a.name),
      onlyThe,
    );
  } finally {
    for (const ws of sockets) {
      if (ws.readyState < WebSocket.CLOSING) ws.close();
      await waitFor(() => ws.readyState === WebSocket.CLOSED);
    }
    await f.close();
  }
});

Deno.test('browse articles: validation/conflicts publish nothing; reset and reopen retain the independent policies', async () => {
  const f = await orderFixture();
  try {
    const admin = (await f.login('cookie')).credential;
    await change(f, admin, ['The']);
    const changed = await read(f, '/api/v1/artists', admin);
    const notifications = f.notifications.length;
    for (const value of ['The', [''], ['The Band'], ['A,B'], [3]]) {
      const response = await f.json('/api/v1/admin/settings', 'PATCH', {
        changes: [{ key: 'catalog.ignoredArticles', value }],
      }, admin);
      assertEquals(response.status, 400);
      const body = await response.json();
      assertEquals(body.code, 'invalid_value');
      assertEquals(body.key, 'catalog.ignoredArticles');
      assertEquals(Object.keys(body).sort(), ['code', 'key', 'message']);
    }
    const conflict = await f.json('/api/v1/admin/settings', 'PATCH', {
      changes: [{ key: 'catalog.ignoredArticles', value: [], revision: 0 }],
    }, admin);
    assertEquals(conflict.status, 409);
    await conflict.body?.cancel();
    assertEquals(f.notifications.length, notifications);
    assertEquals(await read(f, '/api/v1/artists', admin), changed);
    const reset = await f.json('/api/v1/admin/settings', 'PATCH', {
      changes: [{ key: 'catalog.ignoredArticles', reset: true, revision: 1 }],
    }, admin);
    assertEquals(reset.status, 200);
    const restored = (await reset.json()).settings[0];
    assertEquals(restored.value, defaults);
    assertEquals(restored.revision, 2);
    const after = await read(f, '/api/v1/artists', admin, changed.etag);
    assertEquals(after.body.artists.map((a: Row) => a.name), defaultOrder);
    // The reopened owner reads the persisted tombstone/revision, not memory.
    const checkpoint = await f.store.state.getWithRevision(
      'catalog.ignoredArticles',
    );
    assertEquals(checkpoint, { value: null, revision: 2 });
    // Close the fixture's services before opening the same on-disk store again.
    await f.store.close();
    const reopened = await openStore(f.dir);
    try {
      const state = createState(reopened);
      assertEquals(
        await createLibrary(reopened, undefined, { state }).order(),
        { ignoredArticles: defaults, revision: 2 },
      );
      await state.set('catalog.ignoredArticles', 'El');
      assertEquals(
        await createLibrary(reopened, undefined, { state }).order(),
        { ignoredArticles: ['El'], revision: 3 },
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});
