import { assert, assertEquals } from '@std/assert';
import { openStore, type Store } from '../src/store/index.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { scanLibrary } from '../src/scan.ts';
import { createArtwork } from '../src/artwork.ts';
import { tagged } from './helpers/tagged.ts';

const fixture = 'tests/fixtures/library/Fixture Artist/Fixture Album/cover.jpg';
const syncSize = (
  n: number,
) => [n >> 21 & 127, n >> 14 & 127, n >> 7 & 127, n & 127];

// Real MP3s with an APIC frame; distinct byte payloads make precedence observable.
async function write(
  root: string,
  rel: string,
  picture?: Uint8Array,
  tags: Record<string, string> = {},
) {
  const path = `${root}/${rel}`;
  await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await tagged(path, { TALB: 'Album', TPE2: 'Artist', ...tags });
  if (picture) {
    const original = await Deno.readFile(path);
    const size = (original[6] << 21) | (original[7] << 14) |
      (original[8] << 7) | original[9];
    const payload = new Uint8Array(14 + picture.length);
    payload.set([0, ...new TextEncoder().encode('image/jpeg'), 0, 3, 0]);
    payload.set(picture, 14);
    const frame = new Uint8Array(10 + payload.length);
    frame.set(new TextEncoder().encode('APIC'));
    frame.set(syncSize(payload.length), 4);
    frame.set(payload, 10);
    const bytes = new Uint8Array(original.length + frame.length);
    bytes.set(original.subarray(0, 10 + size));
    bytes.set(syncSize(size + frame.length), 6);
    bytes.set(frame, 10 + size);
    bytes.set(original.subarray(10 + size), 10 + size + frame.length);
    await Deno.writeFile(path, bytes);
  }
}

