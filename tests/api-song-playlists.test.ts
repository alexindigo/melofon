import { assert, assertEquals } from '@std/assert';
import { apiFixture, error } from './helpers/api.ts';
import { tagged } from './helpers/tagged.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createPlaylists, type PlaylistRow } from '../src/playlists.ts';
import { createUserService } from '../src/user.ts';
import { scanLibrary } from '../src/scan.ts';

const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
const endpoint = (songId: string) => `/api/v1/songs/${songId}/playlists`;

async function fixture() {
  const root = await Deno.makeTempDir({ prefix: 'melofon-song-playlists-' });
  try {
    const f = await apiFixture({
      allLayers: true,
      services: async (f) => {
        const libraries = createLibraries(f.store);
        await libraries.add('Music', root);
        await tagged(`${root}/one.mp3`, { TIT2: 'One' });
        await tagged(`${root}/two.mp3`, { TIT2: 'Two' });
        await scanLibrary(f.store);
        return {
          library: createLibrary(f.store),
          playlists: createPlaylists(f.store),
          user: createUserService(f.store, f.cfg),
        };
      },
    });
    for (const username of ['alice', 'bob']) {
      await f.auth.users.create(f.admin.id, {
        username,
        password: `password-${username}`,
        role: 'user',
      });
    }
    const library = createLibrary(f.store);
    const songs = await library.listSongs({ offset: 0, size: 100 });
    const one = songs.find((row) => row.title === 'One')!;
    const two = songs.find((row) => row.title === 'Two')!;
    assert(one && two);
    const playlists = createPlaylists(f.store);
    const own = await playlists.create('alice', 'alpha', [
      one.id,
      one.id,
      'missing',
    ]);
    await playlists.update('alice', own.id, { comment: 'Kept comment' });
    const publicOne = await playlists.create(
      'bob',
      'élan',
      [one.id, two.id],
      true,
    );
    const publicTwo = await playlists.create('admin', 'ELAN', [one.id], true);
    const privateOther = await playlists.create('bob', 'Secret', [one.id]);
    const privateAdmin = await playlists.create('admin', 'Zulu', [one.id]);
    const unrelated = await playlists.create('alice', 'Not a member', [
      two.id,
      'missing',
    ]);
    const orphan = await playlists.create('alice', 'Only missing', ['missing']);
    const empty = await playlists.create('alice', 'Empty', []);
    const tied = [publicOne, publicTwo].sort((a, b) => a.id < b.id ? -1 : 1);
    return {
      ...f,
      root,
      library,
      playlists,
      one,
      two,
      own,
      publicOne,
      publicTwo,
      privateOther,
      privateAdmin,
      unrelated,
      orphan,
      empty,
      tied,
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

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function read(
  f: Fixture,
  credential: string,
  query = '',
  songId = f.one.id,
  condition = '*',
) {
  const response = await f.get(`${endpoint(songId)}${query}`, credential, {
    Origin: 'http://foreign.home',
    'If-None-Match': condition,
  });
  assertEquals(response.status, 200, await response.clone().text());
  assertEquals(response.headers.get('cache-control'), 'private, no-store');
  assertEquals(response.headers.get('etag'), null);
  const body = await response.json() as {
    playlists: (PlaylistRow & { artwork: null })[];
    total: number;
    offset: number;
    limit: number;
  };
  assertEquals(Object.keys(body).sort(), [
    'limit',
    'offset',
    'playlists',
    'total',
  ]);
  return body;
}

async function restVisible(f: Fixture, username: string) {
  const response = await f.get(
    `/rest/getPlaylists?u=${username}&p=password-${username}&v=1.16.1&c=a12&f=json`,
  );
  const body = (await response.json())['subsonic-response'];
  assertEquals(body.status, 'ok');
  return body.playlists.playlist as PlaylistRow[];
}

Deno.test('API song playlists: core own/public/admin visibility agrees with the existing hat', async () => {
  const f = await fixture();
  try {
    const expected = {
      alice: [f.own, ...f.tied],
      bob: [...f.tied, f.privateOther],
      admin: [f.own, ...f.tied, f.privateOther, f.privateAdmin],
    };
    for (const use of ['cookie', 'bearer'] as const) {
      for (const username of ['alice', 'bob', 'admin'] as const) {
        const { credential } = await f.login(
          use,
          username,
          `password-${username}`,
        );
        const body = await read(f, credential);
        assertEquals(ids(body.playlists), ids(expected[username]));
        assertEquals(body.total, expected[username].length);
        assertEquals([body.offset, body.limit], [0, 50]);
        const visible = await f.playlists.visible(username);
        assert(Array.isArray(visible));
        const legacy = await restVisible(f, username);
        for (const row of body.playlists) {
          assert(visible.some((p) => p.id === row.id));
          assert(legacy.some((p) => p.id === row.id));
          const detail = await f.playlists.get(username, row.id);
          assert(detail);
          const { trackIds: _tracks, ...summary } = detail;
          assertEquals(row, { ...summary, artwork: null });
          assertEquals(Object.keys(row).sort(), [
            'artwork',
            'changedAtMs',
            'comment',
            'createdAtMs',
            'durationMs',
            'id',
            'name',
            'owner',
            'public',
            'songCount',
          ]);
        }
        const own = body.playlists.find((p) => p.id === f.own.id);
        if (own) {
          assertEquals(own.songCount, 2);
          assertEquals(own.durationMs, 2 * (f.one.durationMs ?? 0));
          assertEquals(own.comment, 'Kept comment');
        }
        assert(!JSON.stringify(body).includes(f.root));
      }
    }
    assert(
      f.peers.length > 0 && f.peers.every((peer) => !peer.startsWith('127.')),
    );
  } finally {
    await f.close();
  }
});

Deno.test('API song playlists: folded name/id pages partition membership with exact past-end totals', async () => {
  const f = await fixture();
  try {
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(use, 'alice', 'password-alice');
      const expected = ids([f.own, ...f.tied]);
      const actual: string[] = [];
      for (let offset = 0; offset < expected.length; offset++) {
        const page = await read(
          f,
          credential,
          `?sort=name&offset=${offset}&limit=1`,
        );
        assertEquals([page.total, page.offset, page.limit], [3, offset, 1]);
        assertEquals(ids(page.playlists), [expected[offset]]);
        actual.push(...ids(page.playlists));
      }
      assertEquals(actual, expected);
      const beyond = await read(f, credential, '?offset=999&limit=2');
      assertEquals(beyond, { playlists: [], total: 3, offset: 999, limit: 2 });
      await f.playlists.setTracks('alice', f.own.id, [f.two.id]);
      await f.playlists.setTracks('bob', f.publicOne.id, [f.two.id]);
      await f.playlists.setTracks('admin', f.publicTwo.id, [f.two.id]);
      const none = await read(f, credential, '?offset=7&limit=1');
      assertEquals(none, { playlists: [], total: 0, offset: 7, limit: 1 });
      await f.playlists.setTracks('alice', f.own.id, [
        f.one.id,
        f.one.id,
        'missing',
      ]);
      await f.playlists.setTracks('bob', f.publicOne.id, [f.one.id, f.two.id]);
      await f.playlists.setTracks('admin', f.publicTwo.id, [f.one.id]);
    }
    // Unoptioned core paging preserves the legacy binary name default.
    const core = await f.playlists.containingSong('admin', f.one.id, {
      offset: 0,
      limit: 100,
    });
    assert(core);
    assertEquals(core.rows.map((p) => p.name), [
      'ELAN',
      'Secret',
      'Zulu',
      'alpha',
      'élan',
    ]);
  } finally {
    await f.close();
  }
});

Deno.test('API song playlists: visibility and occurrence edits are fresh even with conditional requests', async () => {
  const f = await fixture();
  try {
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(use, 'alice', 'password-alice');
      const detail = await f.get(`/api/v1/songs/${f.one.id}`, credential);
      const tag = detail.headers.get('etag')!;
      await detail.json();
      assert(tag);
      await read(f, credential, '', f.one.id, tag);
      await f.playlists.update('bob', f.publicOne.id, { public: false });
      assertEquals(ids((await read(f, credential)).playlists), [
        f.own.id,
        f.publicTwo.id,
      ]);
      assert(
        !(await restVisible(f, 'alice')).some((p) => p.id === f.publicOne.id),
      );
      await f.playlists.update('bob', f.privateOther.id, {
        public: true,
        name: 'Beta',
      });
      assertEquals(
        ids((await read(f, credential, '', f.one.id, tag)).playlists),
        [f.own.id, f.privateOther.id, f.publicTwo.id],
      );
      await f.playlists.update('alice', f.own.id, { removeAtPositions: [0] });
      assertEquals((await read(f, credential)).playlists[0].songCount, 1);
      await f.playlists.update('alice', f.own.id, { removeAtPositions: [0] });
      assertEquals(ids((await read(f, credential)).playlists), [
        f.privateOther.id,
        f.publicTwo.id,
      ]);
      await f.playlists.setTracks('alice', f.own.id, [
        f.one.id,
        f.one.id,
        'missing',
      ]);
      await f.playlists.update('bob', f.publicOne.id, { public: true });
      await f.playlists.update('bob', f.privateOther.id, {
        public: false,
        name: 'Secret',
      });
      assertEquals(
        ids((await read(f, credential)).playlists),
        ids([f.own, ...f.tied]),
      );
      const unchanged = await f.get(`/api/v1/songs/${f.one.id}`, credential, {
        'If-None-Match': tag,
      });
      assertEquals(unchanged.status, 304);
      assertEquals(await unchanged.text(), '');
    }
    await f.playlists.delete('bob', f.publicOne.id);
    const alice = await f.login('bearer', 'alice', 'password-alice');
    assertEquals(ids((await read(f, alice.credential)).playlists), [
      f.own.id,
      f.publicTwo.id,
    ]);
  } finally {
    await f.close();
  }
});

Deno.test('API song playlists: auth, strict paging, caller spoofing and missing song errors precede conditions', async () => {
  const f = await fixture();
  try {
    await error(
      await f.get(endpoint(f.one.id), undefined, { 'If-None-Match': '*' }),
      401,
      'unauthenticated',
    );
    const { credential } = await f.login('cookie', 'alice', 'password-alice');
    await error(
      await f.get(endpoint(f.one.id), credential, {
        Authorization: 'Bearer invalid',
      }),
      401,
      'unauthenticated',
    );
    for (
      const query of [
        '?offset=-1',
        '?offset=1.2',
        '?offset=9007199254740992',
        '?offset=',
        '?limit=0',
        '?limit=1001',
        '?limit=1&limit=2',
        '?sort=-name',
        '?sort=name&sort=name',
        '?username=admin',
        '?library=anything',
        '?unknown=1',
      ]
    ) {
      await error(
        await f.get(`${endpoint(f.one.id)}${query}`, credential, {
          'If-None-Match': '*',
        }),
        400,
        'invalid_field',
      );
    }
    for (const use of ['cookie', 'bearer'] as const) {
      const login = await f.login(use, 'alice', 'password-alice');
      await error(
        await f.get(endpoint('missing'), login.credential, {
          'If-None-Match': '*',
        }),
        404,
        'not_found',
      );
    }
    const noMethod = await f.request(endpoint(f.one.id), {
      method: 'POST',
      headers: { Cookie: credential, Origin: f.origin },
    });
    await error(noMethod, 405, 'method_not_allowed');
    assert(noMethod.headers.get('allow')?.includes('GET'));
  } finally {
    await f.close();
  }
});

Deno.test('API song playlists: catalog removal retains occurrences but unknown tracks cannot be browsed', async () => {
  const f = await fixture();
  try {
    const { credential } = await f.login('bearer', 'alice', 'password-alice');
    await Deno.remove(`${f.root}/two.mp3`);
    await scanLibrary(f.store);
    const page = await read(f, credential);
    assertEquals(
      page.playlists.find((p) => p.id === f.publicOne.id)!.songCount,
      1,
    );
    assertEquals(
      page.playlists.find((p) => p.id === f.publicOne.id)!.durationMs,
      f.one.durationMs,
    );
    await error(
      await f.get(endpoint(f.two.id), credential, { 'If-None-Match': '*' }),
      404,
      'not_found',
    );
    await Deno.remove(`${f.root}/one.mp3`);
    await scanLibrary(f.store);
    await error(
      await f.get(endpoint(f.one.id), credential, { 'If-None-Match': '*' }),
      404,
      'not_found',
    );
    const kept = await f.playlists.get('alice', f.own.id);
    assert(kept);
    assertEquals([kept.songCount, kept.durationMs, kept.trackIds], [0, 0, []]);
    // Reappearance resolves the retained duplicate occurrences without rewriting them.
    await tagged(`${f.root}/one.mp3`, { TIT2: 'One' });
    await scanLibrary(f.store);
    assertEquals(
      (await read(f, credential)).playlists.find((p) => p.id === f.own.id)!
        .songCount,
      2,
    );
  } finally {
    await f.close();
  }
});
