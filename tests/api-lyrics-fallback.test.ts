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

Deno.test('API lyrics: enhanced lookup tracks, exact line ends and overlapping vocal agents are opt-in', async () => {
  const entries: LyricsEntry[] = [
    {
      language: 'eng',
      kind: 'translation',
      synced: false,
      lines: [{ text: 'Under the sky' }],
    },
    {
      language: 'jpn',
      synced: true,
      offset: -10,
      agents: [
        { id: 'lead', role: 'main', name: 'Vocal A' },
        { id: 'guest', role: 'voice', name: 'Vocal B' },
        { id: 'echo', role: 'bg' },
      ],
      lines: [
        {
          start: 0,
          end: 1800,
          text: 'こ\tこ echo',
          vocals: [
            {
              agentId: 'echo',
              start: 700,
              end: 1700,
              text: 'echo',
              cues: [{ start: 700, text: 'echo', byteStart: 0, byteEnd: 3 }],
            },
            {
              agentId: 'lead',
              text: 'こ\tこ',
              cues: [
                { start: 0, end: 1200, text: 'こ', byteStart: 0, byteEnd: 2 },
                { start: 800, text: 'こ', byteStart: 4, byteEnd: 6 },
              ],
            },
          ],
        },
        {
          start: 2000,
          end: 3500,
          text: '空',
          vocals: [{
            agentId: 'guest',
            text: '空',
            cues: [{
              start: 2100,
              end: 3300,
              text: '空',
              byteStart: 0,
              byteEnd: 2,
            }],
          }],
        },
        { start: 3200, end: 3200, text: '' },
        { start: 4500, text: '花' },
        { start: 6000, end: 7200, text: '風' },
      ],
    },
    {
      language: 'jpn-Latn',
      kind: 'pronunciation',
      synced: true,
      lines: [{ start: 2000, text: 'sora' }],
    },
  ];
  const f = await fixture();
  try {
    const { id } = f.songs[0];
    const runner = await f.start(entries);
    await runner.afterScan();
    await eventually(async () =>
      (await f.store.lookups.stats('lyrics-fixture')).done === 1
    );
    assertEquals(
      (await f.store.candidates.candidatesFor('song', id))[0].details.lyrics,
      { origin: 'https://provenance.invalid/song', entries },
    );
    const versions = (await rest(f, 'getOpenSubsonicExtensions', {}))
      .openSubsonicExtensions.find((extension: { name: string }) =>
        extension.name === 'songLyrics'
      );
    assertEquals(versions, { name: 'songLyrics', versions: [1, 2] });
    const extensionXml = await rest(
      f,
      'getOpenSubsonicExtensions',
      {},
      true,
    ) as string;
    assert(
      extensionXml.includes(
        '<openSubsonicExtensions name="songLyrics"><versions>1</versions><versions>2</versions></openSubsonicExtensions>',
      ),
    );

    const baseLines = entries[1].lines.map(({ start, text }) => ({
      start,
      value: text,
    }));
    const expectedV1 = [{
      lang: 'jpn',
      synced: true,
      offset: -10,
      line: baseLines,
    }];
    const legacyParams: Record<string, string>[] = [{ id }, {
      id,
      enhanced: 'false',
    }];
    for (const args of legacyParams) {
      const plain = await rest(f, 'getLyricsBySongId', args);
      assertEquals(plain.lyricsList.structuredLyrics, expectedV1);
      const xml = await rest(f, 'getLyricsBySongId', args, true) as string;
      assert(!/\b(end|kind)=|<cueLine|<agent/.test(xml));
      assertEquals(xml.match(/<structuredLyrics\b/g)?.length, 1);
      assert(xml.includes('<line start="0">こ\tこ echo</line>'));
    }

    const enhanced = await rest(f, 'getLyricsBySongId', {
      id,
      enhanced: 'true',
    });
    const [translation, main, pronunciation] =
      enhanced.lyricsList.structuredLyrics;
    assertEquals(enhanced.lyricsList.structuredLyrics.length, 3);
    assertEquals(translation, {
      lang: 'eng',
      synced: false,
      kind: 'translation',
      line: [{ value: 'Under the sky' }],
    });
    assertEquals(pronunciation, {
      lang: 'jpn-Latn',
      synced: true,
      kind: 'pronunciation',
      line: [{ start: 2000, value: 'sora' }],
    });
    assertEquals(main, {
      lang: 'jpn',
      synced: true,
      offset: -10,
      kind: 'main',
      agents: entries[1].agents,
      line: baseLines.map((line, i) => {
        const { end } = entries[1].lines[i];
        return { ...line, ...(end === undefined ? {} : { end }) };
      }),
      cueLine: [
        {
          index: 0,
          start: 0,
          end: 1800,
          agentId: 'lead',
          value: 'こ\tこ',
          cue: [
            { start: 0, end: 800, value: 'こ', byteStart: 0, byteEnd: 2 },
            { start: 800, end: 1800, value: 'こ', byteStart: 4, byteEnd: 6 },
          ],
        },
        {
          index: 0,
          start: 700,
          end: 1700,
          agentId: 'echo',
          value: 'echo',
          cue: [{ start: 700, value: 'echo', byteStart: 0, byteEnd: 3 }],
        },
        {
          index: 1,
          start: 2000,
          end: 3500,
          agentId: 'guest',
          value: '空',
          cue: [{
            start: 2100,
            end: 3300,
            value: '空',
            byteStart: 0,
            byteEnd: 2,
          }],
        },
      ],
    });
    const xml = await rest(
      f,
      'getLyricsBySongId',
      { id, enhanced: 'true' },
      true,
    ) as string;
    for (
      const expected of [
        '<structuredLyrics lang="eng" synced="false" kind="translation">',
        '<structuredLyrics lang="jpn-Latn" synced="true" kind="pronunciation">',
        '<line start="0" end="1800">こ\tこ echo</line>',
        '<line start="2000" end="3500">空</line>',
        '<line start="3200" end="3200"/>',
        '<line start="4500">花</line>',
        '<line start="6000" end="7200">風</line>',
        '<agent id="lead" role="main" name="Vocal A"/>',
        '<agent id="guest" role="voice" name="Vocal B"/>',
        '<agent id="echo" role="bg"/>',
        '<cueLine index="0" agentId="lead" start="0" end="1800" value="こ&#9;こ">',
        '<cue start="800" byteStart="4" byteEnd="6" end="1800">こ</cue>',
        '<cueLine index="0" agentId="echo" start="700" end="1700" value="echo">',
        '<cue start="700" byteStart="0" byteEnd="3">echo</cue>',
      ]
    ) assert(xml.includes(expected), `Missing ${expected} in ${xml}`);
    assert(
      xml.indexOf('<cueLine index="0" agentId="lead"') <
        xml.indexOf('<cueLine index="0" agentId="echo"'),
    );
    assertEquals(await native(f, id, await credentials(f)), [entries, entries]);
    const title = f.songs[0].title;
    assert(title);
    const legacy = await rest(f, 'getLyrics', { title });
    assertEquals(
      legacy.lyrics.value,
      baseLines.map((line) => line.value).join('\n'),
    );
  } finally {
    await f.close();
  }
});

