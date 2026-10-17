import { assert, assertEquals } from '@std/assert';
import { openStore, type Store } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { tagged } from './helpers/tagged.ts';
import { pathfinder } from '@pathfinder/pathfinder';
import { seedFirstUser } from '../src/users.ts';
import { createUserService } from '../src/user.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { loadLayers } from '../src/layers.ts';
import { facade } from '../src/facade.ts';
import {
  albumsByLabel as subsonicAlbumOrder,
  artistAlbumsOrder,
} from '../layers/opensubsonic/id3.ts';
import { albumsByLabel as owntoneAlbumOrder } from '../layers/owntone/payloads.ts';

async function setup(
  fn: (store: Store, root: string, dir: string) => Promise<void>,
) {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-albums-' });
  const root = `${dir}/music`;
  await Deno.mkdir(root);
  const store = await openStore(`${dir}/db`);
  try {
    await createLibraries(store).add('Music', root);
    await fn(store, root, dir);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}
async function write(root: string, rel: string, tags: Record<string, string>) {
  await Deno.mkdir(`${root}/${rel.slice(0, rel.lastIndexOf('/'))}`, {
    recursive: true,
  });
  await tagged(`${root}/${rel}`, { TIT2: rel, ...tags });
}
const list = (store: Store) =>
  createLibrary(store).listAlbums({ sort: 'name', offset: 0, size: 100 });

Deno.test('scan albums parts row 2: disc evidence reaches album and song consumers', async () => {
  await setup(async (store, root) => {
    await write(root, 'Album/CD1/a.mp3', {
      TALB: 'Album',
      TPE2: 'Artist',
      TPE1: 'Singer',
      TPOS: '1/2',
    });
    await write(root, 'Album/CD2/b.mp3', {
      TALB: 'Album',
      TPE2: 'Artist',
      TPE1: 'Other',
      TPOS: '2/2',
    });
    assertEquals((await scanLibrary(store)).albums, 1);
    const albums = await list(store);
    assertEquals(
      albums.map((
        a,
      ) => [a.name, a.artistKind, a.artistName, a.folderName, a.songCount]),
      [['Album', 'tagged', 'Artist', 'Album', 2]],
    );
    const got = (await createLibrary(store).getAlbum(albums[0].id))!;
    assertEquals(got.songs.map((s) => [s.disc, s.albumId, s.albumFolderName]), [
      [1, albums[0].id, 'Album'],
      [2, albums[0].id, 'Album'],
    ]);
  });
});

Deno.test('artist album ordering uses displayed labels in each plugin', async () => {
  await setup(async (store, root) => {
    await write(root, 'Singles/a.mp3', { TPE1: 'Artist' });
    await write(root, 'Zoo/b.mp3', { TPE1: 'Artist', TALB: 'Zoo' });
    await scanLibrary(store);
    const albums = await list(store);
    assertEquals(albums.map((a) => a.name), [null, 'Zoo']);
    for (
      const order of [subsonicAlbumOrder, artistAlbumsOrder, owntoneAlbumOrder]
    ) {
      assertEquals(order(albums).map((a) => a.name), ['Zoo', null]);
    }
  });
});
Deno.test('scan albums parts row 3: folder hints do not merge missing discs', async () => {
  await setup(async (store, root) => {
    for (const dir of ['CD1', 'CD2']) {
      await write(root, `Album/${dir}/a.mp3`, {
        TALB: 'Album',
        TPE2: 'Artist',
      });
    }
    assertEquals((await scanLibrary(store)).albums, 2);
    assertEquals((await list(store)).map((a) => [a.folderName, a.songCount]), [[
      'Album',
      1,
    ], ['Album', 1]]);
  });
});
Deno.test('scan albums parts row 6: untagged singles aggregate various artists without invented names', async () => {
  await setup(async (store, root) => {
    for (let i = 0; i < 10; i++) {
      await write(root, `Singles/${i}.mp3`, { TPE1: `Artist ${i}` });
    }
    const counts = await scanLibrary(store);
    assertEquals([counts.albums, counts.artists], [1, 10]);
    assertEquals(
      (await list(store)).map((
        a,
      ) => [
        a.name,
        a.artistKind,
        a.artistId,
        a.artistName,
        a.folderName,
        a.songCount,
      ]),
      [[null, 'various', null, null, 'Singles', 10]],
    );
  });
});
Deno.test('scan albums parts row 8: one track artist becomes shared without album tag', async () => {
  await setup(async (store, root) => {
    await write(root, 'Abbey Road/a.mp3', { TPE1: 'The Beatles' });
    await scanLibrary(store);
    assertEquals(
      (await list(store)).map((
        a,
      ) => [a.name, a.artistKind, a.artistName, a.folderName]),
      [[null, 'shared', 'The Beatles', 'Abbey Road']],
    );
  });
});
Deno.test('scan albums identity row 2: directory move retains album star and date', async () => {
  await setup(async (store, root) => {
    await write(root, 'Before/a.mp3', { TALB: 'Album', TPE2: 'Artist' });
    await scanLibrary(store);
    const before = (await list(store))[0];
    await store.users.seedFirst('u', 'alice', 'unused');
    await store.annotations.appendStarEvent(
      'alice',
      before.id,
      'album',
      'star',
    );
    await Deno.rename(`${root}/Before`, `${root}/After`);
    await scanLibrary(store);
    const after = (await list(store))[0];
    assertEquals([after.id, after.createdAtMs], [
      before.id,
      before.createdAtMs,
    ]);
    const stars = await store.annotations.starred('alice', {});
    assertEquals(stars.map((s) => [s.targetId, s.targetType]), [[
      after.id,
      'album',
    ]]);
    assertEquals(
      await rawSql(store).all(
        'SELECT kind, from_root, to_root FROM album_events',
      ),
      [{ kind: 'moved', from_root: 'Before', to_root: 'After' }],
    );
  });
});
Deno.test('scan albums identity row 9: absent album returns through retained file album', async () => {
  await setup(async (store, root, dir) => {
    await write(root, 'Album/a.mp3', { TALB: 'Album', TPE2: 'Artist' });
    await scanLibrary(store);
    const before = (await list(store))[0];
    await Deno.rename(`${root}/Album`, `${dir}/absent`);
    await scanLibrary(store);
    assertEquals(await list(store), []);
    assertEquals(
      await rawSql(store).all('SELECT present FROM album_identity'),
      [{ present: false }],
    );
    await Deno.rename(`${dir}/absent`, `${root}/Album`);
    await scanLibrary(store);
    const after = (await list(store))[0];
    assertEquals(after.id, before.id);
    assertEquals(after.createdAtMs, before.createdAtMs);
    assert(after.createdAtMs !== null);
    assertEquals(
      await rawSql(store).all('SELECT present FROM album_identity'),
      [{ present: true }],
    );
  });
});

Deno.test('scan album facts render bracket labels and placeholder ids at both protocol consumers', async () => {
  await setup(async (store, root, dir) => {
    await write(root, 'Singles/a.mp3', { TPE1: 'A' });
    await write(root, 'Singles/b.mp3', { TPE1: 'B' });
    await write(root, 'Mystery/c.mp3', {});
    await scanLibrary(store);
    const cfg = {
      listen: undefined,
      dataDir: dir,
      user: 'admin',
      password: 'test',
      secret: 'test',
      version: 'test',
    };
    await seedFirstUser(store, cfg);
    const library = createLibrary(store);
    const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
    const layers = await loadLayers({
      app: {
        cfg,
        library,
        user: createUserService(store, cfg),
        annotation: createAnnotation(store),
        listens: createListens(store),
      },
    });
    const subsonic = facade(core, layers);
    const owntone = facade(core, layers, {
      listenPort: 3689,
      defaultPort: 4534,
      env: {},
    });
    for (const album of await list(store)) {
      const params = new URLSearchParams({
        u: 'admin',
        p: 'test',
        v: '1.16.1',
        c: 'album-test',
        f: 'json',
        id: album.id,
      });
      const response = await subsonic(
        new Request(`http://x/rest/getAlbum?${params}`),
      );
      assertEquals(response.status, 200);
      const body = (await response.json())['subsonic-response'];
      assertEquals(body.status, 'ok');
      const label = `[${album.folderName}]`;
      const artist = album.artistKind === 'various'
        ? '[Various Artists]'
        : '[Unknown Artist]';
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(
          `melofon-placeholder-artist\n${album.artistKind}`,
        ),
      );
      const placeholder = [...new Uint8Array(digest)].map((b) =>
        b.toString(16).padStart(2, '0')
      ).join('').slice(0, 32);
      assertEquals([body.album.name, body.album.artist, body.album.artistId], [
        label,
        artist,
        placeholder,
      ]);
      assertEquals(
        body.album.song.map((s: { album: string }) => s.album),
        Array(album.songCount).fill(label),
      );
      const directory = await (await subsonic(
        new Request(`http://x/rest/getMusicDirectory?${params}`),
      )).json();
      assertEquals([
        directory['subsonic-response'].directory.name,
        directory['subsonic-response'].directory.parent,
      ], [label, placeholder]);
      const wire = (id: string) =>
        String(Number(BigInt(`0x${id.slice(0, 8)}`) & 0x7fffffffn));
      const ot = await owntone(
        new Request(`http://x/api/library/albums/${wire(album.id)}`),
      );
      assertEquals(ot.status, 200);
      const rendered = await ot.json();
      assertEquals([rendered.name, rendered.artist, rendered.artist_id], [
        label,
        artist,
        wire(placeholder),
      ]);
      const tracks = await (await owntone(
        new Request(`http://x/api/library/albums/${wire(album.id)}/tracks`),
      )).json();
      assertEquals(
        tracks.items.map((
          s: { album: string; album_artist: string; album_artist_id: string },
        ) => [s.album, s.album_artist, s.album_artist_id]),
        Array.from(
          { length: album.songCount },
          () => [label, artist, wire(placeholder)],
        ),
      );
    }
  });
});
