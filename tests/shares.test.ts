import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore, type Store } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { encryptPassword, seedFirstUser } from '../src/users.ts';
import { createUserService } from '../src/user.ts';
import { createLibraries } from '../src/libraries.ts';
import { createScan } from '../src/scan.ts';
import { createLibrary } from '../src/library.ts';
import { createState } from '../src/state.ts';
import { createPlaylists } from '../src/playlists.ts';
import { createShares } from '../src/shares.ts';
import { createPublicAddress } from '../src/public-address.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { loadLayers } from '../src/layers.ts';
import { facade } from '../src/facade.ts';

const config = (dataDir: string) => ({
  dataDir,
  user: 'admin',
  password: 'test',
  secret: 'shares-secret',
  listen: undefined,
  version: 'shares-test',
});
interface WireShare {
  id: string;
  url: string;
  description: string;
  username: string;
  created: string;
  expires?: string;
  lastVisited?: string;
  visitCount: number;
  entry: { id: string; title: string; isDir: boolean }[];
}
async function api(store: Store, dir: string) {
  const cfg = config(dir),
    state = createState(store),
    library = createLibrary(store);
  const playlists = createPlaylists(store),
    shares = createShares(store, state, library, playlists);
  const libraries = createLibraries(store);
  const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
  const handler = facade(
    core,
    await loadLayers({
      app: {
        cfg,
        state,
        library,
        playlists,
        shares,
        publicAddress: createPublicAddress(state),
        libraries,
        user: createUserService(store, cfg),
        annotation: createAnnotation(store),
        listens: createListens(store),
      },
    }),
  );
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    handler,
  );
  const origin = `http://127.0.0.1:${server.addr.port}`;
  const request = (
    op: string,
    fields: [string, string][] = [],
    user = 'listener',
    post = false,
    format = 'json',
  ) => {
    const p = new URLSearchParams({
      u: user,
      p: 'test',
      v: '1.16.1',
      c: 'shares-test',
      f: format,
    });
    for (const [k, v] of fields) p.append(k, v);
    return fetch(
      `${origin}/rest/${op}.view${post ? '' : `?${p}`}`,
      post ? { method: 'POST', body: p } : undefined,
    );
  };
  const json = async (
    op: string,
    fields: [string, string][] = [],
    user = 'listener',
    post = false,
  ) => {
    const res = await request(op, fields, user, post);
    assertEquals(res.status, 200);
    return (await res.json())['subsonic-response'];
  };
  const ok = async (
    op: string,
    fields: [string, string][] = [],
    user = 'listener',
    post = false,
  ) => {
    const body = await json(op, fields, user, post);
    assertEquals(body.status, 'ok', JSON.stringify(body));
    return body;
  };
  const list = async (user = 'listener', post = false): Promise<WireShare[]> =>
    (await ok('getShares', [], user, post)).shares.share;
  const create = async (
    ids: string[],
    fields: [string, string][] = [],
    user = 'listener',
    post = false,
  ): Promise<WireShare> =>
    (await ok(
      'createShare',
      [...ids.map((id): [string, string] => ['id', id]), ...fields],
      user,
      post,
    )).shares.share[0];
  return {
    state,
    library,
    playlists,
    shares,
    libraries,
    origin,
    request,
    json,
    ok,
    list,
    create,
    close: () => server.shutdown(),
  };
}
async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-shares-' });
  const store = await openStore(dir);
  await seedFirstUser(store, config(dir));
  const password = (await encryptPassword(config(dir).secret, 'test'))
    .replaceAll("'", "''");
  await rawSql(store).run(
    `INSERT INTO users (id, name, password_enc, created_at) VALUES
    ('listener', 'listener', '${password}', now()), ('other', 'other', '${password}', now())`,
  );
  const client = await api(store, dir);
  await client.libraries.add(
    'Music',
    await Deno.realPath('tests/fixtures/library'),
  );
  await createScan(store).run();
  const songs = (await store.catalog.listSongs({ offset: 0, size: 100 }))
    .filter((s) => s.title);
  assert(songs.length >= 2);
  return {
    ...client,
    store,
    dir,
    songs,
    async close() {
      await client.close();
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}
async function enable(s: Awaited<ReturnType<typeof setup>>) {
  await s.state.set('sharing.enabled', 'true');
}

Deno.test('shares HTTP: disabled by default, live role and all four GET/form endpoints refuse sharing', async () => {
  const s = await setup();
  try {
    assertEquals(await s.state.getTyped('sharing.enabled'), false);
    assertEquals(await s.state.getTyped('sharing.defaultExpirationDays'), 365);
    assertEquals(
      await s.state.getTyped('sharing.downloadableByDefault'),
      false,
    );
    assertEquals(await s.state.getTyped('server.publicUrl'), '');
    for (const post of [false, true]) {
      assertEquals(
        (await s.ok('getUser', [['username', 'listener']], 'listener', post))
          .user.shareRole,
        false,
      );
      for (
        const op of ['createShare', 'getShares', 'updateShare', 'deleteShare']
      ) {
        const fields: [string, string][] = [['id', s.songs[0].id]];
        assertEquals(
          (await s.json(op, fields, 'listener', post)).error.code,
          50,
        );
        const xml = await (await s.request(op, fields, 'listener', post, 'xml'))
          .text();
        assertStringIncludes(xml, '<error code="50"');
      }
    }
    assertEquals(
      await s.shares.create('listener', [s.songs[0].id]),
      'disabled',
    );
    assertEquals(await s.shares.open('unknown'), null);
    assertEquals(await s.store.shares.list(), []);
    await enable(s);
    assertEquals(
      (await s.ok('getUser', [['username', 'listener']])).user.shareRole,
      true,
    );
    const users = (await s.ok('getUsers', [], 'admin', true)).users.user;
    assert(
      users.length === 3 &&
        users.every((u: { shareRole: boolean }) => u.shareRole),
    );
    const created = await s.create([s.songs[0].id]);
    await s.state.set('sharing.enabled', 'false');
    assertEquals(await s.shares.open(created.id), null);
    assertEquals(
      (await s.ok('getUser', [['username', 'listener']])).user.shareRole,
      false,
    );
    assertEquals((await s.store.shares.get(created.id))!.visitCount, 0);
  } finally {
    await s.close();
  }
});

Deno.test('shares HTTP: homogeneous songs/albums/artists/playlists, ordered entries and public URL prefix in JSON/XML', async () => {
  const s = await setup();
  try {
    await enable(s);
    const [a, b] = s.songs;
    const description = 'A & "B" <listen>';
    const songs = await s.create(
      [b.id, a.id, b.id],
      [['description', description]],
      'listener',
      true,
    );
    assert(/^[0-9A-Za-z]{10}$/.test(songs.id));
    assertEquals(songs.username, 'listener');
    assertEquals(songs.url, `${s.origin}/share/${songs.id}`);
    assertEquals(songs.description, description);
    assertEquals(songs.entry.map((s) => s.id), [b.id, a.id, b.id]);
    assert(songs.entry.every((e) => !e.isDir));
    assertEquals(songs.lastVisited, undefined);
    const album = await s.create([a.albumId!]);
    assertEquals(album.entry.map((e) => [e.id, e.isDir]), [[a.albumId, true]]);
    const coreAlbum = await s.library.getAlbum(a.albumId!);
    const albumRow = await s.store.shares.get(album.id);
    assert(albumRow && coreAlbum);
    assertEquals(
      (await s.shares.tracks(albumRow)).map((t) => t.id),
      coreAlbum.songs.map((t) => t.id),
    );
    const artistId = coreAlbum.album.artistId!;
    assert(artistId);
    const artist = await s.create([artistId], [], 'listener', true);
    assertEquals(
      artist.entry.map((e) => e.id),
      (await s.library.albumsByArtist(artistId)).map((a) => a.id),
    );
    assert(artist.entry.every((e) => e.isDir));
    const playlist = await s.playlists.create('listener', 'Ordered', [
      b.id,
      a.id,
      b.id,
    ]);
    const playlistShare = await s.create([playlist.id]);
    assertEquals(playlistShare.entry.map((e) => e.id), [b.id, a.id, b.id]);
    await s.state.set('server.publicUrl', 'https://music.example/house/music/');
    const rows = await s.list('listener', true);
    assert(
      rows.every((r) =>
        r.url === `https://music.example/house/music/share/${r.id}`
      ),
    );
    for (const post of [false, true]) {
      const xml =
        await (await s.request('getShares', [], 'listener', post, 'xml'))
          .text();
      assertStringIncludes(
        xml,
        'description="A &amp; &quot;B&quot; &lt;listen&gt;"',
      );
      assertStringIncludes(
        xml,
        `url="https://music.example/house/music/share/${songs.id}"`,
      );
      assertEquals((xml.match(/<share /g) ?? []).length, 4);
      assertStringIncludes(xml, `id="${a.albumId}"`);
    }
    assertEquals(
      await s.state.getTyped('sharing.downloadableByDefault'),
      false,
    );
    assertEquals((await s.store.shares.get(songs.id))!.downloadable, false);
    await s.state.set('sharing.downloadableByDefault', 'true');
    const downloadable = await s.create([a.id], [['downloadable', 'false']]);
    assertEquals(
      (await s.store.shares.get(downloadable.id))!.downloadable,
      true,
    );
    for (
      const value of [
        '/relative',
        'ftp://example.org/',
        'https://',
        'javascript:alert(1)',
      ]
    ) {
      await assertRejects(() => s.state.set('server.publicUrl', value));
    }
  } finally {
    await s.close();
  }
});

Deno.test('shares HTTP: core ownership, admin management, required/unknown/mixed/private resources and no failed mutation', async () => {
  const s = await setup();
  try {
    await enable(s);
    const [a, b] = s.songs;
    const privatePlaylist = await s.playlists.create('other', 'Private', [
      b.id,
    ]);
    const first = await s.create([a.id]);
    const second = await s.create([b.id], [], 'other', true);
    assertEquals((await s.list()).map((r) => r.id), [first.id]);
    assertEquals((await s.list('other')).map((r) => r.id), [second.id]);
    assertEquals((await s.list('admin')).map((r) => r.id), [
      second.id,
      first.id,
    ]);
    for (const post of [false, true]) {
      for (const op of ['createShare', 'updateShare', 'deleteShare']) {
        assertEquals((await s.json(op, [], 'listener', post)).error.code, 10);
      }
      for (const op of ['updateShare', 'deleteShare']) {
        assertEquals(
          (await s.json(
            op,
            [['id', second.id], ['description', 'attack']],
            'listener',
            post,
          )).error.code,
          50,
        );
        assertEquals(
          (await s.json(op, [['id', 'unknown']], 'listener', post)).error.code,
          70,
        );
        const xml = await (await s.request(
          op,
          [['id', second.id]],
          'listener',
          post,
          'xml',
        )).text();
        assertStringIncludes(xml, '<error code="50"');
      }
      for (
        const ids of [
          [a.id, a.albumId!],
          [a.id, 'unknown'],
          [privatePlaylist.id],
          ['unknown'],
          [a.id, ''],
        ]
      ) {
        assertEquals(
          (await s.json(
            'createShare',
            ids.map((id): [string, string] => ['id', id]),
            'listener',
            post,
          )).error.code,
          70,
        );
      }
    }
    assertEquals(
      await s.shares.update('listener', second.id, { description: 'attack' }),
      'forbidden',
    );
    assertEquals(await s.shares.delete('listener', second.id), 'forbidden');
    assertEquals((await s.store.shares.get(second.id))!.description, '');
    assertEquals((await s.store.shares.list()).length, 2);
    await s.ok(
      'updateShare',
      [['id', second.id], ['description', 'Admin edit']],
      'admin',
      true,
    );
    assertEquals((await s.list('other'))[0].description, 'Admin edit');
    await s.ok('deleteShare', [['id', second.id]], 'admin');
    assertEquals(await s.list('other'), []);
    const xml = await (await s.request(
      'deleteShare',
      [['id', first.id]],
      'listener',
      true,
      'xml',
    )).text();
    assertStringIncludes(xml, 'status="ok"');
    assertEquals(await s.list(), []);
  } finally {
    await s.close();
  }
});

Deno.test('shares HTTP: epoch expiry, default days, partial update, removal, atomic visits and expired/missing outcomes', async () => {
  const s = await setup();
  try {
    await enable(s);
    const created = await s.create([s.songs[0].id]);
    const expires = Date.parse(created.expires!);
    assert(
      Math.abs(expires - Date.parse(created.created) - 365 * 86400000) < 1000,
    );
    await s.state.set('sharing.defaultExpirationDays', '2');
    const custom = await s.create([s.songs[0].id]);
    assert(
      Math.abs(
        Date.parse(custom.expires!) - Date.parse(custom.created) - 2 * 86400000,
      ) < 1000,
    );
    const when = Date.now() + 500000;
    const exact = await s.create([s.songs[0].id], [['expires', String(when)], [
      'description',
      'Kept',
    ]]);
    assertEquals(exact.expires, new Date(when).toISOString());
    await s.ok(
      'updateShare',
      [['id', exact.id], ['expires', '0']],
      'listener',
      true,
    );
    let row = (await s.list()).find((r) => r.id === exact.id)!;
    assertEquals(row.expires, undefined);
    assertEquals(row.description, 'Kept');
    await s.ok('updateShare', [['id', exact.id], ['description', '']]);
    row = (await s.list()).find((r) => r.id === exact.id)!;
    assertEquals(row.description, '');
    assertEquals(row.expires, undefined);
    const opened = await Promise.all(
      Array.from({ length: 8 }, () => s.shares.open(exact.id)),
    );
    assert(opened.every((r) => r !== null && r !== 'expired'));
    row = (await s.list()).find((r) => r.id === exact.id)!;
    assertEquals(row.visitCount, 8);
    assert(Number.isFinite(Date.parse(row.lastVisited!)));
    await s.ok(
      'updateShare',
      [['id', exact.id], ['expires', '1']],
      'listener',
      true,
    );
    assertEquals(await s.shares.open(exact.id), 'expired');
    assertEquals(await s.shares.open('unknown'), null);
    row = (await s.list()).find((r) => r.id === exact.id)!;
    assertEquals(row.visitCount, 8);
    assertEquals(row.expires, '1970-01-01T00:00:00.001Z');
    const xml =
      await (await s.request('getShares', [], 'listener', true, 'xml')).text();
    assertStringIncludes(xml, 'expires="1970-01-01T00:00:00.001Z"');
    assertStringIncludes(xml, 'visitCount="8"');
    const before = await s.store.shares.get(exact.id);
    for (
      const value of [
        'garbage',
        'NaN',
        'Infinity',
        '9007199254740992',
        '8640000000000001',
      ]
    ) {
      assertEquals(
        (await s.json('updateShare', [['id', exact.id], ['expires', value]]))
          .error.code,
        10,
      );
    }
    assertEquals(await s.store.shares.get(exact.id), before);
    // Successful XML mutations reach the same persisted facts as JSON/form reads.
    for (const post of [false, true]) {
      const xmlCreated = await (await s.request(
        'createShare',
        [
          ['id', s.songs[0].id],
          ['description', 'XML & share'],
        ],
        'listener',
        post,
        'xml',
      )).text();
      assertStringIncludes(xmlCreated, '<shares><share ');
      assertStringIncludes(xmlCreated, 'description="XML &amp; share"');
      const match = /<share id="([0-9A-Za-z]{10})"/.exec(xmlCreated);
      assert(match);
      const xmlUpdated = await (await s.request(
        'updateShare',
        [
          ['id', match[1]],
          ['description', 'XML changed'],
          ['expires', '0'],
        ],
        'listener',
        post,
        'xml',
      )).text();
      assertStringIncludes(xmlUpdated, 'status="ok"');
      const observed = (await s.list()).find((r) => r.id === match[1])!;
      assertEquals(observed.description, 'XML changed');
      assertEquals(observed.expires, undefined);
      await s.ok('deleteShare', [['id', match[1]]], 'listener', post);
    }
  } finally {
    await s.close();
  }
});

Deno.test('shares HTTP: live playlist visibility/order, vanished tracks and rescans preserve share facts', async () => {
  const s = await setup();
  try {
    await enable(s);
    const [a, b] = s.songs;
    const playlist = await s.playlists.create('other', 'Public', [
      b.id,
      a.id,
      b.id,
    ], true);
    const share = await s.create([playlist.id]);
    assertEquals(share.entry.map((e) => e.id), [b.id, a.id, b.id]);
    const snapshot = (await s.store.shares.get(share.id))!;
    await s.playlists.setTracks('other', playlist.id, [a.id, b.id, a.id]);
    assertEquals((await s.list())[0].entry.map((e) => e.id), [
      a.id,
      b.id,
      a.id,
    ]);
    await s.playlists.update('other', playlist.id, { public: false });
    assertEquals((await s.list())[0].entry, []);
    assertEquals(await s.shares.tracks(snapshot), []);
    await s.playlists.update('other', playlist.id, { public: true });
    const songShare = await s.create([a.id, b.id, a.id]);
    await rawSql(s.store).run(`DELETE FROM files WHERE id = '${a.id}'`);
    assertEquals(
      (await s.list()).find((r) => r.id === songShare.id)!.entry.map((e) =>
        e.id
      ),
      [b.id],
    );
    await createScan(s.store).run();
    assertEquals(
      (await s.list()).find((r) => r.id === songShare.id)!.entry.map((e) =>
        e.id
      ),
      [a.id, b.id, a.id],
    );
    assertEquals(await s.store.shares.get(share.id), snapshot);
    await s.ok('deleteShare', [['id', share.id]]);
    assertEquals(await s.shares.tracks(snapshot), []);
  } finally {
    await s.close();
  }
});

Deno.test('shares HTTP: upgrade creates table without resetting state and all facts survive reopen', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-shares-upgrade-' });
  let store = await openStore(dir);
  let client: Awaited<ReturnType<typeof api>> | undefined;
  try {
    await seedFirstUser(store, config(dir));
    await store.state.set('upgrade-proof', 'kept');
    await rawSql(store).run('DROP TABLE shares');
    await store.close();
    store = await openStore(dir);
    client = await api(store, dir);
    assertEquals(await store.state.get('upgrade-proof'), 'kept');
    await client.state.set('sharing.enabled', 'true');
    await client.libraries.add(
      'Music',
      await Deno.realPath('tests/fixtures/library'),
    );
    await createScan(store).run();
    const songs = await store.catalog.listSongs({ offset: 0, size: 100 });
    const created = await client.create(
      [songs[0].id],
      [['description', "O'Clock & friends"]],
      'admin',
      true,
    );
    await client.shares.open(created.id);
    await client.ok(
      'updateShare',
      [['id', created.id], ['expires', '0']],
      'admin',
    );
    const before = await store.shares.get(created.id);
    const wire = await client.list('admin');
    await client.close();
    client = undefined;
    await store.close();
    store = await openStore(dir);
    client = await api(store, dir);
    assertEquals(await client.shares.enabled(), true);
    assertEquals(await store.shares.get(created.id), before);
    const after = await client.list('admin', true);
    assertEquals(
      after.map((r) => ({ ...r, url: '' })),
      wire.map((r) => ({ ...r, url: '' })),
    );
    assertEquals(after[0].url, `${client.origin}/share/${created.id}`);
    await client.ok('deleteShare', [['id', created.id]], 'admin', true);
    assertEquals(await client.list('admin'), []);
  } finally {
    await client?.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
