// Capability facts are public; catalog and mutations still use the one
// authenticated request-param boundary and the ordinary injected services.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { facade } from '../src/facade.ts';
import { loadLayers } from '../src/layers.ts';
import { createState } from '../src/state.ts';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { seedFirstUser } from '../src/users.ts';
import { createUserService } from '../src/user.ts';
import { createLibraries } from '../src/libraries.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibrary } from '../src/library.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import {
  CAPABILITIES,
  capabilityPayload,
} from '../layers/opensubsonic/capabilities.ts';
import { ok } from '../layers/opensubsonic/envelope.ts';
import type { HatContext } from '../layers/opensubsonic/types.ts';

const EXPECTED = [
  { name: 'formPost', versions: [1] },
  {
    name: 'transcodeOffset',
    versions: [1],
  },
  { name: 'transcoding', versions: [1] },
  { name: 'songLyrics', versions: [1, 2] },
  { name: 'indexBasedQueue', versions: [1] },
  { name: 'playbackReport', versions: [1] },
  { name: 'topSongsByArtistId', versions: [1] },
  { name: 'getPodcastEpisode', versions: [1] },
];
const OP = 'getOpenSubsonicExtensions';
const AUTH = new URLSearchParams({
  u: 'fixture + 雪',
  p: 'p&=+% café 🔑',
  v: '1.16.1',
  c: 'H1 consumer + 雪',
  f: 'json',
});

async function router() {
  const core = await pathfinder({ roots: ['core/'], app: {} });
  const layers = await loadLayers({
    app: {
      state: { declare() {} },
      cfg: { version: '0.0.0-test' },
      user: {
        auth: () => Promise.resolve(null),
        authMd5: () => Promise.resolve(null),
      },
    },
  });
  return { app: facade(core, layers), core, layers };
}

async function body(res: Response) {
  assertEquals(res.status, 200);
  return (await res.json())['subsonic-response'];
}

Deno.test('H1 regression: exact discovery is public without u/v/c', async () => {
  const { app } = await router();
  const value = await body(
    await app(new Request(`http://x/rest/${OP}?f=json`)),
  );
  assertEquals(value.status, 'ok');
  assertEquals(value.openSubsonicExtensions, EXPECTED);
});

Deno.test('H1 regression: authenticated discovery supplies the semantic array', async () => {
  const core = await pathfinder({ roots: ['core/'], app: {} });
  const layers = await loadLayers({
    app: {
      state: { declare() {} },
      cfg: {},
      user: {
        auth: () =>
          Promise.resolve({ username: 'fixture', displayName: 'Fixture' }),
      },
    },
  });
  const app = facade(core, layers);
  const value = await body(
    await app(
      new Request(
        `http://x/rest/${OP}?u=fixture&p=test&v=1.16.1&c=H1&f=json`,
      ),
    ),
  );
  assertEquals(value.status, 'ok');
  assertEquals(value.openSubsonicExtensions, EXPECTED);
});

Deno.test('H1 discovery GET/POST plain/view/force paths and JSON/XML', async () => {
  const { app } = await router();
  for (const prefix of ['/rest/', '/_opensubsonic/rest/', '/_opensubsonic/']) {
    for (const suffix of ['', '.view']) {
      for (const method of ['GET', 'POST']) {
        for (const format of ['json', 'xml']) {
          // Invalid supplied credentials do not privatize discovery. Form f
          // wins over query f, proving params are parsed before the exception.
          const p = new URLSearchParams({ f: format, u: 'wrong', p: 'wrong' });
          const res = await app(
            new Request(
              `http://x${prefix}${OP}${suffix}?${
                method === 'GET' ? p : 'f=xml'
              }`,
              method === 'POST'
                ? {
                  method,
                  body: p,
                  headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                  },
                }
                : { method },
            ),
          );
          assertEquals(res.status, 200);
          if (format === 'json') {
            const value = await body(res);
            assertEquals(value.status, 'ok');
            assertEquals(value.openSubsonicExtensions, EXPECTED);
            assertEquals(Object.keys(value).sort(), [
              'openSubsonic',
              'openSubsonicExtensions',
              'serverVersion',
              'status',
              'type',
              'version',
            ]);
          } else {
            assert(
              res.headers.get('content-type')?.startsWith('application/xml'),
            );
            const xml = await res.text();
            assert(
              xml.includes('xmlns="http://subsonic.org/restapi" status="ok"'),
            );
            assert(
              xml.includes(
                '<openSubsonicExtensions name="formPost"><versions>1</versions></openSubsonicExtensions>',
              ),
            );
            assert(!xml.includes('<openSubsonicExtension>'));
            assert(!xml.includes('<version>'));
          }
        }
      }
    }
  }
});

