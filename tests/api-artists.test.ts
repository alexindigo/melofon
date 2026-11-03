import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { apiFixture, error } from './helpers/api.ts';
import { tagged } from './helpers/tagged.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { scanLibrary } from '../src/scan.ts';

const base = '/api/v1/artists';

async function artistFixture() {
  const root = await Deno.makeTempDir({ prefix: 'melofon-api-artists-' });
  try {
    const f = await apiFixture({
      services: async (f) => {
        const libraries = createLibraries(f.store, { notify: f.notify });
        for (const name of ['Music', 'Second', 'Empty']) {
          await Deno.mkdir(`${root}/${name}`);
          await libraries.add(name, `${root}/${name}`);
        }
        const tracks: [string, Record<string, string>][] = [
          ['Music/Beta1/a.mp3', {
            TALB: 'Same',
            TPE2: 'Beta',
            TPE1: 'Performer',
          }],
          ['Music/Beta1/b.mp3', { TALB: 'Same', TPE2: 'Beta', TPE1: 'Beta' }],
          ['Music/Beta2/a.mp3', { TALB: 'Same', TPE1: 'Beta' }],
          ['Second/Beta3/a.mp3', { TALB: 'Same', TPE1: 'Beta' }],
          ['Music/Alpha/a.mp3', { TALB: 'First', TPE1: 'Alpha' }],
          ['Second/RealVA/a.mp3', {
            TALB: 'Tagged',
            TPE2: 'Various Artists',
            TPE1: 'Guest',
          }],
          ['Music/Various1/a.mp3', { TALB: 'Mix', TPE1: 'One' }],
          ['Music/Various1/b.mp3', { TALB: 'Mix', TPE1: 'Two' }],
          ['Second/Various2/a.mp3', { TALB: 'Mix', TPE1: 'One' }],
          ['Second/Various2/b.mp3', { TALB: 'Mix', TPE1: 'Two' }],
          ['Music/Unknown/no_title.mp3', {}],
        ];
        for (const [path, tags] of tracks) {
          await Deno.mkdir(`${root}/${path.slice(0, path.lastIndexOf('/'))}`, {
            recursive: true,
          });
          await tagged(`${root}/${path}`, tags);
        }
        await scanLibrary(f.store);
        return { libraries, library: createLibrary(f.store) };
      },
    });
    await f.auth.users.create(f.admin.id, {
      username: 'listener',
      password: 'password-listener',
      role: 'user',
    });
    const libraries = await f.store.catalog.listLibraries();
    const artists = await f.store.catalog.listArtists();
    const songs = await f.store.catalog.listSongs({ offset: 0, size: 100 });
    return {
      ...f,
      root,
      libraries,
      artists,
      songs,
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

type Fixture = Awaited<ReturnType<typeof artistFixture>>;
async function read(f: Fixture, credential: string, path = base) {
  const response = await f.get(path, credential, {
    Origin: 'http://foreign.home',
  });
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json();
}
function ids(rows: { id: string }[]) {
  return rows.map((row) => row.id);
}

Deno.test('API artists: album-artist root pages include each present factual placeholder exactly once', async () => {
  const f = await artistFixture();
  try {
    const expected = [...f.artists.map((a) => a.id), 'unknown', 'various'];
    assertEquals(f.artists.map((a) => a.name), [
      'Alpha',
      'Beta',
      'Various Artists',
    ]);
    let common;
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      const all = await read(f, credential);
      assertEquals(Object.keys(all).sort(), [
        'artists',
        'limit',
        'offset',
        'total',
      ]);
      assertEquals(all.total, 5);
      assertEquals(all.limit, 50);
      assertEquals(all.offset, 0);
      assertEquals(ids(all.artists), expected);
      const rows = [];
      for (let offset = 0; offset <= 5; offset++) {
        const page = await read(
          f,
          credential,
          `${base}?limit=1&offset=${offset}`,
        );
        assertEquals(page.total, 5);
        assertEquals(page.offset, offset);
        assertEquals(page.limit, 1);
        assertEquals(ids(page.artists), expected.slice(offset, offset + 1));
        rows.push(...page.artists);
      }
      assertEquals(rows, all.artists);
      assertEquals(await read(f, credential, `${base}?offset=100`), {
        artists: [],
        total: 5,
        offset: 100,
        limit: 50,
      });
      for (const artist of all.artists) {
        assertEquals(
          (await read(f, credential, `${base}/${artist.id}`)).artist,
          artist,
        );
        assertEquals(Object.keys(artist).sort(), [
          'albumCount',
          'artwork',
          'id',
          'kind',
          'label',
          'musicBrainzId',
          'name',
          'sortName',
        ]);
      }
      const tagged = all.artists.find((a: { name: string }) =>
        a.name === 'Various Artists'
      );
      assertEquals(tagged.kind, 'artist');
      assertEquals(tagged.label, 'Various Artists');
      assertEquals(tagged.albumCount, 1);
      assertNotEquals(tagged.id, 'various');
      assertEquals(
        all.artists.find((a: { id: string }) => a.id === 'various'),
        {
          id: 'various',
          kind: 'various',
          name: null,
          label: '[Various Artists]',
          musicBrainzId: null,
          sortName: null,
          albumCount: 2,
          artwork: null,
        },
      );
      assertEquals(
        all.artists.find((a: { id: string }) => a.id === 'unknown'),
        {
          id: 'unknown',
          kind: 'unknown',
          name: null,
          label: '[Unknown Artist]',
          musicBrainzId: null,
          sortName: null,
          albumCount: 1,
          artwork: null,
        },
      );
      assert(!JSON.stringify(all).includes(f.root));
      if (common) assertEquals(all, common);
      common = all;
    }
    assertEquals(await read(f, (await f.login('bearer')).credential), common);
    assert(f.peers.every((p) => p !== '127.0.0.1' && p !== '::1'));
  } finally {
    await f.close();
  }
});

Deno.test('API artists: library-scoped counts equal bounded album memberships and opened albums', async () => {
  const f = await artistFixture();
  try {
    const beta = f.artists.find((a) => a.name === 'Beta')!;
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      for (const library of [undefined, ...f.libraries]) {
        const query = library ? `?library=${library.id}` : '';
        const all = await read(f, credential, base + query);
        const name = library?.name ?? 'All';
        assertEquals(
          all.total,
          { All: 5, Music: 4, Second: 3, Empty: 0 }[name],
        );
        for (const artist of all.artists) {
          const detail = await read(
            f,
            credential,
            `${base}/${artist.id}${query}`,
          );
          assertEquals(detail, { artist });
          if (artist.id === beta.id) {
            assertEquals(
              artist.albumCount,
              name === 'All' ? 3 : name === 'Music' ? 2 : 1,
            );
          }
          const path = `${base}/${artist.id}/albums${query}`;
          const albums = await read(f, credential, path);
          assertEquals(albums.total, artist.albumCount);
          assertEquals(albums.albums.length, artist.albumCount);
          const expected = [...albums.albums].sort((a, b) =>
            a.id < b.id ? -1 : 1
          );
          // Every artist's fixture albums have duplicate names; IDs break ties.
          assertEquals(ids(albums.albums), ids(expected));
          for (let offset = 0; offset <= artist.albumCount; offset++) {
            const page = await read(
              f,
              credential,
              `${path}${query ? '&' : '?'}offset=${offset}&limit=1`,
            );
            assertEquals(page.total, artist.albumCount);
            assertEquals(page.albums, albums.albums.slice(offset, offset + 1));
          }
          for (const album of albums.albums) {
            const opened = await read(
              f,
              credential,
              `/api/v1/albums/${album.id}${query}`,
            );
            const { songs, ...summary } = opened.album;
            assertEquals(summary, album);
            assertEquals(songs.length, album.songCount);
            if (library) {
              assert(
                songs.every((s: { libraryId: string }) =>
                  s.libraryId === library.id
                ),
              );
            }
            assertEquals(
              album.artistId,
              artist.kind === 'artist' ? artist.id : null,
            );
            if (artist.kind !== 'artist') {
              assertEquals(album.artistKind, artist.kind);
            }
          }
        }
        if (name === 'Second' || name === 'Empty') {
          for (const suffix of ['', '/albums']) {
            await error(
              await f.get(`${base}/unknown${suffix}${query}`, credential),
              404,
              'not_found',
            );
          }
        }
      }
    }
  } finally {
    await f.close();
  }
});

Deno.test('API artists: track-only performers are reached from songs and album details but absent from root', async () => {
  const f = await artistFixture();
  try {
    const second = f.libraries.find((l) => l.name === 'Second')!;
    const music = f.libraries.find((l) => l.name === 'Music')!;
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      const root = await read(f, credential);
      for (const name of ['Performer', 'Guest', 'One', 'Two']) {
        const song = f.songs.find((s) => s.artistName === name)!;
        const songDto =
          (await read(f, credential, `/api/v1/songs/${song.id}`)).song;
        assertEquals(songDto.artistName, name);
        assert(!ids(root.artists).includes(songDto.artistId));
        const album =
          (await read(f, credential, `/api/v1/albums/${songDto.albumId}`))
            .album;
        assert(
          album.songs.some((s: { artistId: string }) =>
            s.artistId === songDto.artistId
          ),
        );
        const path = `${base}/${songDto.artistId}`;
        const detail = (await read(f, credential, path)).artist;
        assertEquals(detail.name, name);
        assertEquals(detail.label, name);
        assertEquals(detail.kind, 'artist');
        assertEquals(detail.albumCount, 0);
        assertEquals(await read(f, credential, `${path}/albums?offset=20`), {
          albums: [],
          total: 0,
          offset: 20,
          limit: 50,
        });
        assertEquals(
          (await read(f, credential, `${path}?library=${song.libraryId}`))
            .artist,
          detail,
        );
        if (name === 'Performer' || name === 'Guest') {
          const wrong = name === 'Performer' ? second : music;
          for (const suffix of ['', '/albums']) {
            await error(
              await f.get(`${path}${suffix}?library=${wrong.id}`, credential),
              404,
              'not_found',
            );
          }
        }
      }
    }
  } finally {
    await f.close();
  }
});

