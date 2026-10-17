import { assertEquals, assertNotEquals } from '@std/assert';
import { type AlbumInput, groupAlbums, stableId } from '../src/albums.ts';

function song(rel: string, overrides: Partial<AlbumInput> = {}): AlbumInput {
  return {
    songId: rel,
    libraryId: 'music',
    rel,
    albumName: 'Abbey Road',
    albumArtistTag: 'The Beatles',
    trackArtist: 'The Beatles',
    disc: null,
    ...overrides,
  };
}
const libraries = [{ id: 'music', name: 'Music' }];
const group = (
  files: AlbumInput[],
  previous = new Map<string, string | null>(),
  identities: { id: string; libraryId: string; rootDir: string }[] = [],
) => groupAlbums(files, libraries, previous, identities);

async function expect(files: AlbumInput[], expected: unknown[]) {
  const result = await group(files);
  assertEquals(
    result.albums.map((album) => ({
      root: album.rootDir,
      name: album.name,
      kind: album.artistKind,
      folder: album.folderName,
      songs: files.filter((f) => result.fileAlbums.get(f.songId) === album.id)
        .map((f) => f.rel).sort(),
    })),
    expected,
  );
  assertEquals(result.fileAlbums.size, files.length);
  return result;
}
const album = (
  root: string,
  songs: string[],
  folder = root.split('/').pop(),
  name: string | null = 'Abbey Road',
  kind = 'tagged',
) => ({ root, name, kind, folder, songs });

