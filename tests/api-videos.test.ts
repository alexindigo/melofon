import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { Demuxer, Dictionary, Muxer } from 'node-av';
import { apiFixture, error } from './helpers/api.ts';
import { tagged } from './helpers/tagged.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary, type SongRow } from '../src/library.ts';
import { scanLibrary } from '../src/scan.ts';
import { rawSql } from '../src/store/testing.ts';

const base = '/api/v1/videos';
const clip =
  'tests/fixtures/library/Fixture Artist/Fixture Album/03 - Clip.mp4';
const srt = '1\n00:00:00,125 --> 00:00:01,625\nHello\n\n';

// Real container streams, using the same remuxing pattern as video-info.test.ts.
async function multitrack(root: string) {
  await Deno.writeTextFile(`${root}/embedded.srt`, srt);
  await using input = await Demuxer.open(clip);
  await using sub = await Demuxer.open(`${root}/embedded.srt`);
  await using output = await Muxer.open(`${root}/Music/z-clip.mkv`, {
    format: 'matroska',
    // Omit input: otherwise Muxer copies Clip's container title into every file.
    configure(ctx) {
      for (const stream of ctx.streams) stream.codecpar.codecTag = 0;
      for (
        const [i, tags] of [
          [1, { language: 'eng', title: 'English & original' }],
          [2, { language: 'fra', title: 'French' }],
          [3, { language: 'eng', title: 'Embedded' }],
        ] as const
      ) {
        using dictionary = Dictionary.fromObject(tags);
        ctx.streams[i].metadata = dictionary;
      }
    },
  });
  const video = output.addStream(input.video()!);
  const audio1 = output.addStream(input.audio()!);
  const audio2 = output.addStream(input.audio()!);
  const subtitle = output.addStream(sub.streams[0]);
  for await (const packet of input.packets()) {
    if (!packet) continue;
    try {
      if (packet.streamIndex === input.video()!.index) {
        await output.writePacket(packet, video);
      } else if (packet.streamIndex === input.audio()!.index) {
        using copy = packet.clone();
        await output.writePacket(packet, audio1);
        await output.writePacket(copy, audio2);
      }
    } finally {
      packet.free();
    }
  }
  for await (const packet of sub.packets()) {
    if (!packet) continue;
    try {
      await output.writePacket(packet, subtitle);
    } finally {
      packet.free();
    }
  }
  await output.close();
}