Deno.test('API artists: canonical resource/query validators revalidate all memberships after library removal', async () => {
  const f = await artistFixture();
  try {
    const beta = f.artists.find((a) => a.name === 'Beta')!;
    const music = f.libraries.find((l) => l.name === 'Music')!;
    const paths = [
      base,
      `${base}?limit=1`,
      `${base}?offset=1`,
      `${base}?library=${music.id}`,
      `${base}/${beta.id}`,
      `${base}/${beta.id}?library=${music.id}`,
      `${base}/${beta.id}/albums`,
      `${base}/${beta.id}/albums?limit=1`,
      `${base}/various`,
      `${base}/unknown`,
    ];
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      const validators = new Set();
      for (const path of paths) {
        const response = await f.get(path, credential);
        assertEquals(response.status, 200);
        const etag = response.headers.get('etag')!;
        assert(etag.startsWith('W/"'));
        assertEquals(
          response.headers.get('cache-control'),
          'private, no-cache',
        );
        validators.add(etag);
        await response.json();
        const cached = await f.get(path, credential, {
          'If-None-Match': etag,
          Origin: 'http://foreign.home',
        });
        assertEquals(cached.status, 304);
        assertEquals(await cached.text(), '');
        assertEquals(cached.headers.get('etag'), etag);
        assertEquals(cached.headers.get('cache-control'), 'private, no-cache');
      }
      assertEquals(validators.size, paths.length);
      for (const path of [base, `${base}/${beta.id}/albums`]) {
        const normal = await f.get(path, credential);
        const etag = normal.headers.get('etag')!;
        await normal.json();
        const canonical = await f.get(
          `${path}?sort=name&limit=050&offset=00`,
          credential,
          { 'If-None-Match': etag },
        );
        assertEquals(canonical.status, 304);
        await canonical.text();
        await error(
          await f.get(path, undefined, { 'If-None-Match': etag }),
          401,
          'unauthenticated',
        );
      }
    }
    const { credential } = await f.login(
      'bearer',
      'listener',
      'password-listener',
    );
    const retained = new Map<string, string>();
    for (
      const path of [
        base,
        `${base}/${beta.id}`,
        `${base}/${beta.id}/albums`,
        `${base}/various`,
        `${base}/various/albums`,
        `${base}/unknown`,
      ]
    ) {
      const response = await f.get(path, credential);
      retained.set(path, response.headers.get('etag')!);
      await response.json();
    }
    const admin = await f.login('bearer');
    const removed = await f.json(
      `/api/v1/admin/libraries/${music.id}`,
      'DELETE',
      undefined,
      admin.credential,
    );
    assertEquals(removed.status, 204);
    await removed.text();
    for (const [path, etag] of retained) {
      const response = await f.get(path, credential, { 'If-None-Match': etag });
      if (path.endsWith('/unknown')) {
        await error(response, 404, 'not_found');
        continue;
      }
      assertEquals(response.status, 200);
      assertNotEquals(response.headers.get('etag'), etag);
      const body = await response.json();
      if (body.artist) assertEquals(body.artist.albumCount, 1);
      if (body.albums) assertEquals(body.total, 1);
      if (body.artists) assertEquals(body.total, 3);
    }
  } finally {
    await f.close();
  }
});

