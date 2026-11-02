import { assert, assertEquals } from '@std/assert';
import { apiFixture, error } from './helpers/api.ts';
import { lyricMp3 } from './helpers/lyrics.ts';
import { lookupLyrics, lyricsLookupPlugin } from './helpers/lyrics-lookup.ts';
import { eventually } from './helpers/lookup.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary, type SongRow } from '../src/library.ts';
import { createLyrics, type LyricsEntry } from '../src/lyrics.ts';
import { createScan, scanLibrary } from '../src/scan.ts';
import { createLookupRunner } from '../src/lookups/runner.ts';

async function fixture(prepare?: (root: string) => Promise<void>) {
  const root = await Deno.makeTempDir({ prefix: 'api-lyrics-fallback-' });
  let songs: SongRow[] = [];
  let runner: Awaited<ReturnType<typeof createLookupRunner>> | undefined;
  try {
    const f = await apiFixture({
      allLayers: true,
      services: async (f) => {
        await createLibraries(f.store).add('Music', root);
        await lyricMp3(`${root}/song.mp3`);
        await prepare?.(root);
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
      async start(
        lyrics = lookupLyrics,
        ids = ['lyrics-fixture'],
        secondLyrics = lyrics,
      ) {
        const builtin = `${root}/.plugins`;
        for (const id of ids) {
          await lyricsLookupPlugin(
            builtin,
            id,
            [],
            id === 'second' ? secondLyrics : lyrics,
          );
        }
        runner = await createLookupRunner({
          store: f.store,
          state: f.state,
          dataDir: f.cfg.dataDir,
          builtin,
          notify: f.notify,
        });
        return runner;
      },
      async close() {
        await runner?.close();
        await f.close();
        await Deno.remove(root, { recursive: true });
      },
    };
  } catch (error) {
    await runner?.close();
    await Deno.remove(root, { recursive: true });
    throw error;
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const path = (id: string) => `/api/v1/songs/${id}/lyrics`;
async function credentials(f: Pick<Fixture, 'login'>) {
  return await Promise.all(
    (['cookie', 'bearer'] as const).map(async (use) =>
      (await f.login(use, 'listener', 'password-listener')).credential
    ),
  );
}
async function native(f: Pick<Fixture, 'get'>, id: string, auth: string[]) {
  const values = [];
  for (const credential of auth) {
    const response = await f.get(path(id), credential, {
      Origin: 'http://foreign.home',
      'If-None-Match': '*',
    });
    assertEquals(response.status, 200, await response.clone().text());
    assertEquals(response.headers.get('cache-control'), 'private, no-store');
    assertEquals(response.headers.get('etag'), null);
    const body = await response.json();
    assertEquals(Object.keys(body), ['lyrics']);
    values.push(body.lyrics);
  }
  return values;
}
async function rest(
  f: Fixture,
  op: string,
  params: Record<string, string>,
  xml = false,
) {
  const query = new URLSearchParams({
    u: 'listener',
    p: 'password-listener',
    v: '1.16.1',
    c: 'a17',
    ...(!xml ? { f: 'json' } : {}),
    ...params,
  });
  const response = await f.get(`/rest/${op}?${query}`);
  assertEquals(response.status, 200);
  if (xml) return await response.text();
  const body = (await response.json())['subsonic-response'];
  assertEquals(body.status, 'ok', JSON.stringify(body));
  return body;
}

Deno.test('API lyrics fallback: real scan notification acquires a whole plugin candidate consumed by both hats and after reopen', async () => {
  const f = await fixture(async (root) => {
    await Deno.writeTextFile(`${root}/song.elrc`, '[00:01.00]<00:broken>bad');
    await Deno.writeTextFile(
      `${root}/song.lrc`,
      '[00:01.00]' + 'x'.repeat(1048576),
    );
    await Deno.writeFile(`${root}/song.txt`, new Uint8Array([255, 254, 1]));
  });
  try {
    const id = f.songs[0].id, auth = await credentials(f);
    assertEquals(await native(f, id, auth), [[], []]);
    await error(await f.get(path(id)), 401, 'unauthenticated');
    const before = await Deno.readFile(f.songs[0].path);
    const runner = await f.start();
    const scan = createScan(f.store, undefined, {
      notify: f.notify,
      state: f.state,
    });
    await scan.run();
    await eventually(async () =>
      (await f.store.lookups.stats('lyrics-fixture')).done === 1
    );
    assertEquals(await native(f, id, auth), [lookupLyrics, lookupLyrics]);
    const [candidate] = await f.store.candidates.candidatesFor('song', id);
    assertEquals(candidate.source, 'lyrics-fixture');
    assertEquals(candidate.details.lyrics, {
      origin: candidate.origin,
      entries: lookupLyrics,
    });
    const v1 = await rest(f, 'getLyricsBySongId', { id });
    assertEquals(
      v1.lyricsList.structuredLyrics.map((entry: { lang: string }) =>
        entry.lang
      ),
      ['eng', 'rus', 'eng'],
    );
    assertEquals(v1.lyricsList.structuredLyrics[1], {
      lang: 'rus',
      synced: true,
      offset: -75,
      displayArtist: 'Исполнитель',
      displayTitle: 'Песня',
      line: [{ start: 1000, value: 'Привет 🌍' }],
    });
    assertEquals(
      (await rest(f, 'getLyrics', { artist: 'Artist', title: 'Song' })).lyrics,
      {
        artist: 'Artist',
        title: 'Song',
        value: 'Online plain',
      },
    );
    await scan.run();
    await runner.afterScan();
    assertEquals(await f.store.lookups.stats('lyrics-fixture'), {
      done: 1,
      active: 0,
      waiting: 0,
      failed: 0,
    });
    assertEquals(await Deno.readFile(f.songs[0].path), before);
    assert(f.peers.every((peer) => peer !== '127.0.0.1' && peer !== '::1'));
    await runner.close();
    await f.store.close();
    const reopened = await apiFixture({
      storeDir: f.cfg.dataDir,
      services: (g) =>
        Promise.resolve({
          library: createLibrary(g.store, createLyrics(g.store, g.state)),
        }),
    });
    try {
      assertEquals(await native(reopened, id, await credentials(reopened)), [
        lookupLyrics,
        lookupLyrics,
      ]);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

Deno.test('API lyrics fallback: only the newest strong open source wins whole; decisions, live locals and bounds remain authoritative', async () => {
  const f = await fixture();
  try {
    const id = f.songs[0].id, auth = await credentials(f);
    await f.state.set('lookups.plugin.second.enabled', 'false');
    const second: LyricsEntry[] = [{
      language: 'fra',
      synced: false,
      lines: [{ text: 'One different source, no other variants' }],
    }];
    const runner = await f.start(
      lookupLyrics,
      ['lyrics-fixture', 'second'],
      second,
    );
    const expect = async (entries: LyricsEntry[]) =>
      assertEquals(await native(f, id, auth), [entries, entries]);
    for (const confidence of ['medium', 'low']) {
      await f.state.set(
        'lookups.plugin.lyrics-fixture.settings.confidence',
        confidence,
      );
      await f.state.set(
        'lookups.plugin.lyrics-fixture.settings.shift',
        confidence === 'medium' ? '1' : '2',
      );
      await runner.request({ type: 'song', id }, 'all');
      await eventually(async () =>
        (await f.store.lookups.stats('lyrics-fixture')).done ===
          (confidence === 'medium' ? 1 : 2)
      );
      await expect([]);
    }
    await f.state.set(
      'lookups.plugin.lyrics-fixture.settings.confidence',
      'strong',
    );
    await f.state.set('lookups.plugin.lyrics-fixture.settings.shift', '0');
    await runner.request({ type: 'song', id }, 'all');
    await eventually(async () =>
      (await f.store.lookups.stats('lyrics-fixture')).done === 3
    );
    await expect(lookupLyrics);
    await f.state.set('lookups.plugin.second.enabled', 'true');
    await runner.request({ type: 'song', id }, 'all');
    await eventually(async () =>
      (await f.store.lookups.stats('second')).done === 1
    );
    await expect(second);
    const candidates = await f.store.candidates.candidatesFor('song', id);
    const winner = candidates.find((c) => c.source === 'second')!;
    assertEquals(
      (await f.store.candidates.strongestOpen('song', id, 'lyrics'))?.id,
      winner.id,
    );
    for (const state of ['rejected', 'accepted', 'edited'] as const) {
      await f.store.candidates.setState(winner.id, state);
      await expect(lookupLyrics);
    }
    await f.store.candidates.setState(winner.id, 'open');
    await expect(second);
    await Deno.writeTextFile(`${f.root}/song.txt`, 'Local wins');
    await expect([{
      language: 'xxx',
      synced: false,
      lines: [{ text: 'Local wins' }],
    }]);
    await lyricMp3(`${f.root}/song.mp3`, [{
      lang: 'fra',
      text: 'Embedded wins',
    }]);
    await expect([{
      language: 'fra',
      synced: false,
      lines: [{ text: 'Embedded wins' }],
    }]);
    await lyricMp3(`${f.root}/song.mp3`);
    await Deno.remove(`${f.root}/song.txt`);
    await expect(second);
    await f.state.set('lyrics.maxBytes', '8');
    await expect([]);
    await f.state.set('lyrics.maxBytes', '1048576');
    await expect(second);
    await Deno.remove(`${f.root}/song.mp3`);
    await scanLibrary(f.store);
    for (const credential of auth) {
      await error(await f.get(path(id), credential), 404, 'not_found');
    }
    assertEquals(await createLyrics(f.store, f.state).bySongId(id), []);
  } finally {
    await f.close();
  }
});

for (const mode of ['partial', 'overlap', 'absent'] as const) {
  Deno.test(`API lyrics fallback: ${mode} cue ends stay exact natively and normalize only in OpenSubsonic JSON/XML`, async () => {
    const entries = structuredClone(lookupLyrics);
    const cues = entries[1].lines[0].cues!;
    if (mode === 'overlap') {
      cues[0].end = 1800;
      cues[1].end = 2000;
    } else if (mode === 'absent') delete cues[0].end;
    if (mode === 'partial') {
      entries[1].lines.push({
        start: 3000,
        text: 'ab',
        cues: [
          { start: 3000, text: 'a', byteStart: 0, byteEnd: 0 },
          { start: 3500, end: 4000, text: 'b', byteStart: 1, byteEnd: 1 },
        ],
      });
    }
    const f = await fixture();
    try {
      const id = f.songs[0].id, auth = await credentials(f);
      const runner = await f.start(entries);
      await runner.afterScan();
      await eventually(async () =>
        (await f.store.lookups.stats('lyrics-fixture')).done === 1
      );
      assertEquals(await native(f, id, auth), [entries, entries]);
      const reply = await rest(f, 'getLyricsBySongId', {
        id,
        enhanced: 'true',
      });
      const wire = reply.lyricsList.structuredLyrics[1];
      assertEquals(wire.cueLine[0].cue, [
        {
          start: 1000,
          ...(mode === 'overlap' ? { end: 1500 } : {}),
          value: 'Привет ',
          byteStart: 0,
          byteEnd: 12,
        },
        {
          start: 1500,
          ...(mode === 'overlap' ? { end: 2000 } : {}),
          value: '🌍',
          byteStart: 13,
          byteEnd: 16,
        },
      ]);
      if (mode === 'partial') {
        assertEquals(wire.cueLine[1].cue, [
          { start: 3000, end: 3500, value: 'a', byteStart: 0, byteEnd: 0 },
          { start: 3500, end: 4000, value: 'b', byteStart: 1, byteEnd: 1 },
        ]);
      }
      const xml = await rest(
        f,
        'getLyricsBySongId',
        { id, enhanced: 'true' },
        true,
      ) as string;
      assert(xml.includes('value="Привет 🌍"'));
      const cueTags = [...xml.matchAll(/<cue\b([^>]*)>/g)].map((match) =>
        match[1]
      );
      assertEquals(
        cueTags.map((tag) => /\bend="(\d+)"/.exec(tag)?.[1] ?? null),
        mode === 'overlap'
          ? ['1500', '2000']
          : mode === 'partial'
          ? [null, null, '3500', '4000']
          : [null, null],
      );
      assertEquals(
        (await f.store.candidates.candidatesFor('song', id))[0].details.lyrics,
        { origin: 'https://provenance.invalid/song', entries },
      );
      assertEquals(await native(f, id, auth), [entries, entries]);
    } finally {
      await f.close();
    }
  });
}