Deno.test('H1 public exception never leaks to forged routes, methods or exclusive binds', async () => {
  const { app, core, layers } = await router();
  for (
    const path of [
      `/rest/${OP}XYZ`,
      `/rest/${OP}.json`,
      `/rest/${OP}.viewXYZ`,
      `/rest/${OP}/getMusicFolders`,
      `/rest/${OP}.view/getMusicFolders`,
      `/rest/${OP}/`,
      `/rest/${OP}.view/`,
      `/rest/${OP.toLowerCase()}`,
      `/rest/not${OP}`,
      `/restping/${OP}`,
      '/rest/getMusicFolders',
      '/rest/ping.view',
    ]
  ) {
    const res = await app(new Request(`http://x${path}?f=json`));
    const value = await res.json();
    assert(value['subsonic-response']?.status !== 'ok', path);
    assertEquals(value['subsonic-response']?.openSubsonicExtensions, undefined);
  }
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const res = await app(
      new Request(`http://x/rest/${OP}?f=json`, { method }),
    );
    assert((await res.json())['subsonic-response']?.status !== 'ok', method);
  }
  const exclusive = facade(core, layers, {
    listenPort: 14689,
    defaultPort: 14138,
    env: { MELOFON_LISTEN_owntone: '14689,14688' },
  });
  for (const method of ['GET', 'POST']) {
    for (const path of [`/rest/${OP}`, `/_opensubsonic/rest/${OP}.view`]) {
      const res = await exclusive(
        new Request(`http://x${path}?f=json`, { method }),
      );
      assertEquals(res.status, 404);
      assertEquals((await res.json())['subsonic-response'], undefined);
    }
  }
  const bad = await body(
    await app(
      new Request(
        'http://x/rest/getMusicFolders?u=wrong&p=wrong&v=1.16.1&c=H1&f=json',
      ),
    ),
  );
  assertEquals(bad.status, 'failed');
  assertEquals(bad.error.code, 40);
});

Deno.test('H1 encoded form credentials, scalar precedence and repeated IDs reach canonical consumers', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-capabilities-' });
  const store = await openStore(dir);
  const db = store;
  try {
    const cfg = {
      listen: undefined,
      dataDir: dir,
      user: AUTH.get('u')!,
      password: AUTH.get('p')!,
      secret: 'H1-test-secret',
    };
    await seedFirstUser(store, cfg);
    const libraries = createLibraries(store);
    await libraries.add('Fixture', 'tests/fixtures/library');
    await scanLibrary(store);
    const library = createLibrary(store);
    const annotation = createAnnotation(store);
    const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
    const app = facade(
      core,
      await loadLayers({
        app: {
          state: createState(store),
          cfg,
          libraries,
          library,
          annotation,
          listens: createListens(store),
          user: createUserService(store, cfg),
        },
      }),
    );
    const songs = await library.randomSongs(3);
    assertEquals(songs.length, 3);
    const p = new URLSearchParams(AUTH);
    for (const song of songs.slice(0, 2)) p.append('id', song.id);
    const res = await app(
      new Request(
        `http://x/rest/star.view?u=wrong&p=wrong&f=xml&id=${songs[2].id}`,
        { method: 'POST', body: p },
      ),
    );
    assertEquals((await body(res)).status, 'ok');
    const readback = await body(
      await app(new Request(`http://x/rest/getStarred2?${AUTH}`)),
    );
    assertEquals(
      readback.starred2.song.map((s: { id: string }) => s.id).sort(),
      songs.map((s) => s.id).sort(),
    );
    assertEquals(
      (await annotation.starred(cfg.user)).map((s) => s.targetId).sort(),
      songs.map((s) => s.id).sort(),
    );
    const rating = new URLSearchParams(AUTH);
    rating.set('id', songs[0].id);
    rating.set('rating', '4');
    assertEquals(
      (await body(
        await app(
          new Request(
            `http://x/rest/setRating?rating=1`,
            { method: 'POST', body: rating },
          ),
        ),
      )).status,
      'ok',
    );
    const rows = await rawSql(db).all('SELECT rating FROM ratings');
    assertEquals(Number(rows[0].rating), 4);
    const userQuery = new URLSearchParams({ username: cfg.user });
    const user = await body(
      await app(
        new Request(`http://x/rest/getUser?${userQuery}`, {
          method: 'POST',
          body: AUTH,
        }),
      ),
    );
    assertEquals(user.user.username, cfg.user);
  } finally {
    await db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('H1 all existing POST operations reexport their corresponding GET consumer', async () => {
  let count = 0;
  async function visit(dir: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) await visit(path);
      else if (entry.name === 'post.ts') {
        const code = (await Deno.readTextFile(path)).split('\n').filter((
          line,
        ) => !line.startsWith('//')).join('\n').trim();
        assertEquals(code, "export { default } from './get.ts';", path);
        assert((await Deno.stat(`${dir}/get.ts`)).isFile);
        count++;
      }
    }
  }
  await visit('layers/opensubsonic/rest');
  assertEquals(count, 74);
});

Deno.test('H1 semantic projection preserves repeated extensions and versions without changing advertised facts', async () => {
  const facts = [
    { name: 'fixture & one', versions: [1, 2] },
    { name: 'fixture two', versions: [3] },
  ];
  const projection = capabilityPayload(facts);
  const context = {
    app: { cfg: {} },
    state: { params: new URLSearchParams() },
  } as HatContext;
  const xml = await ok(context, projection).text();
  assert(
    xml.includes(
      '<openSubsonicExtensions name="fixture &amp; one"><versions>1</versions><versions>2</versions></openSubsonicExtensions>',
    ),
  );
  assert(
    xml.includes(
      '<openSubsonicExtensions name="fixture two"><versions>3</versions></openSubsonicExtensions>',
    ),
  );
  context.state.params!.set('f', 'json');
  assertEquals(
    (await body(ok(context, projection))).openSubsonicExtensions,
    facts,
  );
  projection.openSubsonicExtensions[0].versions.push(9);
  assertEquals(facts[0].versions, [1, 2]);
  const runtimeProjection = capabilityPayload();
  runtimeProjection.openSubsonicExtensions[0].versions.push(9);
  assertEquals(capabilityPayload().openSubsonicExtensions, EXPECTED);
  assert(Object.isFrozen(CAPABILITIES));
  assert(Object.isFrozen(CAPABILITIES[0]));
  assert(Object.isFrozen(CAPABILITIES[0].versions));
});