async function setup(
  fn: (store: Store, root: string, image: Uint8Array) => Promise<void>,
) {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-artwork-' });
  const store = await openStore(`${dir}/db`);
  try {
    const root = `${dir}/music`;
    await Deno.mkdir(root);
    await createLibraries(store).add('Music', root);
    const image = await Deno.readFile(fixture);
    assert(image.length > 0);
    await fn(store, root, image);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}
async function expect(
  response: Response,
  bytes: Uint8Array,
  contentType: string,
) {
  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type'), contentType);
  assertEquals(new Uint8Array(await response.arrayBuffer()), bytes);
}

Deno.test('artwork song own picture wins; songs without one follow album file, first track, placeholder', async () => {
  await setup(async (store, root, image) => {
    const own = new Uint8Array([...image, 1]);
    await write(root, 'Album/z-first.mp3', image, { TRCK: '1' });
    await write(root, 'Album/a-second.mp3', own, { TRCK: '2' });
    await write(root, 'Album/b-third.mp3', undefined, { TRCK: '3' });
    const local = new Uint8Array([...image, 2]);
    await Deno.writeFile(`${root}/Album/cover.jpg`, local);
    await scanLibrary(store);
    const library = createLibrary(store);
    const album =
      (await library.listAlbums({ sort: 'name', size: 20, offset: 0 }))[0];
    const songs = (await library.getAlbum(album.id))!.songs;
    const artwork = createArtwork(library);
    await expect(await artwork.cover(songs[1].id), own, 'image/jpeg');
    await expect(await artwork.cover(album.id), local, 'image/jpeg');
    await expect(await artwork.cover(songs[2].id), local, 'image/jpeg');
    await expect(await artwork.cover(album.artistId!), local, 'image/jpeg');
    await Deno.remove(`${root}/Album/cover.jpg`);
    await expect(await artwork.cover(album.id), image, 'image/jpeg');
    await expect(await artwork.cover(songs[2].id), image, 'image/jpeg');
    // An album uses the first track, not a later track's different picture.
    await write(root, 'Album/z-first.mp3', undefined, { TRCK: '1' });
    const placeholder = new Uint8Array(
      await artwork.placeholder().arrayBuffer(),
    );
    await expect(await artwork.cover(album.id), placeholder, 'image/png');
    await expect(await artwork.cover(songs[2].id), placeholder, 'image/png');
    // Unknown is not a known entity with absent art (Navidrome media_retrieval.go:74-76).
    assertEquals((await artwork.cover('missing')).status, 404);
  });
});

for (
  const [name, contentType] of [
    ['cover.jpg', 'image/jpeg'],
    ['cover.JPEG', 'image/jpeg'],
    ['cover.PNG', 'image/png'],
    ['COVER.WebP', 'image/webp'],
  ] as const
) {
  Deno.test(`artwork recognises ${name} and sends its extension's content type`, async () => {
    await setup(async (store, root, image) => {
      await write(root, 'Album/song.mp3', image);
      const local = new Uint8Array([...image, 3]);
      await Deno.writeFile(`${root}/Album/${name}`, local);
      await scanLibrary(store);
      const library = createLibrary(store);
      const album =
        (await library.listAlbums({ sort: 'name', size: 20, offset: 0 }))[0];
      assertEquals(
        await library.albumCoverPath(album.id),
        `${root}/Album/${name}`,
      );
      await expect(
        await createArtwork(library).cover(album.id),
        local,
        contentType,
      );
    });
  });
}

Deno.test('artwork merged CD1/CD2 uses a part cover before the shared root cover', async () => {
  await setup(async (store, root, image) => {
    await write(root, 'Multi/CD1/a.mp3', undefined, { TPOS: '1/2' });
    await write(root, 'Multi/CD2/b.mp3', undefined, { TPOS: '2/2' });
    await Deno.writeFile(`${root}/Multi/cover.PNG`, image);
    await scanLibrary(store);
    const library = createLibrary(store);
    const albums = await library.listAlbums({
      sort: 'name',
      size: 20,
      offset: 0,
    });
    assertEquals(albums.length, 1);
    const artwork = createArtwork(library);
    await expect(await artwork.cover(albums[0].id), image, 'image/png');
    const own = new Uint8Array([...image, 4]);
    await Deno.writeFile(`${root}/Multi/CD2/cover.webp`, own);
    await expect(await artwork.cover(albums[0].id), own, 'image/webp');
    await Deno.remove(`${root}/Multi/CD2/cover.webp`);
    // A different album anywhere under the parent disqualifies that parent.
    await write(root, 'Multi/Other/song.mp3', undefined, { TALB: 'Other' });
    await scanLibrary(store);
    assertEquals(await library.albumCoverPath(albums[0].id), null);
  });
});

for (const hint of ['CD1', 'FLAC 24-96']) {
  Deno.test(`artwork single ${hint} parent requires an album-only non-library root`, async () => {
    await setup(async (store, root, image) => {
      await write(root, `Single/${hint}/song.mp3`);
      await Deno.writeFile(`${root}/Single/cover.jpg`, image);
      await scanLibrary(store);
      const library = createLibrary(store);
      const album =
        (await library.listAlbums({ sort: 'name', size: 20, offset: 0 }))[0];
      assertEquals(
        await library.albumCoverPath(album.id),
        `${root}/Single/cover.jpg`,
      );
      await write(root, 'Single/other.mp3', undefined, { TALB: 'Other' });
      await scanLibrary(store);
      assertEquals(await library.albumCoverPath(album.id), null);
      await write(root, `${hint}/song.mp3`);
      await Deno.writeFile(`${root}/cover.jpg`, image);
      await scanLibrary(store);
      const songs = await library.listSongs({ size: 20, offset: 0 });
      const atRoot = songs.find((s) => s.path === `${root}/${hint}/song.mp3`)!;
      assertEquals(await library.albumCoverPath(atRoot.albumId!), null);
    });
  });
}

Deno.test('artwork ordinary album folders never borrow an artist parent image', async () => {
  await setup(async (store, root, image) => {
    await write(root, 'Artist/Ordinary/song.mp3');
    await Deno.writeFile(`${root}/Artist/cover.jpg`, image);
    await scanLibrary(store);
    const library = createLibrary(store);
    const album =
      (await library.listAlbums({ sort: 'name', size: 20, offset: 0 }))[0];
    assertEquals(await library.albumCoverPath(album.id), null);
  });
});

Deno.test('artwork merged discs cannot borrow a library-root cover even with no other album', async () => {
  await setup(async (store, root, image) => {
    await write(root, 'CD1/a.mp3', undefined, { TPOS: '1/2' });
    await write(root, 'CD2/b.mp3', undefined, { TPOS: '2/2' });
    await Deno.writeFile(`${root}/cover.jpg`, image);
    await scanLibrary(store);
    const library = createLibrary(store);
    const albums = await library.listAlbums({
      sort: 'name',
      size: 20,
      offset: 0,
    });
    assertEquals(albums.length, 1);
    assertEquals(await library.albumCoverPath(albums[0].id), null);
  });
});