async function videoFixture() {
  const root = await Deno.makeTempDir({ prefix: 'melofon-api-videos-' });
  let songs: SongRow[] = [];
  try {
    const f = await apiFixture({
      services: async (f) => {
        const libraries = createLibraries(f.store, { notify: f.notify });
        for (const name of ['Music', 'Second', 'Empty']) {
          await Deno.mkdir(`${root}/${name}`);
          await libraries.add(name, `${root}/${name}`);
        }
        await multitrack(root);
        await Deno.writeTextFile(`${root}/Music/z-clip.en.srt`, srt);
        await Deno.writeTextFile(`${root}/Music/z-clip.fr.vtt`, 'WEBVTT\n\n');
        await Deno.writeTextFile(`${root}/Music/unrelated.srt`, srt);
        // No title in these remuxed files: name order uses the factual basename.
        await Deno.copyFile(
          `${root}/Music/z-clip.mkv`,
          `${root}/Music/ELAN.mkv`,
        );
        await Deno.copyFile(
          `${root}/Music/z-clip.mkv`,
          `${root}/Second/élan.mkv`,
        );
        await Deno.copyFile(
          `${root}/Music/z-clip.mkv`,
          `${root}/Music/alpha.mkv`,
        );
        await tagged(`${root}/Music/audio.mp3`, {
          TIT2: 'Audio is not a video',
        });
        await scanLibrary(f.store);
        const library = createLibrary(f.store);
        songs = await library.listSongs({ offset: 0, size: 100 });
        assertEquals(songs.length, 5);
        assert(songs.filter((s) => s.isVideo).every((s) => s.title === null));
        return { libraries, library };
      },
    });
    await f.auth.users.create(f.admin.id, {
      username: 'listener',
      password: 'password-listener',
      role: 'user',
    });
    return {
      ...f,
      root,
      songs,
      libraries: await f.store.catalog.listLibraries(),
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

type Fixture = Awaited<ReturnType<typeof videoFixture>>;
const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
const byId = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : 1;
async function read(f: Fixture, credential: string, path = base) {
  const response = await f.get(path, credential, {
    Origin: 'http://foreign.home',
  });
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json();
}

Deno.test('API videos: bounded folded-name/id pages contain only videos and share song identities', async () => {
  const f = await videoFixture();
  try {
    const expected = [
      f.songs.find((s) => s.fileName === 'alpha')!,
      ...f.songs.filter((s) => ['ELAN', 'élan'].includes(s.fileName)).sort(
        byId,
      ),
      f.songs.find((s) => s.fileName === 'z-clip')!,
    ];
    let common;
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      const all = await read(f, credential);
      assertEquals(Object.keys(all).sort(), [
        'limit',
        'offset',
        'total',
        'videos',
      ]);
      assertEquals([all.total, all.offset, all.limit], [4, 0, 50]);
      assertEquals(ids(all.videos), ids(expected));
      if (common) assertEquals(all, common);
      common = all;
      const joined = [];
      for (const offset of [0, 1, 2, 3, 4, 100]) {
        const page = await read(
          f,
          credential,
          `${base}?offset=${offset}&limit=1`,
        );
        assertEquals([page.total, page.offset, page.limit], [4, offset, 1]);
        assertEquals(ids(page.videos), ids(expected.slice(offset, offset + 1)));
        joined.push(...page.videos);
      }
      assertEquals(joined, all.videos);
      for (const library of f.libraries) {
        const eligible = expected.filter((s) => s.libraryId === library.id);
        const page = await read(
          f,
          credential,
          `${base}?library=${library.id}&limit=1`,
        );
        assertEquals([page.total, ids(page.videos)], [
          eligible.length,
          ids(eligible.slice(0, 1)),
        ]);
        const end = await read(
          f,
          credential,
          `${base}?library=${library.id}&offset=100`,
        );
        assertEquals([end.total, end.videos], [eligible.length, []]);
      }
      for (const video of all.videos) {
        assertEquals(video.isVideo, true);
        assertEquals(video.title, null);
        assertEquals(video.label, `[${video.fileName}]`);
        assertEquals(video.path, `${video.fileName}.mkv`);
        assertEquals(
          (await read(f, credential, `/api/v1/songs/${video.id}`)).song,
          video,
        );
        assert(!JSON.stringify(video).includes(f.root));
        for (
          const key of [
            'libraryPath',
            'starred',
            'userRating',
            'averageRating',
            'playCount',
            'played',
            'lastPlayed',
          ]
        ) {
          assert(!(key in video), key);
        }
      }
    }
    assertEquals(await read(f, (await f.login('bearer')).credential), common);
    assert(f.peers.every((peer) => peer !== '127.0.0.1' && peer !== '::1'));
    // Legacy videos() keeps its historical unpaged physical-path order.
    assertEquals(
      ids(await f.store.catalog.videos()),
      ids(f.songs.filter((s) => s.isVideo)),
    );
    assertEquals(
      ids((await f.store.catalog.videosPage({ offset: 0, limit: 50 })).rows),
      ids(
        [...expected].sort((a, b) =>
          a.fileName < b.fileName
            ? -1
            : a.fileName > b.fileName
            ? 1
            : byId(a, b)
        ),
      ),
    );
  } finally {
    await f.close();
  }
});

Deno.test('API videos: scanned audio/subtitle metadata and caption keys survive safe detail projection', async () => {
  const f = await videoFixture();
  try {
    const video = f.songs.find((s) => s.fileName === 'z-clip')!;
    const internal = await f.store.catalog.videoDetails(video.id);
    assert(internal?.captions.some((c) => c.file?.startsWith(f.root)));
    const expected = {
      audio: [
        {
          index: 1,
          codec: 'aac',
          language: 'eng',
          title: 'English & original',
          channels: 1,
        },
        {
          index: 2,
          codec: 'aac',
          language: 'fra',
          title: 'French',
          channels: 1,
        },
      ],
      subtitles: [{
        index: 3,
        codec: 'subrip',
        language: 'eng',
        title: 'Embedded',
      }],
      captions: [
        { key: 'sidecar:z-clip.en.srt', name: 'en', format: 'srt' },
        { key: 'sidecar:z-clip.fr.vtt', name: 'fr', format: 'vtt' },
        { key: 'stream:3', name: 'Embedded', format: 'srt', stream: 3 },
      ],
    };
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      const body = await read(f, credential, `${base}/${video.id}`);
      assertEquals(Object.keys(body), ['video']);
      const { details, ...song } = body.video;
      assertEquals(details, expected);
      assertEquals(
        song,
        (await read(f, credential, `/api/v1/songs/${video.id}`)).song,
      );
      assert(!JSON.stringify(body).includes(f.root));
      for (const caption of details.captions) assert(!('file' in caption));
      assertEquals(
        await read(
          f,
          credential,
          `${base}/${video.id}?library=${video.libraryId}`,
        ),
        body,
      );
      const second = f.libraries.find((l) => l.name === 'Second')!;
      await error(
        await f.get(`${base}/${video.id}?library=${second.id}`, credential),
        404,
        'not_found',
      );
      const audio = f.songs.find((s) => !s.isVideo)!;
      for (const id of [audio.id, 'missing']) {
        await error(
          await f.get(`${base}/${id}`, credential, { 'If-None-Match': '*' }),
          404,
          'not_found',
        );
      }
    }
    // Existing installs can have a video with no acquired stream facts. Unknown
    // facts remain null rather than pretending the file has zero streams.
    await rawSql(f.store).run(
      `UPDATE files SET video_details = NULL WHERE id = '${video.id}'`,
    );
    const { credential } = await f.login('bearer');
    const legacy = (await read(f, credential, `${base}/${video.id}`)).video;
    assertEquals([legacy.id, legacy.isVideo, legacy.details], [
      video.id,
      true,
      null,
    ]);
  } finally {
    await f.close();
  }
});

Deno.test('API videos: conditional pages/details use indexed revisions and refresh after caption scan and removal', async () => {
  const f = await videoFixture();
  try {
    const video = f.songs.find((s) => s.fileName === 'z-clip')!;
    const credentials = await Promise.all(
      (['cookie', 'bearer'] as const).map(async (use) =>
        (await f.login(use, 'listener', 'password-listener')).credential
      ),
    );
    const paths = [
      base,
      `${base}?limit=1`,
      `${base}?offset=1`,
      `${base}?library=${video.libraryId}`,
      `${base}/${video.id}`,
    ];
    const tags = new Map<string, string>();
    for (const path of paths) {
      for (const credential of credentials) {
        const response = await f.get(path, credential);
        assertEquals(response.status, 200);
        const etag = response.headers.get('etag')!;
        assert(etag.startsWith('W/"'));
        assertEquals(
          response.headers.get('cache-control'),
          'private, no-cache',
        );
        await response.json();
        if (tags.has(path)) assertEquals(tags.get(path), etag);
        tags.set(path, etag);
        const same = await f.get(path, credential, { 'If-None-Match': etag });
        assertEquals(same.status, 304);
        assertEquals(await same.text(), '');
        assertEquals(same.headers.get('etag'), etag);
        assertEquals(same.headers.get('cache-control'), 'private, no-cache');
      }
    }
    assertEquals(new Set(tags.values()).size, paths.length);
    const canonical = await f.get(
      `${base}?offset=0&limit=50&sort=name`,
      credentials[0],
      { 'If-None-Match': tags.get(base)! },
    );
    assertEquals(canonical.status, 304);
    await canonical.text();
    await error(
      await f.get(base, undefined, { 'If-None-Match': '*' }),
      401,
      'unauthenticated',
    );
    await Deno.writeTextFile(`${f.root}/Music/z-clip.de.srt`, srt);
    await scanLibrary(f.store);
    for (const credential of credentials) {
      const response = await f.get(`${base}/${video.id}`, credential, {
        'If-None-Match': tags.get(`${base}/${video.id}`)!,
      });
      assertEquals(response.status, 200);
      assertNotEquals(
        response.headers.get('etag'),
        tags.get(`${base}/${video.id}`),
      );
      assertEquals(
        (await response.json()).video.details.captions.map((
          c: { key: string },
        ) => c.key),
        [
          'sidecar:z-clip.de.srt',
          'sidecar:z-clip.en.srt',
          'sidecar:z-clip.fr.vtt',
          'stream:3',
        ],
      );
    }
    await Deno.remove(`${f.root}/Music/z-clip.mkv`);
    await scanLibrary(f.store);
    for (const credential of credentials) {
      const response = await f.get(base, credential, {
        'If-None-Match': tags.get(base)!,
      });
      assertEquals(response.status, 200);
      assertNotEquals(response.headers.get('etag'), tags.get(base));
      assertEquals((await response.json()).total, 3);
      await error(
        await f.get(`${base}/${video.id}`, credential, {
          'If-None-Match': '*',
        }),
        404,
        'not_found',
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test('API videos: auth, strict scoped name paging, methods and live bounds precede conditional reads', async () => {
  const f = await videoFixture();
  try {
    const video = f.songs.find((s) => s.isVideo)!;
    await error(await f.get(base), 401, 'unauthenticated');
    await error(await f.get(`${base}/${video.id}`), 401, 'unauthenticated');
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      for (
        const query of [
          '?unknown=1',
          '?limit=1&limit=2',
          '?sort=name&sort=name',
          '?limit=0',
          '?limit=501',
          '?limit=-1',
          '?offset=1.5',
          '?offset=9007199254740992',
          '?library=',
          '?sort=random',
          '?sort=-name',
          '?genre=Jazz',
          '?seed=x',
        ]
      ) {
        await error(
          await f.get(base + query, credential, { 'If-None-Match': '*' }),
          400,
          'invalid_field',
        );
      }
      for (const query of ['?offset=0', '?library=', '?library=x&library=x']) {
        await error(
          await f.get(`${base}/${video.id}${query}`, credential),
          400,
          'invalid_field',
        );
      }
      for (const path of [base, `${base}/${video.id}`]) {
        await error(
          await f.get(`${path}?library=missing`, credential, {
            'If-None-Match': '*',
          }),
          404,
          'not_found',
        );
        const method = await f.json(path, 'POST', {}, credential);
        assertEquals(method.headers.get('allow'), 'GET');
        await error(method, 405, 'method_not_allowed');
      }
    }
    const cookie =
      (await f.login('cookie', 'listener', 'password-listener')).credential;
    for (const path of [base, `${base}/${video.id}`]) {
      await error(
        await f.get(path, cookie, {
          Authorization: 'Bearer invalid',
          'If-None-Match': '*',
        }),
        401,
        'unauthenticated',
      );
    }
    await f.state.set('melofon.browseMaxPageRecords', '2');
    assertEquals((await read(f, cookie)).limit, 2);
    await error(await f.get(`${base}?limit=3`, cookie), 400, 'invalid_field');
  } finally {
    await f.close();
  }
});

Deno.test('API videos: empty catalog returns exact past-end page envelopes for both credentials', async () => {
  const f = await apiFixture({
    services: (f) => Promise.resolve({ library: createLibrary(f.store) }),
  });
  try {
    await f.auth.users.create(f.admin.id, {
      username: 'listener',
      password: 'password-listener',
      role: 'user',
    });
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      const response = await f.get(`${base}?offset=100&limit=1`, credential, {
        Origin: 'http://foreign.home',
      });
      assertEquals(response.status, 200);
      assertEquals(await response.json(), {
        videos: [],
        total: 0,
        offset: 100,
        limit: 1,
      });
      await error(await f.get(`${base}/missing`, credential), 404, 'not_found');
    }
  } finally {
    await f.close();
  }
});