Deno.test('API artists: strict queries, absent scopes/resources, auth precedence and shared page settings', async () => {
  const f = await artistFixture();
  try {
    const beta = f.artists.find((a) => a.name === 'Beta')!;
    const paths = [base, `${base}/${beta.id}`, `${base}/${beta.id}/albums`];
    const cookie =
      (await f.login('cookie', 'listener', 'password-listener')).credential;
    for (const path of paths) {
      await error(await f.get(path), 401, 'unauthenticated');
      await error(
        await f.get(path, cookie, {
          Authorization: 'Bearer invalid',
          'If-None-Match': '*',
        }),
        401,
        'unauthenticated',
      );
    }
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      for (const path of paths) {
        for (
          const query of ['?unknown=1', '?library=', '?library=a&library=b']
        ) {
          await error(
            await f.get(path + query, credential, { 'If-None-Match': '*' }),
            400,
            'invalid_field',
          );
        }
        await error(
          await f.get(`${path}?library=missing`, credential, {
            'If-None-Match': '*',
          }),
          404,
          'not_found',
        );
        const unsupported = await f.json(path, 'POST', {}, credential);
        await error(unsupported, 405, 'method_not_allowed');
        assertEquals(unsupported.headers.get('allow'), 'GET');
      }
      for (const path of [base, `${base}/${beta.id}/albums`]) {
        for (
          const query of [
            '?limit=0',
            '?limit=501',
            '?limit=',
            '?limit=1e2',
            '?limit=1&limit=2',
            '?offset=-1',
            '?offset=1.5',
            '?offset=9007199254740992',
            '?sort=',
            '?sort=year',
            '?sort=name&sort=name',
            '?genre=Jazz',
          ]
        ) {
          await error(
            await f.get(path + query, credential, { 'If-None-Match': '*' }),
            400,
            'invalid_field',
          );
        }
      }
      await error(
        await f.get(`${base}/${beta.id}?limit=1`, credential),
        400,
        'invalid_field',
      );
      for (const suffix of ['', '/albums']) {
        await error(
          await f.get(`${base}/missing${suffix}`, credential, {
            'If-None-Match': '*',
          }),
          404,
          'not_found',
        );
      }
    }
    await f.state.set('melofon.browseMaxPageRecords', '2');
    await f.state.set('melofon.browsePageRecords', '3');
    for (const path of [base, `${base}/${beta.id}/albums`]) {
      const body = await read(f, cookie, path);
      assertEquals(body.limit, 2);
      assertEquals((body.artists ?? body.albums).length, 2);
      await error(await f.get(`${path}?limit=3`, cookie), 400, 'invalid_field');
    }
  } finally {
    await f.close();
  }
});