Deno.test('parts row 1: identically tagged editions stay separate', async () => {
  const a = 'Beatles/Abbey Road (2019)', b = 'Beatles/Abbey Road (vinyl)';
  await expect([song(`${a}/a.mp3`), song(`${b}/b.mp3`)], [
    album(a, [`${a}/a.mp3`]),
    album(b, [`${b}/b.mp3`]),
  ]);
});
Deno.test('parts row 2: sibling disjoint discs merge', async () => {
  await expect([
    song('Abbey Road/CD1/a.mp3', { disc: 1 }),
    song('Abbey Road/CD2/b.mp3', { disc: 2 }),
  ], [
    album('Abbey Road', ['Abbey Road/CD1/a.mp3', 'Abbey Road/CD2/b.mp3']),
  ]);
});
Deno.test('parts row 3: disc names alone never merge', async () => {
  await expect([song('Abbey Road/CD1/a.mp3'), song('Abbey Road/CD2/b.mp3')], [
    album('Abbey Road/CD1', ['Abbey Road/CD1/a.mp3'], 'Abbey Road'),
    album('Abbey Road/CD2', ['Abbey Road/CD2/b.mp3'], 'Abbey Road'),
  ]);
});
Deno.test('parts row 4: format copies with overlapping discs stay separate', async () => {
  await expect([
    song('Abbey Road/FLAC/a.mp3', { disc: 1 }),
    song('Abbey Road/MP3/b.mp3', { disc: 1 }),
  ], [
    album('Abbey Road/FLAC', ['Abbey Road/FLAC/a.mp3'], 'Abbey Road'),
    album('Abbey Road/MP3', ['Abbey Road/MP3/b.mp3'], 'Abbey Road'),
  ]);
});
Deno.test('parts row 5: one overlapping track prevents the whole merge', async () => {
  await expect([
    song('Abbey Road/CD1/a.mp3', { disc: 1 }),
    song('Abbey Road/CD2/b.mp3', { disc: 2 }),
    song('Abbey Road/CD2/c.mp3', { disc: 1 }),
  ], [
    album('Abbey Road/CD1', ['Abbey Road/CD1/a.mp3'], 'Abbey Road'),
    album(
      'Abbey Road/CD2',
      ['Abbey Road/CD2/b.mp3', 'Abbey Road/CD2/c.mp3'],
      'Abbey Road',
    ),
  ]);
});
Deno.test('parts row 6: untagged singles with ten artists form one album', async () => {
  const files = Array.from(
    { length: 10 },
    (_, i) =>
      song(`Singles/${i}.mp3`, {
        albumName: null,
        albumArtistTag: null,
        trackArtist: `Artist ${i}`,
      }),
  );
  await expect(files, [
    album('Singles', files.map((f) => f.rel), 'Singles', null, 'various'),
  ]);
});
Deno.test('parts row 7: tribute with fifteen artists is various', async () => {
  const files = Array.from(
    { length: 15 },
    (_, i) =>
      song(`Tribute/${i.toString().padStart(2, '0')}.mp3`, {
        albumArtistTag: null,
        trackArtist: `Artist ${i}`,
      }),
  );
  await expect(files, [
    album(
      'Tribute',
      files.map((f) => f.rel),
      'Tribute',
      'Abbey Road',
      'various',
    ),
  ]);
});
Deno.test('parts row 8: no album tag and one track artist is shared', async () => {
  const result = await expect([
    song('Abbey Road/a.mp3', { albumName: null, albumArtistTag: null }),
  ], [album('Abbey Road', ['Abbey Road/a.mp3'], 'Abbey Road', null, 'shared')]);
  assertEquals(result.albums[0].artistName, 'The Beatles');
});
Deno.test('parts row 9: no tags is unknown', async () => {
  const result = await expect([
    song('Mystery/a.mp3', {
      albumName: null,
      albumArtistTag: null,
      trackArtist: null,
    }),
  ], [album('Mystery', ['Mystery/a.mp3'], 'Mystery', null, 'unknown')]);
  assertEquals(result.albums[0].artistName, null);
});
Deno.test('parts row 10: flat greatest hits separates tagged album artists', async () => {
  const result = await group([
    song('Flat/a.mp3', { albumName: 'Greatest Hits', albumArtistTag: 'A' }),
    song('Flat/b.mp3', { albumName: 'Greatest Hits', albumArtistTag: 'B' }),
  ]);
  assertEquals(
    result.albums.map((
      a,
    ) => [a.rootDir, a.name, a.artistKind, a.folderName, a.artistName]),
    [['Flat', 'Greatest Hits', 'tagged', 'Flat', 'A'], [
      'Flat',
      'Greatest Hits',
      'tagged',
      'Flat',
      'B',
    ]],
  );
  assertNotEquals(
    result.fileAlbums.get('Flat/a.mp3'),
    result.fileAlbums.get('Flat/b.mp3'),
  );
});
Deno.test('parts row 11: flat greatest hits without album artists groups performers', async () => {
  await expect([
    song('Flat/a.mp3', {
      albumName: 'Greatest Hits',
      albumArtistTag: null,
      trackArtist: 'A',
    }),
    song('Flat/b.mp3', {
      albumName: 'Greatest Hits',
      albumArtistTag: null,
      trackArtist: 'B',
    }),
  ], [
    album(
      'Flat',
      ['Flat/a.mp3', 'Flat/b.mp3'],
      'Flat',
      'Greatest Hits',
      'various',
    ),
  ]);
});
Deno.test('parts row 12: root files form albums by tag key and use library name', async () => {
  await expect([song('a.mp3'), song('b.mp3', { albumName: null })], [
    album('', ['a.mp3'], 'Music'),
    album('', ['b.mp3'], 'Music', null),
  ]);
});
Deno.test('parts row 13: literal Various Artists is a tagged real artist', async () => {
  const result = await expect([
    song('VA/a.mp3', { albumArtistTag: 'Various Artists' }),
  ], [album('VA', ['VA/a.mp3'])]);
  assertEquals(result.albums[0].artistName, 'Various Artists');
});
Deno.test('parts row 14: whole-leaf disc and format hints only affect folder name', async () => {
  for (
    const leaf of [
      'CD1',
      'Disc 2 - Bonus',
      'Part-1',
      'Vol. 3',
      'FLAC',
      'mp3 320',
      'FLAC 24-96',
      '24bit',
    ]
  ) {
    await expect([song(`Album/${leaf}/a.mp3`)], [
      album(`Album/${leaf}`, [`Album/${leaf}/a.mp3`], 'Album'),
    ]);
    await expect([song(`${leaf}/a.mp3`)], [
      album(leaf, [`${leaf}/a.mp3`], 'Music'),
    ]);
  }
  for (const leaf of ['Partisan', '2019', '320', 'Hi-Res']) {
    await expect([song(`Album/${leaf}/a.mp3`)], [
      album(`Album/${leaf}`, [`Album/${leaf}/a.mp3`], leaf),
    ]);
  }
});

const old = (id = 'old', rootDir = 'Album') => ({
  id,
  libraryId: 'music',
  rootDir,
});
const numbered = (
  dir: string,
  start: number,
  count: number,
  disc: number | null = null,
) =>
  Array.from(
    { length: count },
    (_, i) => song(`${dir}/${start + i}.mp3`, { songId: `${start + i}`, disc }),
  );
const previous = (files: AlbumInput[], id = 'old') =>
  new Map(files.map((f) => [f.songId, id]));

