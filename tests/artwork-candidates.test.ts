import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore, type Store } from '../src/store/index.ts';
import { createLibraries } from '../src/libraries.ts';
import type { LibraryRow } from '../src/store/catalog.ts';
import { createLibrary } from '../src/library.ts';
import { createArtwork } from '../src/artwork.ts';
import { scanLibrary } from '../src/scan.ts';
import {
  candidateImagePath,
  readCandidateImage,
  writeCandidateImage,
} from '../src/images.ts';
import { pictured } from './helpers/pictured.ts';

async function setup(
  fn: (
    store: Store,
    library: LibraryRow,
    image: Uint8Array,
    albumId: string,
  ) => Promise<void>,
) {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-candidate-art-' });
  const root = `${dir}/music`;
  await Deno.mkdir(root);
  const store = await openStore(`${dir}/db`);
  try {
    await createLibraries(store).add('Music', root);
    await pictured(`${root}/Album/song.mp3`);
    await scanLibrary(store);
    await fn(
      store,
      (await store.catalog.listLibraries())[0],
      await Deno.readFile(
        'tests/fixtures/library/Fixture Artist/Fixture Album/cover.jpg',
      ),
      (await store.catalog.listAlbums({ sort: 'name', size: 10, offset: 0 }))[0]
        .id,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}
async function add(
  store: Store,
  library: LibraryRow,
  albumId: string,
  bytes: Uint8Array,
  confidence: 'strong' | 'medium' | 'low',
  foundAtMs = Date.now(),
) {
  const image = (await writeCandidateImage(library, bytes, 'jpg'))!;
  return (await store.candidates.addCandidates([{
    entityType: 'album',
    entityId: albumId,
    kind: 'cover',
    source: 'fixture',
    confidence,
    imageHash: image.hash,
    imageExt: image.ext,
    libraryId: library.id,
    origin: 'https://fixture/cover',
    foundAtMs,
  }]))[0];
}
const bytes = async (response: Response) =>
  new Uint8Array(await response.arrayBuffer());

Deno.test('strong candidate bytes reach album, song fallback and artist artwork consumers', async () => {
  await setup(async (store, library, image, albumId) => {
    await add(store, library, albumId, image, 'strong');
    const artwork = createArtwork(createLibrary(store));
    const album = (await store.catalog.getAlbum(albumId))!;
    for (const id of [albumId, album.songs[0].id, album.album.artistId!]) {
      const response = await artwork.cover(id);
      assertEquals(response.headers.get('content-type'), 'image/jpeg');
      assertEquals(await bytes(response), image);
    }
    await scanLibrary(store);
    assertEquals(await bytes(await artwork.cover(albumId)), image);
  });
});

Deno.test('medium, low and decided candidates never replace the placeholder', async () => {
  await setup(async (store, library, image, albumId) => {
    const artwork = createArtwork(createLibrary(store));
    const placeholder = await bytes(artwork.placeholder());
    await add(store, library, albumId, image, 'medium');
    await add(store, library, albumId, new Uint8Array([...image, 1]), 'low');
    assertEquals(await bytes(await artwork.cover(albumId)), placeholder);
    const strong = await add(
      store,
      library,
      albumId,
      new Uint8Array([...image, 2]),
      'strong',
    );
    for (const state of ['rejected', 'accepted', 'edited'] as const) {
      await store.candidates.setState(strong.id, state);
      assertEquals(await bytes(await artwork.cover(albumId)), placeholder);
    }
  });
});

Deno.test('real cover and first-track picture both beat the newest strong candidate', async () => {
  await setup(async (store, library, image, albumId) => {
    await add(store, library, albumId, new Uint8Array([...image, 3]), 'strong');
    await pictured(`${library.path}/Album/song.mp3`, image);
    const artwork = createArtwork(createLibrary(store));
    assertEquals(await bytes(await artwork.cover(albumId)), image);
    const local = new Uint8Array([...image, 4]);
    await Deno.writeFile(`${library.path}/Album/cover.jpg`, local);
    assertEquals(await bytes(await artwork.cover(albumId)), local);
  });
});

Deno.test('newest strong candidate wins and a missing image falls back to placeholder', async () => {
  await setup(async (store, library, image, albumId) => {
    await add(store, library, albumId, image, 'strong', 1);
    const latest = new Uint8Array([...image, 5]);
    const candidate = await add(store, library, albumId, latest, 'strong', 2);
    const artwork = createArtwork(createLibrary(store));
    assertEquals(await bytes(await artwork.cover(albumId)), latest);
    await Deno.remove(
      candidateImagePath(library, candidate.imageHash, candidate.imageExt),
    );
    assertEquals(
      await bytes(await artwork.cover(albumId)),
      await bytes(artwork.placeholder()),
    );
  });
});

Deno.test('candidate images are content-addressed, atomically shared once, and read back by hash', async () => {
  await setup(async (_store, library, image) => {
    const first = (await writeCandidateImage(library, image, 'JPEG'))!;
    assertEquals(first.ext, 'jpg');
    const path = candidateImagePath(library, first.hash, first.ext);
    await Deno.utime(path, 1, 1);
    const before = await Deno.stat(path);
    const results = await Promise.all(
      Array.from(
        { length: 10 },
        () => writeCandidateImage(library, image, 'jpg'),
      ),
    );
    assert(results.every((r) => r?.hash === first.hash));
    assertEquals((await Deno.stat(path)).mtime, before.mtime);
    assertEquals(
      await readCandidateImage(library, first.hash, first.ext),
      image,
    );
    const other = new Uint8Array([...image, 9]);
    const concurrent = await Promise.all(
      Array.from(
        { length: 10 },
        () => writeCandidateImage(library, other, 'png'),
      ),
    );
    assert(concurrent.every((r) => r?.hash === concurrent[0]!.hash));
    assertEquals(
      await readCandidateImage(library, concurrent[0]!.hash, 'png'),
      other,
    );
    assertEquals(
      Array.from(Deno.readDirSync(`${library.path}/.melofon/candidates`))
        .length,
      2,
    );
    assertEquals(
      await readCandidateImage(library, '0'.repeat(64), 'jpg'),
      null,
    );
  });
});

Deno.test('read-only library gets no candidate image or hidden directory', async () => {
  await setup(async (_store, library, image) => {
    await Deno.chmod(library.path, 0o555);
    try {
      assertEquals(await writeCandidateImage(library, image, 'jpg'), null);
      assertEquals(
        await Deno.stat(`${library.path}/.melofon`).then(
          () => true,
          () => false,
        ),
        false,
      );
    } finally {
      await Deno.chmod(library.path, 0o755);
    }
  });
});

Deno.test('existing candidate directory becoming read-only still refuses image writes', async () => {
  await setup(async (_store, library, image) => {
    const existing = (await writeCandidateImage(library, image, 'jpg'))!;
    const dir = `${library.path}/.melofon/candidates`;
    await Deno.chmod(dir, 0o555);
    try {
      assertEquals(
        await writeCandidateImage(
          library,
          new Uint8Array([...image, 7]),
          'jpg',
        ),
        null,
      );
      assertEquals(await writeCandidateImage(library, image, 'jpg'), null);
      assertEquals(Array.from(Deno.readDirSync(dir)).length, 1);
      assertEquals(
        await readCandidateImage(library, existing.hash, 'jpg'),
        image,
      );
    } finally {
      await Deno.chmod(dir, 0o755);
    }
  });
});

Deno.test('candidate image references cannot escape the library directory', async () => {
  await setup(async (_store, library, image) => {
    await assertRejects(() => readCandidateImage(library, '../outside', 'jpg'));
    await assertRejects(() =>
      writeCandidateImage(library, image, '../../outside')
    );
  });
});