Deno.test('API artists: empty catalogs have no placeholders and legacy artist reads retain their shape', async () => {
  const empty = await apiFixture({
    services: (f) => Promise.resolve({ library: createLibrary(f.store) }),
  });
  try {
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await empty.login(use);
      const response = await empty.get(
        `${base}?offset=100&limit=2`,
        credential,
      );
      assertEquals(response.status, 200);
      assertEquals(await response.json(), {
        artists: [],
        total: 0,
        offset: 100,
        limit: 2,
      });
      for (const id of ['various', 'unknown']) {
        for (const suffix of ['', '/albums']) {
          await error(
            await empty.get(`${base}/${id}${suffix}`, credential),
            404,
            'not_found',
          );
        }
      }
    }
  } finally {
    await empty.close();
  }
  const f = await artistFixture();
  try {
    const library = createLibrary(f.store);
    assertEquals(await library.listArtists(), f.artists);
    for (const artist of f.artists) {
      assertEquals(
        await library.getArtist(artist.id),
        await library.artistById(artist.id),
      );
      assertEquals(
        (await library.albumsByArtist(artist.id)).length,
        artist.albumCount,
      );
    }
    const performer = f.songs.find((s) => s.artistName === 'Performer')!;
    assertEquals(await library.getArtist(performer.artistId!), null);
    assertEquals(
      (await library.artistById(performer.artistId!))?.albumCount,
      0,
    );
  } finally {
    await f.close();
  }
});