Deno.test('identity row 1: same grouping keeps all ids without events', async () => {
  const files = numbered('Album', 0, 3);
  const result = await group(files, previous(files), [old()]);
  assertEquals(result.albums.map((a) => a.id), ['old']);
  assertEquals(result.events, []);
});
Deno.test('identity row 2: directory move keeps id and emits moved', async () => {
  const files = numbered('Moved', 0, 3);
  const result = await group(files, previous(files), [old()]);
  assertEquals(result.albums[0].id, 'old');
  assertEquals(result.events, [{
    kind: 'moved',
    albumId: 'old',
    from: old(),
    to: old('old', 'Moved'),
  }]);
});
Deno.test('identity row 3: tag rename keeps id without moved', async () => {
  const files = numbered('Album', 0, 3).map((f) => ({
    ...f,
    albumName: 'Corrected',
  }));
  const result = await group(files, previous(files), [old()]);
  assertEquals(result.albums[0].id, 'old');
  assertEquals(result.events, []);
});
Deno.test('identity row 4: 15/2 split keeps majority id without event', async () => {
  const files = [...numbered('Large', 0, 15), ...numbered('Small', 15, 2)];
  const result = await group(files, previous(files));
  assertEquals(result.albums[0].id, 'old');
  assertNotEquals(result.albums[1].id, 'old');
  assertEquals(result.events, []);
});
Deno.test('identity row 5: 17/17 split gets two new ids and one unlinked', async () => {
  const files = [...numbered('CD', 0, 17), ...numbered('Vinyl', 17, 17)];
  const result = await group(files, previous(files));
  assertEquals(result.albums.every((a) => a.id !== 'old'), true);
  assertEquals(result.events, [{
    kind: 'unlinked',
    albumId: 'old',
    candidates: result.albums.map((a) => a.id).sort(),
  }]);
});
Deno.test('identity row 6: 8+9 disc merge keeps nine id and unlinks eight', async () => {
  const a = numbered('Album/CD1', 0, 8, 1), b = numbered('Album/CD2', 8, 9, 2);
  const result = await group(
    [...a, ...b],
    new Map([...previous(a, 'eight'), ...previous(b, 'nine')]),
  );
  assertEquals(result.albums.map((a) => a.id), ['nine']);
  assertEquals(result.events, [{
    kind: 'unlinked',
    albumId: 'eight',
    candidates: ['nine'],
  }]);
});
Deno.test('identity row 7: new songs use deterministic directory and tag key', async () => {
  const files = numbered('Album', 0, 3);
  const result = await group(files);
  assertEquals(
    result.albums[0].id,
    await stableId(
      'album',
      JSON.stringify(['music', 'Album', 'Abbey Road', 'The Beatles']),
    ),
  );
  assertEquals(await group([...files].reverse()), result);
});
Deno.test('identity row 8: reserved id collisions use numbered suffix', async () => {
  const key = JSON.stringify(['music', 'Album', 'Abbey Road', 'The Beatles']);
  const id = await stableId('album', key);
  const result = await group(numbered('Album', 0, 1), new Map(), [
    old(id, 'Absent'),
  ]);
  assertEquals(result.albums[0].id, await stableId('album', `${key}\n1`));
});
Deno.test('identity row 9: absent then returning uses retained previous song album', async () => {
  assertEquals((await group([], new Map(), [old()])).albums, []);
  const files = numbered('Album', 0, 2);
  const result = await group(files, previous(files), [old()]);
  assertEquals(result.albums[0].id, 'old');
  assertEquals(result.events, []);
});

Deno.test('parts: music folders never merge and same-root multipart keys have deterministic collision order', async () => {
  const files = [
    song('Album/a.mp3'),
    song('Album/CD1/b.mp3', { disc: 1 }),
    song('Album/CD2/c.mp3', { disc: 2 }),
    song('Album/d.mp3', { libraryId: 'other', songId: 'other' }),
  ];
  const libs = [...libraries, { id: 'other', name: 'Other' }];
  const result = await groupAlbums(files, libs, new Map(), []);
  assertEquals(result.albums.length, 3);
  assertEquals(new Set(result.albums.map((a) => a.id)).size, 3);
  assertEquals(
    await groupAlbums([...files].reverse(), libs, new Map(), []),
    result,
  );
  assertEquals(
    result.albums.map((
      a,
    ) => [a.libraryId, a.rootDir, a.folderName, a.name, a.artistKind]),
    [['music', 'Album', 'Album', 'Abbey Road', 'tagged'], [
      'music',
      'Album',
      'Album',
      'Abbey Road',
      'tagged',
    ], ['other', 'Album', 'Album', 'Abbey Road', 'tagged']],
  );
});
