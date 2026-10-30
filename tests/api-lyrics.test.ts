import { assert, assertEquals } from '@std/assert';
import { apiFixture, error } from './helpers/api.ts';
import { lyricMp3 } from './helpers/lyrics.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary, type SongRow } from '../src/library.ts';
import { createLyrics } from '../src/lyrics.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLookupRunner } from '../src/lookups/runner.ts';
import { eventually } from './helpers/lookup.ts';
import { lookupLyrics, lyricsLookupPlugin } from './helpers/lyrics-lookup.ts';

async function lyricsFixture(prepare: (root: string) => Promise<unknown>) {
  const root = await Deno.makeTempDir({ prefix: 'melofon-api-lyrics-' });
  let songs: SongRow[] = [];
  try {
    const f = await apiFixture({
      services: async (f) => {
        const libraries = createLibraries(f.store);
        await libraries.add('Music', root);
        await prepare(root);
        const lyrics = createLyrics(f.store, f.state);
        await scanLibrary(f.store, undefined, undefined, lyrics);
        const library = createLibrary(f.store, lyrics);
        songs = await library.listSongs({ offset: 0, size: 100 });
        return { library };
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

type Fixture = Awaited<ReturnType<typeof lyricsFixture>>;
const path = (id: string) => `/api/v1/songs/${id}/lyrics`;
async function credentials(f: Fixture) {
  return await Promise.all(
    (['cookie', 'bearer'] as const).map(async (use) =>
      (await f.login(use, 'listener', 'password-listener')).credential
    ),
  );
}
async function read(f: Fixture, credential: string, id = f.songs[0].id) {
  const response = await f.get(path(id), credential, {
    Origin: 'http://foreign.home',
    'If-None-Match': '*',
  });
  assertEquals(response.status, 200, await response.clone().text());
  assertEquals(response.headers.get('cache-control'), 'private, no-store');
  assertEquals(response.headers.get('etag'), null);
  const body = await response.json();
  assertEquals(Object.keys(body), ['lyrics']);
  assert(!JSON.stringify(body).includes(f.root));
  return body;
}

Deno.test('API lyrics: scanned embedded plain languages and duplicate variants beat every sidecar', async () => {
  const f = await lyricsFixture(async (root) => {
    await lyricMp3(`${root}/song.mp3`, [
      { lang: 'eng', text: 'First\nSecond' },
      { lang: 'rus', text: 'Привет 🌍' },
      { lang: 'eng', text: 'Another version' },
    ]);
    await Deno.writeTextFile(`${root}/song.elrc`, '[00:01.00]Sidecar');
    await Deno.writeTextFile(`${root}/song.lrc`, '[00:02.00]Other');
    await Deno.writeTextFile(`${root}/song.txt`, 'Plain sidecar');
  });
  try {
    const expected = {
      lyrics: [
        {
          language: 'eng',
          synced: false,
          lines: [{ text: 'First' }, { text: 'Second' }],
        },
        { language: 'rus', synced: false, lines: [{ text: 'Привет 🌍' }] },
        {
          language: 'eng',
          synced: false,
          lines: [{ text: 'Another version' }],
        },
      ],
    };
    for (const credential of await credentials(f)) {
      assertEquals(await read(f, credential), expected);
    }
    assertEquals(await read(f, (await f.login('bearer')).credential), expected);
    assert(f.peers.every((peer) => peer !== '127.0.0.1' && peer !== '::1'));
  } finally {
    await f.close();
  }
});

Deno.test('API lyrics: enhanced local cues preserve language, signed offset, repeats and UTF8 byte ranges', async () => {
  const f = await lyricsFixture(async (root) => {
    await lyricMp3(`${root}/song.mp3`);
    await Deno.writeTextFile(
      `${root}/song.elrc`,
      '[lang:rus]\n[ar:Исполнитель]\n[ti:Песня]\n[offset:-75]\n[00:01.00][00:03.00]<00:01.00>Привет <00:01.50>🌍<00:02.00>\n[00:04.00]\n[00:05.00]<00:05.00>Start <00:05.50>only',
    );
  });
  try {
    for (const credential of await credentials(f)) {
      const body = await read(f, credential);
      assertEquals(body, {
        lyrics: [{
          language: 'rus',
          synced: true,
          offset: -75,
          artist: 'Исполнитель',
          title: 'Песня',
          lines: [
            {
              start: 1000,
              text: 'Привет 🌍',
              cues: [
                {
                  start: 1000,
                  end: 1500,
                  text: 'Привет ',
                  byteStart: 0,
                  byteEnd: 12,
                },
                {
                  start: 1500,
                  end: 2000,
                  text: '🌍',
                  byteStart: 13,
                  byteEnd: 16,
                },
              ],
            },
            {
              start: 3000,
              text: 'Привет 🌍',
              cues: [
                {
                  start: 3000,
                  end: 3500,
                  text: 'Привет ',
                  byteStart: 0,
                  byteEnd: 12,
                },
                {
                  start: 3500,
                  end: 4000,
                  text: '🌍',
                  byteStart: 13,
                  byteEnd: 16,
                },
              ],
            },
            { start: 4000, text: '' },
            {
              start: 5000,
              text: 'Start only',
              cues: [
                { start: 5000, text: 'Start ', byteStart: 0, byteEnd: 5 },
                { start: 5500, text: 'only', byteStart: 6, byteEnd: 9 },
              ],
            },
          ],
        }],
      });
      for (const line of body.lyrics[0].lines) {
        const bytes = new TextEncoder().encode(line.text);
        for (const cue of line.cues ?? []) {
          assertEquals(
            new TextDecoder().decode(
              bytes.slice(cue.byteStart, cue.byteEnd + 1),
            ),
            cue.text,
          );
        }
      }
    }
  } finally {
    await f.close();
  }
});

Deno.test('API lyrics: scanned native SYLT exposes milliseconds and cues only for its supported timestamp format', async () => {
  const f = await lyricsFixture(async (root) => {
    for (const format of [1, 2]) {
      await lyricMp3(`${root}/${format}.mp3`, [{
        lang: 'rus',
        format,
        sylt: [
          { text: '\nПривет ', timestamp: 1000 },
          { text: '🌍', timestamp: 1500 },
          { text: '\nSecond', timestamp: 2000 },
        ],
      }]);
    }
  });
  try {
    for (const credential of await credentials(f)) {
      for (const song of f.songs) {
        const synced = song.fileName === '2';
        assertEquals(await read(f, credential, song.id), {
          lyrics: [{
            language: 'rus',
            synced,
            lines: synced
              ? [
                {
                  start: 1000,
                  text: 'Привет 🌍',
                  cues: [
                    { start: 1000, text: 'Привет ', byteStart: 0, byteEnd: 12 },
                    { start: 1500, text: '🌍', byteStart: 13, byteEnd: 16 },
                  ],
                },
                {
                  start: 2000,
                  text: 'Second',
                  cues: [
                    { start: 2000, text: 'Second', byteStart: 0, byteEnd: 5 },
                  ],
                },
              ]
              : [{ text: 'Привет 🌍' }, { text: 'Second' }],
          }],
        });
      }
    }
  } finally {
    await f.close();
  }
});

Deno.test('API lyrics: live sidecar priority, edits and deletion bypass catalog validators without scanning', async () => {
  const f = await lyricsFixture(async (root) => {
    await lyricMp3(`${root}/Song.mp3`);
    await Deno.writeTextFile(`${root}/song.elrc`, '[00:01.00]Wrong case stem');
    await Deno.writeTextFile(`${root}/Song.TXT`, '\ufeffPlain\r\n\r\nLast');
  });
  try {
    const auth = await credentials(f);
    const id = f.songs[0].id;
    const detail = await f.get(`/api/v1/songs/${id}`, auth[0]);
    const etag = detail.headers.get('etag')!;
    assert(etag);
    await detail.json();
    const expect = async (lyrics: unknown[]) => {
      for (const credential of auth) {
        assertEquals(await read(f, credential), { lyrics });
      }
      const response = await f.get(`/api/v1/songs/${id}`, auth[0], {
        'If-None-Match': etag,
      });
      assertEquals(response.status, 304);
      await response.text();
      const live = await f.get(path(id), auth[0], { 'If-None-Match': etag });
      assertEquals(live.status, 200);
      assertEquals(live.headers.get('cache-control'), 'private, no-store');
      assertEquals(await live.json(), { lyrics });
    };
    await expect([{
      language: 'xxx',
      synced: false,
      lines: [{ text: 'Plain' }, { text: '' }, { text: 'Last' }],
    }]);
    await Deno.writeTextFile(
      `${f.root}/Song.LRC`,
      '[lang:eng]\n[offset:125]\n[00:01.25]Synced',
    );
    await expect([{
      language: 'eng',
      synced: true,
      offset: 125,
      lines: [{ start: 1250, text: 'Synced' }],
    }]);
    await Deno.writeTextFile(`${f.root}/Song.ELRC`, '[00:02.00]Enhanced wins');
    await expect([{
      language: 'xxx',
      synced: true,
      lines: [{ start: 2000, text: 'Enhanced wins' }],
    }]);
    await Deno.writeTextFile(`${f.root}/Song.ELRC`, '[00:03.00]Edited');
    await expect([{
      language: 'xxx',
      synced: true,
      lines: [{ start: 3000, text: 'Edited' }],
    }]);
    for (const ext of ['ELRC', 'LRC', 'TXT']) {
      await Deno.remove(`${f.root}/Song.${ext}`);
    }
    await expect([]);
  } finally {
    await f.close();
  }
});

Deno.test('API lyrics: oversized embedded/sidecar and malformed sources fall through with live owner bounds', async () => {
  const f = await lyricsFixture(async (root) => {
    await lyricMp3(`${root}/song.mp3`, [{ text: 'x'.repeat(1048600) }]);
    await Deno.writeTextFile(
      `${root}/song.elrc`,
      '[00:01.00]<00:broken>Invalid',
    );
    await Deno.writeTextFile(
      `${root}/song.lrc`,
      '[00:01.00]' + 'x'.repeat(1048576),
    );
    await Deno.writeTextFile(`${root}/song.txt`, 'fallback');
  });
  try {
    const auth = await credentials(f);
    const expect = async (lyrics: unknown[]) => {
      for (const credential of auth) {
        assertEquals(await read(f, credential), { lyrics });
      }
    };
    const fallback = [{
      language: 'xxx',
      synced: false,
      lines: [{ text: 'fallback' }],
    }];
    await expect(fallback);
    await Deno.writeFile(`${f.root}/song.elrc`, new Uint8Array([255, 254, 1]));
    await expect(fallback);
    await f.state.set('lyrics.maxBytes', '8');
    await expect(fallback);
    await f.state.set('lyrics.maxBytes', '7');
    await expect([]);
  } finally {
    await f.close();
  }
});

Deno.test('API lyrics: known empty, unknown song, auth precedence, strict queries and methods', async () => {
  const f = await lyricsFixture((root) => lyricMp3(`${root}/song.mp3`));
  try {
    const endpoint = path(f.songs[0].id);
    await error(await f.get(endpoint), 401, 'unauthenticated');
    for (const credential of await credentials(f)) {
      assertEquals(await read(f, credential), { lyrics: [] });
      await error(
        await f.get(path('missing'), credential, { 'If-None-Match': '*' }),
        404,
        'not_found',
      );
      for (
        const query of [
          '?unknown=1',
          '?enhanced=true',
          '?language=eng',
          '?library=x',
          '?offset=0',
          '?x=1&x=2',
        ]
      ) {
        await error(
          await f.get(endpoint + query, credential),
          400,
          'invalid_field',
        );
      }
      const method = await f.json(endpoint, 'POST', {}, credential);
      assertEquals(method.headers.get('allow'), 'GET');
      await error(method, 405, 'method_not_allowed');
    }
    const cookie =
      (await f.login('cookie', 'listener', 'password-listener')).credential;
    await error(
      await f.get(endpoint, cookie, {
        Authorization: 'Bearer invalid',
        'If-None-Match': '*',
      }),
      401,
      'unauthenticated',
    );
  } finally {
    await f.close();
  }
});

Deno.test('API lyrics: acquired plugin candidates persist while embedded and sidecar lyrics retain precedence', async () => {
  const f = await lyricsFixture(async (root) => {
    await lyricMp3(`${root}/embedded.mp3`, [{
      lang: 'eng',
      text: 'Embedded wins',
    }]);
    await lyricMp3(`${root}/sidecar.mp3`);
    await Deno.writeTextFile(
      `${root}/sidecar.lrc`,
      '[lang:rus]\n[00:01.00]Sidecar wins',
    );
  });
  let runner: Awaited<ReturnType<typeof createLookupRunner>> | undefined;
  try {
    const builtin = `${f.root}/test-plugins`;
    await lyricsLookupPlugin(builtin);
    runner = await createLookupRunner({
      store: f.store,
      state: f.state,
      dataDir: f.cfg.dataDir,
      builtin,
    });
    const before = await Promise.all(f.songs.map((s) => Deno.readFile(s.path)));
    for (const song of f.songs) {
      await runner.request({ type: 'song', id: song.id }, 'all');
    }
    await eventually(async () =>
      (await f.store.lookups.stats('lyrics-fixture')).done === 2
    );
    for (const [i, song] of f.songs.entries()) {
      const [candidate] = await f.store.candidates.candidatesFor(
        'song',
        song.id,
      );
      assertEquals(candidate.source, 'lyrics-fixture');
      assertEquals(candidate.kind, 'lyrics');
      assertEquals(candidate.details.lyrics, {
        origin: 'https://provenance.invalid/song',
        entries: lookupLyrics,
      });
      const expected = song.fileName === 'embedded'
        ? { language: 'eng', synced: false, lines: [{ text: 'Embedded wins' }] }
        : {
          language: 'rus',
          synced: true,
          lines: [{ start: 1000, text: 'Sidecar wins' }],
        };
      for (const credential of await credentials(f)) {
        assertEquals(await read(f, credential, song.id), {
          lyrics: [expected],
        });
      }
      assertEquals(await Deno.readFile(song.path), before[i]);
    }
    assert(f.peers.every((peer) => peer !== '127.0.0.1' && peer !== '::1'));
  } finally {
    await runner?.close();
    await f.close();
  }
});
