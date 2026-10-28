import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from '@std/assert';
import { browseFixture } from './helpers/browse.ts';
import { apiFixture, error } from './helpers/api.ts';
import { tagged } from './helpers/tagged.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createScan } from '../src/scan.ts';
import { createCatalogStore } from '../src/store/catalog.ts';
import { engineForTesting } from '../src/store/engine.ts';

async function cached(response: Response) {
  assertEquals(response.status, 200, await response.clone().text());
  const etag = response.headers.get('etag');
  assert(etag && /^W\/"[0-9a-f]{64}"$/.test(etag));
  assertEquals(response.headers.get('cache-control'), 'private, no-cache');
  return { etag, body: await response.json() };
}

async function notModified(response: Response, etag: string) {
  assertEquals(response.status, 304);
  assertEquals(await response.text(), '');
  assertEquals(response.headers.get('etag'), etag);
  assertEquals(response.headers.get('cache-control'), 'private, no-cache');
}

Deno.test('API browse cache: cookie/Bearer weak validators, lists, wildcard and representation identity', async () => {
  const f = await browseFixture();
  try {
    const paths = [
      '/api/v1/libraries',
      ...f.songs.slice(0, 2).map((s) => `/api/v1/songs/${s.id}`),
    ];
    const tags: string[] = [];
    for (const path of paths) {
      let previous: string | undefined;
      for (const mode of ['cookie', 'bearer'] as const) {
        const { credential } = await f.login(
          mode,
          'listener',
          'password-listener',
        );
        const first = await cached(
          await f.get(path, credential, { Origin: 'http://foreign.home' }),
        );
        if (previous) assertEquals(first.etag, previous);
        previous = first.etag;
        for (
          const condition of [
            first.etag,
            first.etag.slice(2),
            `"other,tag", ${first.etag}`,
            ` W/"other", ${first.etag.slice(2)} `,
            '*',
          ]
        ) {
          await notModified(
            await f.get(path, credential, { 'If-None-Match': condition }),
            first.etag,
          );
        }
        for (
          const condition of [
            '"different"',
            `${first.etag} trailing-junk`,
            'W/unquoted',
            `*, ${first.etag}`,
          ]
        ) {
          const response = await cached(
            await f.get(path, credential, { 'If-None-Match': condition }),
          );
          assertEquals(response, first);
        }
      }
      tags.push(previous!);
    }
    assertEquals(new Set(tags).size, paths.length);
    const admin = await f.login('bearer');
    assertEquals(
      (await cached(await f.get(paths[0], admin.credential))).etag,
      tags[0],
    );
    const cross = await cached(
      await f.get(paths[1], admin.credential, { 'If-None-Match': tags[0] }),
    );
    assertEquals(cross.etag, tags[1]);
  } finally {
    await f.close();
  }
});

Deno.test('API browse cache: conditional reads still authenticate, validate queries and resolve resources', async () => {
  const f = await browseFixture();
  try {
    const { credential } = await f.login(
      'cookie',
      'listener',
      'password-listener',
    );
    const paths = ['/api/v1/libraries', `/api/v1/songs/${f.songs[0].id}`];
    for (const path of paths) {
      const { etag } = await cached(await f.get(path, credential));
      await error(
        await f.get(path, undefined, { 'If-None-Match': etag }),
        401,
        'unauthenticated',
      );
      await error(
        await f.get(path, credential, {
          Authorization: 'Bearer invalid',
          'If-None-Match': '*',
        }),
        401,
        'unauthenticated',
      );
      await error(
        await f.get(`${path}?unknown=1`, credential, { 'If-None-Match': '*' }),
        400,
        'invalid_field',
      );
      await error(
        await f.get('/api/v1/songs/missing', credential, {
          'If-None-Match': '*',
        }),
        404,
        'not_found',
      );
    }
    await f.json('/api/v1/session', 'DELETE', undefined, credential).then((r) =>
      r.body?.cancel()
    );
    await error(
      await f.get(paths[0], credential, { 'If-None-Match': '*' }),
      401,
      'unauthenticated',
    );
  } finally {
    await f.close();
  }
});