Deno.test('API lyrics: timed LRC backgrounds keep per-voice byte offsets, repeat with a row and leave v1 unchanged', async () => {
  const source = [
    '[lang:ukr]',
    '[bg: <00:00.00>orphan]',
    '[00:01.00][00:11.00]<00:01.00>Я<00:02.00>',
    '[bg: <00:01.30>🎵<00:01.80>]',
    '[bg: untimed]',
    '[bg: <00:02.20>так<00:02.70>]',
    '[00:03.00]<00:03.00>Ми',
  ].join('\n');
  const f = await fixture(async (root) => {
    await Deno.writeTextFile(`${root}/song.elrc`, source);
    await Deno.writeTextFile(`${root}/song.lrc`, '[00:01.00]Lower priority');
  });
  try {
    const { id } = f.songs[0];
    const expectedPlain = [{
      lang: 'ukr',
      synced: true,
      line: [
        { start: 1000, value: 'Я' },
        { start: 3000, value: 'Ми' },
        { start: 11000, value: 'Я' },
      ],
    }];
    const prove = async () => {
      const plain = await rest(f, 'getLyricsBySongId', { id });
      assertEquals(plain.lyricsList.structuredLyrics, expectedPlain);
      const enhanced = await rest(f, 'getLyricsBySongId', {
        id,
        enhanced: 'true',
      });
      const [entry] = enhanced.lyricsList.structuredLyrics;
      assertEquals(entry.agents, [{ id: 'main', role: 'main' }, {
        id: 'bg',
        role: 'bg',
      }]);
      assertEquals(entry.line, [
        { start: 1000, value: 'Я 🎵 так' },
        { start: 3000, value: 'Ми' },
        { start: 11000, value: 'Я 🎵 так' },
      ]);
      assertEquals(
        entry.cueLine.map((
          { index, agentId }: { index: number; agentId: string },
        ) => [index, agentId]),
        [
          [0, 'main'],
          [0, 'bg'],
          [1, 'main'],
          [2, 'main'],
          [2, 'bg'],
        ],
      );
      for (const [index, start] of [[0, 1000], [2, 11000]]) {
        const lead = {
          index,
          agentId: 'main',
          start,
          value: 'Я',
          cue: [{
            start,
            end: start + 1000,
            value: 'Я',
            byteStart: 0,
            byteEnd: 1,
          }],
        };
        const bg = {
          index,
          agentId: 'bg',
          start,
          value: '🎵 так',
          cue: [
            {
              start: start + 300,
              end: start + 800,
              value: '🎵',
              byteStart: 0,
              byteEnd: 3,
            },
            {
              start: start + 1200,
              end: start + 1700,
              value: 'так',
              byteStart: 5,
              byteEnd: 10,
            },
          ],
        };
        assertEquals(
          entry.cueLine.filter((layer: { index: number }) =>
            layer.index === index
          ),
          [lead, bg],
        );
      }
      const xml = await rest(
        f,
        'getLyricsBySongId',
        { id, enhanced: 'true' },
        true,
      ) as string;
      assert(xml.includes('<line start="1000">Я 🎵 так</line>'));
      assert(
        xml.includes(
          '<cueLine index="0" agentId="bg" start="1000" value="🎵 так">',
        ),
      );
      assert(
        xml.includes(
          '<cue start="2200" byteStart="5" byteEnd="10" end="2700">так</cue>',
        ),
      );
    };
    await prove();
    // Embedded still wins over a different same-stem sidecar.
    await Deno.writeTextFile(`${f.root}/song.elrc`, '[00:01.00]Lower priority');
    await lyricMp3(`${f.root}/song.mp3`, [{ lang: 'ukr', text: source }]);
    await prove();
  } finally {
    await f.close();
  }
});
