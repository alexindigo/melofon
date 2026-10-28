import { assert, assertEquals } from '@std/assert';
import { error } from './helpers/api.ts';
import { browseFixture } from './helpers/browse.ts';
import { createMedia } from '../src/media.ts';
import { rawSql } from '../src/store/testing.ts';

const base = '/api/v1';

Deno.test('API browse: regular cookie/Bearer library summaries omit admin paths', async () => {
  const f = await browseFixture();
  try {
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      const response = await f.get(`${base}/libraries`, credential, {
        Origin: 'http://foreign.home',
      });
      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(Object.keys(body), ['libraries']);
      const sources = await f.store.catalog.listLibraries();
      assertEquals(
        body.libraries,
        sources.map((source) => ({
          id: source.id,
          name: source.name,
          available: source.name !== 'Offline',
        })),
      );
      assertEquals(body.libraries.length, 3);
      assert(!JSON.stringify(body).includes(f.root));
    }
    const { credential } = await f.login('bearer');
    const summary = await f.get(`${base}/libraries`, credential);
    assertEquals(summary.status, 200);
    const { libraries } = await summary.json();
    const admin = await f.get(`${base}/admin/libraries`, credential);
    assertEquals(admin.status, 200);
    const detailed = (await admin.json()).libraries;
    assertEquals(
      detailed.map((library: { id: string }) => library.id),
      libraries.map((library: { id: string }) => library.id),
    );
    assert(
      detailed.every((library: { path: string }) =>
        library.path.startsWith(f.root)
      ),
    );
    assert(f.peers.every((peer) => peer !== '127.0.0.1' && peer !== '::1'));
  } finally {
    await f.close();
  }
});

Deno.test('API browse: song detail preserves indexed metadata and relative paths for both credentials', async () => {
  const f = await browseFixture();
  try {
    const song = f.songs.find((song) => song.title === 'Tagged Song')!;
    const details = (await createMedia().describeAudio(song.path))!;
    const expectedMetadata = {
      bitRate: details.audioBitrate! / 1000,
      bitDepth: details.audioBitdepth ?? null,
      sampleRate: details.audioSamplerate,
      channels: details.audioChannels,
      trackGain: null,
      trackPeak: null,
      albumGain: null,
      albumPeak: null,
      baseGain: null,
      recordingMbid: null,
      artistMbid: null,
      albumArtistMbid: null,
      isrc: ['USAAA1234567', 'USBBB1234567'],
      genres: ['Jazz', 'Fusion'],
      moods: ['Calm', 'Bright'],
      comment: null,
      sortTitle: 'Song Sort',
      artistSortName: 'Artist Sort',
      albumArtistSortName: 'Album Artist Sort',
      bpm: 123,
      explicit: null,
      discSubtitle: 'First disc',
      albumMbid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      recordLabels: ['Label One', 'Label Two'],
      releaseTypes: [],
      releaseDate: '2024-02-03',
      originalReleaseDate: '1999-04',
      compilation: true,
      version: null,
      albumSortName: 'Album Sort',
    };
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      const response = await f.get(`${base}/songs/${song.id}`, credential, {
        Origin: 'http://foreign.home',
      });
      assertEquals(response.status, 200, await response.clone().text());
      const body = await response.json();
      assertEquals(Object.keys(body), ['song']);
      assertEquals(body.song, {
        id: song.id,
        libraryId: song.libraryId,
        path: 'Album/CD1/01_Tagged.mp3',
        title: 'Tagged Song',
        fileName: '01_Tagged',
        label: 'Tagged Song',
        albumId: song.albumId,
        albumName: 'Album',
        albumFolderName: 'Album',
        albumLabel: 'Album',
        artistId: song.artistId,
        artistName: 'Shared Artist',
        artistLabel: 'Shared Artist',
        track: 3,
        disc: 1,
        durationMs: song.durationMs,
        size: (await Deno.stat(song.path)).size,
        genre: 'Jazz',
        year: 2024,
        firstSeenMs: song.firstSeenMs,
        isVideo: false,
        suffix: 'mp3',
        contentType: 'audio/mpeg',
        metadata: expectedMetadata,
      });
      assert(body.song.durationMs > 0);
      assert(
        body.song.firstSeenMs >= f.beforeScan &&
          body.song.firstSeenMs <= Date.now(),
      );
      assert(!JSON.stringify(body).includes(f.root));
    }
    const admin = await f.login('bearer');
    const response = await f.get(`${base}/songs/${song.id}`, admin.credential);
    assertEquals(response.status, 200);
    assertEquals((await response.json()).song.metadata, expectedMetadata);
  } finally {
    await f.close();
  }
});