Deno.test('API browse cache: scans and source add/edit/path/remove invalidate committed native facts', async () => {
  const f = await browseFixture();
  try {
    const admin = (await f.login('bearer')).credential;
    const listener =
      (await f.login('cookie', 'listener', 'password-listener')).credential;
    const path = '/api/v1/libraries';
    const libraries = createLibraries(f.store, { notify: f.notify });
    const scan = createScan(f.store, undefined, {
      notify: f.notify,
      state: f.state,
    });
    const song = f.songs.find((s) => s.title === 'Tagged Song')!;
    const songPath = `/api/v1/songs/${song.id}`;
    const originalSong = await cached(await f.get(songPath, listener));
    let prior = await cached(await f.get(path, listener));
    const music = prior.body.libraries.find((l: { name: string }) =>
      l.name === 'Music'
    );
    const edit = await f.json(
      `${path.replace('/libraries', '/admin/libraries')}/${music.id}`,
      'PATCH',
      { name: 'Renamed Music' },
      admin,
    );
    assertEquals(edit.status, 200);
    await edit.body?.cancel();
    let next = await cached(
      await f.get(path, listener, { 'If-None-Match': prior.etag }),
    );
    assertNotEquals(next.etag, prior.etag);
    assertEquals(
      next.body.libraries.find((l: { id: string }) => l.id === music.id).name,
      'Renamed Music',
    );
    prior = next;
    await tagged(song.path, {
      TIT2: 'Retagged song',
      TALB: 'Album',
      TPE1: 'Shared Artist',
      TPOS: '1/2',
    });
    // Offline source becomes available as part of the same catalog publication.
    await Deno.mkdir(`${f.root}/Offline`);
    await scan.run({ mode: 'full' });
    const retagged = await cached(
      await f.get(songPath, listener, { 'If-None-Match': originalSong.etag }),
    );
    assertNotEquals(retagged.etag, originalSong.etag);
    assertEquals(retagged.body.song.title, 'Retagged song');
    next = await cached(
      await f.get(path, listener, { 'If-None-Match': prior.etag }),
    );
    assertNotEquals(next.etag, prior.etag);
    assertEquals(
      next.body.libraries.find((l: { name: string }) => l.name === 'Offline')
        .available,
      true,
    );
    prior = next;
    await Deno.mkdir(`${f.root}/Extra`);
    const added = await libraries.add('Extra', `${f.root}/Extra`);
    next = await cached(
      await f.get(path, listener, { 'If-None-Match': prior.etag }),
    );
    assertNotEquals(next.etag, prior.etag);
    assertEquals(next.body.libraries.length, 4);
    // A moved root changes the projected relative song path before another scan.
    const beforeMove = await cached(await f.get(songPath, listener));
    await libraries.update(music.id, { path: `${f.root}/Music/Album` });
    const afterMove = await cached(
      await f.get(songPath, listener, { 'If-None-Match': beforeMove.etag }),
    );
    assertNotEquals(afterMove.etag, beforeMove.etag);
    assertEquals(afterMove.body.song.path, 'CD1/01_Tagged.mp3');
    assertEquals(await libraries.remove(added.id), true);
    prior = await cached(await f.get(path, listener));
    assertEquals(await libraries.remove(music.id), true);
    next = await cached(
      await f.get(path, listener, { 'If-None-Match': prior.etag }),
    );
    assertNotEquals(next.etag, prior.etag);
    assertEquals(next.body.libraries.length, 2);
    await error(
      await f.get(songPath, listener, { 'If-None-Match': afterMove.etag }),
      404,
      'not_found',
    );
  } finally {
    await f.close();
  }
});

Deno.test('API browse cache: failed source commit preserves validator and publishes no library invalidation', async () => {
  let fail = false;
  let libraries!: ReturnType<typeof createLibraries>;
  const root = await Deno.makeTempDir({ prefix: 'melofon-cache-rollback-' });
  const f = await apiFixture({
    services: async (f) => {
      const engine = engineForTesting(f.store);
      const catalog = createCatalogStore({
        ...engine,
        exclusive: (fn) =>
          engine.exclusive((q) =>
            fn({
              ...q,
              run(sql) {
                if (sql === 'COMMIT' && fail) {
                  fail = false;
                  throw new Error('injected commit failure');
                }
                return q.run(sql);
              },
            })
          ),
      });
      libraries = createLibraries({ ...f.store, catalog }, {
        notify: f.notify,
      });
      await libraries.add('Music', root);
      return { libraries, library: createLibrary(f.store) };
    },
  });
  try {
    const { credential } = await f.login('bearer');
    const first = await cached(await f.get('/api/v1/libraries', credential));
    const events: string[][] = [];
    const stop = f.notify.subscribe((types) => events.push(types));
    try {
      fail = true;
      await assertRejects(
        () =>
          libraries.update(first.body.libraries[0].id, {
            name: 'Not committed',
          }),
        Error,
        'injected commit failure',
      );
      assertEquals(events, []);
      await notModified(
        await f.get('/api/v1/libraries', credential, {
          'If-None-Match': first.etag,
        }),
        first.etag,
      );
      assertEquals(
        (await cached(await f.get('/api/v1/libraries', credential))).body,
        first.body,
      );
    } finally {
      stop();
    }
  } finally {
    await f.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('API browse cache: failed scan publication keeps the last detail and revision without library event', async () => {
  const f = await browseFixture();
  try {
    const { credential } = await f.login(
      'bearer',
      'listener',
      'password-listener',
    );
    const song = f.songs.find((s) => s.title === 'Tagged Song')!;
    const path = `/api/v1/songs/${song.id}`;
    const first = await cached(await f.get(path, credential));
    const engine = engineForTesting(f.store);
    let fail = true;
    const catalog = createCatalogStore({
      ...engine,
      exclusive: (fn) =>
        engine.exclusive((q) =>
          fn({
            ...q,
            run(sql) {
              if (sql === 'COMMIT' && fail) {
                fail = false;
                throw new Error('injected scan commit failure');
              }
              return q.run(sql);
            },
          })
        ),
    });
    const scan = createScan({ ...f.store, catalog }, undefined, {
      notify: f.notify,
      state: f.state,
    });
    await tagged(song.path, {
      TIT2: 'Never published',
      TALB: 'Album',
      TPE1: 'Shared Artist',
      TPOS: '1/2',
    });
    const events: string[][] = [];
    const stop = f.notify.subscribe((types) => events.push(types));
    try {
      await assertRejects(
        () => scan.run({ mode: 'full' }),
        Error,
        'injected scan commit failure',
      );
      assert(
        !events.some((types) =>
          types.includes('library') || types.includes('database')
        ),
      );
      assert(events.some((types) => types.includes('update')));
      await notModified(
        await f.get(path, credential, { 'If-None-Match': first.etag }),
        first.etag,
      );
      assertEquals(
        (await cached(await f.get(path, credential))).body,
        first.body,
      );
    } finally {
      stop();
    }
  } finally {
    await f.close();
  }
});
