import { assert, assertEquals } from '@std/assert';
import { openStore, type Store } from '../src/store/index.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createArtwork } from '../src/artwork.ts';
import { scanLibrary } from '../src/scan.ts';
import { imageHash } from '../src/images.ts';
import { pictured } from './helpers/pictured.ts';

async function setup(
  fn: (store: Store, root: string, image: Uint8Array) => Promise<void>,
) {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-conflicts-' });
  const root = `${dir}/music`;
  await Deno.mkdir(root);
  const store = await openStore(`${dir}/db`);
  try {
    await createLibraries(store).add('Music', root);
    await fn(
      store,
      root,
      await Deno.readFile(
        'tests/fixtures/library/Fixture Artist/Fixture Album/cover.jpg',
      ),
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}
const albums = (store: Store) =>
  store.catalog.listAlbums({ sort: 'name', size: 100, offset: 0 });
const bytes = async (response: Response) =>
  new Uint8Array(await response.arrayBuffer());

Deno.test('scan records cover/APIC conflicts without copying images or changing display, then clears agreement', async () => {
  await setup(async (store, root, image) => {
    const embedded = new Uint8Array([...image, 1]);
    await pictured(`${root}/Album/song.mp3`, embedded);
    await Deno.writeFile(`${root}/Album/cover.jpg`, image);
    await scanLibrary(store);
    const album = (await albums(store))[0];
    const song = (await store.catalog.getAlbum(album.id))!.songs[0];
    const rows = await store.candidates.candidatesFor('album', album.id);
    assertEquals(rows.length, 2);
    assertEquals(
      new Set(rows.map((r) => r.imageHash)),
      new Set([await imageHash(image), await imageHash(embedded)]),
    );
    assertEquals(
      new Set(rows.map((r) => r.origin)),
      new Set(['Album/cover.jpg', song.id]),
    );
    assert(
      rows.every((r) =>
        r.source === 'local' && r.confidence === null && r.state === 'open'
      ),
    );
    assertEquals(
      Array.from(Deno.readDirSync(`${root}/.melofon/candidates`)),
      [],
    );
    const artwork = createArtwork(createLibrary(store));
    assertEquals(await bytes(await artwork.cover(album.id)), image);
    assertEquals(await bytes(await artwork.cover(song.id)), embedded);
    await scanLibrary(store);
    assertEquals(
      (await store.candidates.candidatesFor('album', album.id)).map((r) =>
        r.id
      ),
      rows.map((r) => r.id),
    );
    await pictured(`${root}/Album/song.mp3`, image);
    await scanLibrary(store);
    assertEquals(await store.candidates.candidatesFor('album', album.id), []);
    assertEquals(await bytes(await artwork.cover(album.id)), image);
  });
});

Deno.test('distinct track APICs are local versions; duplicate pictures coalesce and decisions survive resolution', async () => {
  await setup(async (store, root, image) => {
    const other = new Uint8Array([...image, 2]);
    await pictured(`${root}/Album/a.mp3`, image, { TRCK: '1' });
    await pictured(`${root}/Album/b.mp3`, other, { TRCK: '2' });
    await pictured(`${root}/Album/c.mp3`, image, { TRCK: '3' });
    await scanLibrary(store);
    const album = (await albums(store))[0];
    const rows = await store.candidates.candidatesFor('album', album.id);
    assertEquals(rows.length, 2);
    await store.candidates.setState(rows[0].id, 'accepted');
    await pictured(`${root}/Album/b.mp3`, image, { TRCK: '2' });
    await scanLibrary(store);
    assertEquals(
      (await store.candidates.candidatesFor('album', album.id)).map((
        r,
      ) => [r.id, r.state]),
      [[rows[0].id, 'accepted']],
    );
    await pictured(`${root}/Album/b.mp3`, other, { TRCK: '2' });
    await scanLibrary(store);
    assertEquals(
      (await store.candidates.candidatesFor('album', album.id)).length,
      2,
    );
  });
});

Deno.test('conflicts include all cover extensions and eligible multipart roots, never another album or library root', async () => {
  await setup(async (store, root, image) => {
    await pictured(`${root}/Multi/CD1/a.mp3`, image, { TPOS: '1/2' });
    await pictured(`${root}/Multi/CD2/b.mp3`, image, { TPOS: '2/2' });
    await Deno.writeFile(
      `${root}/Multi/COVER.WebP`,
      new Uint8Array([...image, 3]),
    );
    await Deno.writeFile(
      `${root}/Multi/CD2/cover.PNG`,
      new Uint8Array([...image, 4]),
    );
    await Deno.writeFile(`${root}/cover.jpg`, new Uint8Array([...image, 5]));
    await scanLibrary(store);
    const album = (await albums(store))[0];
    assertEquals(
      (await store.candidates.candidatesFor('album', album.id)).length,
      3,
    );
    await pictured(`${root}/Multi/Other/c.mp3`, undefined, { TALB: 'Other' });
    await scanLibrary(store);
    const rows = await store.candidates.candidatesFor('album', album.id);
    assertEquals(rows.length, 2);
    assert(
      !rows.some((r) =>
        r.origin === 'Multi/COVER.WebP' || r.origin === 'cover.jpg'
      ),
    );
  });
});

Deno.test('kept album candidates follow moves and refresh local file origins without losing rejection', async () => {
  await setup(async (store, root, image) => {
    await pictured(`${root}/Before/a.mp3`, image);
    await Deno.writeFile(
      `${root}/Before/cover.jpg`,
      new Uint8Array([...image, 6]),
    );
    await scanLibrary(store);
    const album = (await albums(store))[0];
    const before = await store.candidates.candidatesFor('album', album.id);
    await store.candidates.setState(
      before.find((r) => r.origin !== 'Before/cover.jpg')!.id,
      'rejected',
    );
    await Deno.rename(`${root}/Before`, `${root}/After`);
    await scanLibrary(store);
    assertEquals((await albums(store))[0].id, album.id);
    const after = await store.candidates.candidatesFor('album', album.id);
    assertEquals(after.map((r) => r.id), before.map((r) => r.id));
    assert(after.some((r) => r.origin === 'After/cover.jpg'));
    assertEquals(after.filter((r) => r.state === 'rejected').length, 1);
  });
});

Deno.test('read-only library scan adds neither local candidates nor hidden image files', async () => {
  await setup(async (store, root, image) => {
    await pictured(`${root}/Album/a.mp3`, image);
    await Deno.writeFile(
      `${root}/Album/cover.jpg`,
      new Uint8Array([...image, 7]),
    );
    await Deno.chmod(root, 0o555);
    try {
      await scanLibrary(store);
      assertEquals(
        await store.candidates.candidatesFor(
          'album',
          (await albums(store))[0].id,
        ),
        [],
      );
      assertEquals(
        await Deno.stat(`${root}/.melofon`).then(() => true, () => false),
        false,
      );
    } finally {
      await Deno.chmod(root, 0o755);
    }
  });
});