Deno.test('API browse: null facts retain separate file/folder/artist labels without personal fields', async () => {
  const f = await browseFixture();
  try {
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      for (const song of f.songs) {
        const response = await f.get(`${base}/songs/${song.id}`, credential);
        assertEquals(response.status, 200);
        const { song: value } = await response.json();
        assertEquals(value.libraryId, song.libraryId);
        assertEquals(value.id, song.id);
        assert(!('libraryPath' in value));
        for (
          const field of [
            'starred',
            'userRating',
            'averageRating',
            'playCount',
            'played',
            'lastPlayed',
          ]
        ) {
          assert(!(field in value), field);
        }
        if (song.title === null) {
          assertEquals(value.path, 'Loose/no_title_here.mp3');
          assertEquals(value.title, null);
          assertEquals(value.label, '[no title here]');
          assertEquals(value.fileName, 'no_title_here');
          assertEquals(value.albumName, null);
          assertEquals(value.albumFolderName, 'Loose');
          assertEquals(value.albumLabel, '[Loose]');
          assertEquals(value.artistName, null);
          assertEquals(value.artistId, null);
          assertEquals(value.artistLabel, '[Unknown Artist]');
          assertEquals(value.genre, null);
          assertEquals(value.year, null);
          assertEquals(value.metadata.genres, []);
          assertEquals(value.metadata.sortTitle, null);
        }
      }
    }
  } finally {
    await f.close();
  }
});

Deno.test('API browse: auth precedence, missing songs, strict queries and admin mutation guards', async () => {
  const f = await browseFixture();
  try {
    const paths = [`${base}/libraries`, `${base}/songs/${f.songs[0].id}`];
    for (const path of paths) {
      await error(await f.get(path), 401, 'unauthenticated');
    }
    const cookie =
      (await f.login('cookie', 'listener', 'password-listener')).credential;
    const bearer =
      (await f.login('bearer', 'listener', 'password-listener')).credential;
    for (const path of paths) {
      for (
        const authorization of ['Bearer invalid', 'Basic invalid', 'Bearer', '']
      ) {
        await error(
          await f.get(path, cookie, { Authorization: authorization }),
          401,
          'unauthenticated',
        );
      }
      for (const credential of [cookie, bearer]) {
        for (const query of ['?unknown=1', '?limit=1&limit=2']) {
          await error(
            await f.get(path + query, credential),
            400,
            'invalid_field',
          );
        }
        const response = await f.json(path, 'POST', {}, credential);
        await error(response, 405, 'method_not_allowed');
        assertEquals(response.headers.get('allow'), 'GET');
      }
    }
    for (const credential of [cookie, bearer]) {
      await error(
        await f.get(`${base}/songs/absent-song`, credential),
        404,
        'not_found',
      );
      await error(
        await f.get(`${base}/admin/libraries`, credential),
        403,
        'forbidden',
      );
      const libraryId = f.songs[0].libraryId;
      await error(
        await f.get(`${base}/admin/libraries/${libraryId}`, credential),
        403,
        'forbidden',
      );
      for (
        const [path, method, body] of [
          [`${base}/admin/libraries`, 'POST', {
            name: 'Forbidden',
            path: f.root,
          }],
          [`${base}/admin/libraries/${libraryId}`, 'PATCH', {
            name: 'Forbidden',
          }],
          [`${base}/admin/libraries/${libraryId}`, 'DELETE', undefined],
        ] as const
      ) {
        await error(
          await f.json(path, method, body, credential),
          403,
          'forbidden',
        );
      }
    }
    assertEquals((await f.store.catalog.listLibraries()).length, 3);
  } finally {
    await f.close();
  }
});

Deno.test('API browse: unresolved and out-of-root song paths never disclose absolute paths', async () => {
  const f = await browseFixture();
  try {
    const { credential } = await f.login(
      'bearer',
      'listener',
      'password-listener',
    );
    const song = f.songs[0];
    // Permitted test seam: model legacy unresolved sources and inconsistent roots.
    for (
      const change of [
        'library_id = NULL',
        `library_id = '${song.libraryId}', path = '${f.root}/Music-sibling/outside.mp3'`,
        `path = '${f.root}/Music/../outside.mp3'`,
      ]
    ) {
      await rawSql(f.store).run(
        `UPDATE files SET ${change} WHERE id = '${song.id}'`,
      );
      const response = await f.get(`${base}/songs/${song.id}`, credential);
      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.song.path, null);
      assert(!('libraryPath' in body.song));
      assert(!JSON.stringify(body).includes(f.root));
    }
  } finally {
    await f.close();
  }
});
