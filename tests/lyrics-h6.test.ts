import { assert, assertEquals, assertRejects } from '@std/assert';
import { Buffer } from 'node:buffer';
import { parseFile } from 'music-metadata';
import { Demuxer, Dictionary, Muxer } from 'node-av';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { seedFirstUser } from '../src/users.ts';
import { createUserService } from '../src/user.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createLyrics } from '../src/lyrics.ts';
import { createState } from '../src/state.ts';
import { scanLibrary } from '../src/scan.ts';
import { facade } from '../src/facade.ts';
import { loadLayers } from '../src/layers.ts';
import { lyricMp3 } from './helpers/lyrics.ts';
import { createMedia, remuxLyrics, remuxPicture } from '../src/media.ts';
import { createUnify } from '../src/unify.ts';
import { createDecisions } from '../src/decisions.ts';
import { createLookupRunner } from '../src/lookups/runner.ts';
import { rawSql } from '../src/store/testing.ts';
import { eventually } from './helpers/lookup.ts';

type WireLyrics = {
  lang: string;
  synced: boolean;
  offset?: number;
  kind?: string;
  line: { start?: number; value: string }[];
  cueLine?: {
    index: number;
    value: string;
    start?: number;
    agentId?: string;
    cue: {
      start: number;
      end?: number;
      value: string;
      byteStart: number;
      byteEnd: number;
    }[];
  }[];
  agents?: { id: string; role: string }[];
};

async function setup(prepare: (root: string) => Promise<unknown>) {
  const dir = await Deno.makeTempDir({ prefix: 'lyrics-h6-' });
  const root = `${dir}/music`;
  await Deno.mkdir(root);
  const store = await openStore(`${dir}/data`);
  const state = createState(store);
  const cfg = {
    listen: undefined,
    dataDir: `${dir}/data`,
    user: 'admin',
    password: 'test',
    secret: 'secret',
  };
  await seedFirstUser(store, cfg);
  const libraries = createLibraries(store);
  await libraries.add('Music', root);
  await prepare(root);
  const lyricsService = createLyrics(store, state);
  await scanLibrary(store, undefined, undefined, lyricsService);
  const library = createLibrary(store, lyricsService);
  const core = await pathfinder({
    roots: ['core/'],
    app: { store, cfg, state },
  });
  const app = facade(
    core,
    await loadLayers({
      app: {
        cfg,
        state,
        library,
        libraries,
        user: createUserService(store, cfg),
      },
    }),
  );
  const request = (
    op: string,
    params: Record<string, string> = {},
    xml = false,
    method = 'GET',
  ) => {
    const query = new URLSearchParams({
      u: 'admin',
      p: 'test',
      v: '1.16.1',
      c: 'h6',
      ...(!xml ? { f: 'json' } : {}),
      ...(method === 'POST' ? {} : params),
    });
    return app(
      new Request(`http://x/rest/${op}?${query}`, {
        method,
        ...(method === 'POST' ? { body: new URLSearchParams(params) } : {}),
      }),
    );
  };
  const get = async (op: string, params: Record<string, string> = {}) =>
    (await (await request(op, params)).json())['subsonic-response'];
  const songs = () => store.catalog.listSongs({ offset: 0, size: 100 });
  const lyrics = async (
    id: string,
    enhanced?: string,
  ): Promise<WireLyrics[]> => {
    const reply = await get('getLyricsBySongId', {
      id,
      ...(enhanced ? { enhanced } : {}),
    });
    assertEquals(reply.status, 'ok', JSON.stringify(reply));
    return reply.lyricsList.structuredLyrics;
  };
  return {
    dir,
    root,
    store,
    state,
    library,
    request,
    get,
    songs,
    lyrics,
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('H6 embedded default returns every native USLT language in JSON and XML', async () => {
  const s = await setup((root) =>
    lyricMp3(`${root}/song.mp3`, [{ lang: 'eng', text: 'First\nSecond' }, {
      lang: 'rus',
      text: 'Привет 🌍',
    }])
  );
  try {
    const [song] = await s.songs();
    const lyrics = await s.lyrics(song.id);
    assertEquals(
      lyrics.map((entry) => [entry.lang, entry.synced, entry.line]),
      [
        ['eng', false, [{ value: 'First' }, { value: 'Second' }]],
        ['rus', false, [{ value: 'Привет 🌍' }]],
      ],
    );
    assert(
      lyrics.every((entry) =>
        !('kind' in entry) && !('cueLine' in entry) && !('agents' in entry)
      ),
    );
    const xml =
      await (await s.request('getLyricsBySongId', { id: song.id }, true))
        .text();
    assert(xml.includes('lang="eng"') && xml.includes('lang="rus"'));
    assert(xml.includes('<line>Привет 🌍</line>'));
    assert(!xml.includes('start=') && !xml.includes('kind='));
  } finally {
    await s.close();
  }
});

Deno.test('H6 sidecar order, case-sensitive stem, BOMs, plain text and empty lyrics', async () => {
  const s = await setup(async (root) => {
    await lyricMp3(`${root}/Song.mp3`);
    await Deno.writeTextFile(`${root}/song.elrc`, '[00:00.00]wrong stem');
    await Deno.writeTextFile(`${root}/Song.TXT`, '\ufeffPlain\r\n\r\nLast');
  });
  try {
    const [song] = await s.songs();
    assertEquals((await s.lyrics(song.id))[0].line, [{ value: 'Plain' }, {
      value: '',
    }, { value: 'Last' }]);
    const utf16 = new Uint8Array([
      255,
      254,
      ...Array.from('[00:01.25]UTF16', (c) => [c.charCodeAt(0), 0]).flat(),
    ]);
    await Deno.writeFile(`${s.root}/Song.LRC`, utf16);
    assertEquals((await s.lyrics(song.id))[0].line, [{
      start: 1250,
      value: 'UTF16',
    }]);
    await Deno.writeTextFile(`${s.root}/Song.ELRC`, '[00:02.00]ELRC');
    assertEquals((await s.lyrics(song.id))[0].line, [{
      start: 2000,
      value: 'ELRC',
    }]);
    assertEquals(await s.lyrics('missing'), []);
    assertEquals((await s.get('getLyricsBySongId')).error.code, 10);
  } finally {
    await s.close();
  }
});

Deno.test('H6 enhanced LRC offsets, repeated timestamps and final UTF8 cue positions; v1 gating', async () => {
  const s = await setup(async (root) => {
    await lyricMp3(`${root}/song.mp3`);
    await Deno.writeTextFile(
      `${root}/song.elrc`,
      '[offset:-75]\n[00:01.00][00:03.00]<00:01.00>Привет <00:01.50>🌍<00:02.00>\n[00:04.00]\n[00:05.00]<00:05.00>Start <00:05.50>only',
    );
  });
  try {
    const [song] = await s.songs();
    const [plain] = await s.lyrics(song.id);
    assertEquals(plain.offset, -75);
    assertEquals(plain.line.map((line) => line.start), [
      1000,
      3000,
      4000,
      5000,
    ]);
    assertEquals(plain.line[2].value, '');
    assert(!('kind' in plain) && !('cueLine' in plain));
    assertEquals(await s.lyrics(song.id, 'false'), [plain]);
    const [enhanced] = await s.lyrics(song.id, 'true');
    assertEquals(enhanced.line, plain.line);
    assertEquals(enhanced.kind, 'main');
    assertEquals(enhanced.agents?.filter((a) => a.role === 'main').length, 1);
    assertEquals(enhanced.cueLine?.[0].cue, [
      { start: 1000, end: 1500, value: 'Привет ', byteStart: 0, byteEnd: 12 },
      { start: 1500, end: 2000, value: '🌍', byteStart: 13, byteEnd: 16 },
    ]);
    assertEquals(enhanced.cueLine?.[1].cue.map((cue) => cue.start), [
      3000,
      3500,
    ]);
    for (const line of enhanced.cueLine ?? []) {
      assert(enhanced.agents?.some((agent) => agent.id === line.agentId));
      const bytes = new TextEncoder().encode(line.value);
      for (const cue of line.cue) {
        assertEquals(
          new TextDecoder().decode(bytes.slice(cue.byteStart, cue.byteEnd + 1)),
          cue.value,
        );
      }
    }
    assert(enhanced.cueLine?.at(-1)?.cue.every((cue) => !('end' in cue)));
    const xml = await (await s.request('getLyricsBySongId', {
      id: song.id,
      enhanced: 'true',
    }, true)).text();
    assert(xml.includes('value="Привет 🌍"'));
    assert(xml.includes('<agent id="main" role="main"/>'));
    assert(
      /<cue\b[^>]*byteStart="13"[^>]*byteEnd="16"[^>]*>🌍<\/cue>/.test(xml),
      xml,
    );
  } finally {
    await s.close();
  }
});

for (const format of [1, 2]) {
  Deno.test(`H6 SYLT timestamp format ${format} ${format === 1 ? 'never invents milliseconds' : 'returns native sync and word cues'}`, async () => {
    const s = await setup((root) =>
      lyricMp3(`${root}/song.mp3`, [{
        lang: 'rus',
        format,
        sylt: [{ text: '\nПривет ', timestamp: 1000 }, {
          text: '🌍',
          timestamp: 1500,
        }, { text: '\nSecond', timestamp: 2000 }],
      }])
    );
    try {
      const [song] = await s.songs();
      const [entry] = await s.lyrics(song.id, 'true');
      assertEquals(entry.lang, 'rus');
      assertEquals(entry.synced, format === 2);
      if (format === 1) {
        assertEquals(entry.line, [{ value: 'Привет 🌍' }, { value: 'Second' }]);
        assert(entry.line.every((line) => !('start' in line)));
        assert(!('cueLine' in entry) && !('agents' in entry));
      } else {
        assertEquals(entry.line, [{ start: 1000, value: 'Привет 🌍' }, {
          start: 2000,
          value: 'Second',
        }]);
        assertEquals(entry.cueLine?.[0].cue.map((cue) => cue.start), [
          1000,
          1500,
        ]);
      }
    } finally {
      await s.close();
    }
  });
}

Deno.test('H6 corrupt and oversized structured sources fall through; maxBytes changes live', async () => {
  const s = await setup(async (root) => {
    await lyricMp3(`${root}/song.mp3`, [{ text: 'x'.repeat(1048600) }]);
    await Deno.writeTextFile(`${root}/song.elrc`, '[00:broken]bad');
    await Deno.writeTextFile(
      `${root}/song.lrc`,
      '[00:01.00]' + 'x'.repeat(1048576),
    );
    await Deno.writeTextFile(`${root}/song.txt`, 'fallback');
  });
  try {
    const [song] = await s.songs();
    assertEquals((await s.lyrics(song.id))[0].line, [{ value: 'fallback' }]);
    await s.state.set('lyrics.maxBytes', '4');
    assertEquals(await s.lyrics(song.id), []);
    await s.state.set('lyrics.maxBytes', '1048576');
    await Deno.writeFile(
      `${s.root}/song.elrc`,
      new Uint8Array([0xff, 0xfe, 1]),
    );
    assertEquals((await s.lyrics(song.id))[0].line, [{ value: 'fallback' }]);
  } finally {
    await s.close();
  }
});

Deno.test('H6 legacy exact literal title, album artist, duplicates with lyrics first and requested echoes', async () => {
  const s = await setup(async (root) => {
    await lyricMp3(`${root}/a.mp3`, [{ text: 'older match' }], {
      TIT2: '100%_Song',
    });
    await lyricMp3(`${root}/b.mp3`, [], { TIT2: '100%_Song' });
    await lyricMp3(`${root}/c.mp3`, [{ text: 'must not match wildcard' }], {
      TIT2: '100xxSong',
    });
    const date = new Date('2020-01-01');
    await Deno.utime(`${root}/a.mp3`, date, date);
  });
  try {
    const response = await s.get('getLyrics', {
      artist: 'album artist',
      title: '100%_song',
    });
    assertEquals(response.lyrics, {
      artist: 'album artist',
      title: '100%_song',
      value: 'older match',
    });
    assertEquals(
      (await s.get('getLyrics', { artist: 'wrong', title: '100%_Song' }))
        .lyrics,
      { value: '' },
    );
  } finally {
    await s.close();
  }
});

Deno.test('H6 embedded stays displayed through conflicts; reject is remembered on rescan', async () => {
  const s = await setup(async (root) => {
    await lyricMp3(`${root}/song.mp3`, [{ text: 'embedded' }]);
    await Deno.writeTextFile(`${root}/song.txt`, 'different sidecar');
  });
  try {
    const [song] = await s.songs();
    const local = (await s.store.candidates.candidatesFor('song', song.id))
      .filter((c) => String(c.kind) === 'lyrics');
    assertEquals(local.length, 2);
    assert(
      local.every((candidate) =>
        candidate.source === 'local' && candidate.origin
      ),
    );
    assertEquals((await s.lyrics(song.id))[0].line, [{ value: 'embedded' }]);
    await createDecisions(s.store).reject(local[0].id);
    await scanLibrary(s.store);
    const after = await s.store.candidates.candidatesFor('song', song.id);
    assertEquals(after.length, 2);
    assertEquals(after.find((c) => c.id === local[0].id)?.state, 'rejected');
    await Deno.writeTextFile(`${s.root}/song.txt`, 'embedded');
    await scanLibrary(s.store);
    assertEquals(
      (await s.store.candidates.candidatesFor('song', song.id)).filter((c) =>
        c.state === 'open'
      ),
      [],
    );
  } finally {
    await s.close();
  }
});

Deno.test('H6 legacy ranks newest lyrics first and enforces its live owner-declared candidate cap', async () => {
  const s = await setup(async (root) => {
    for (let i = 0; i < 12; i++) {
      const path = `${root}/${i}.mp3`;
      await lyricMp3(path, [{ text: `rank-${i}` }]);
      const date = new Date(Date.UTC(2020, 0, i + 1));
      await Deno.utime(path, date, date);
    }
  });
  try {
    const query = { title: 'Song' };
    assertEquals((await s.get('getLyrics', query)).lyrics.value, 'rank-11');
    // The scan's lyrics fact ranks candidates, while reads see current files.
    await lyricMp3(`${s.root}/11.mp3`);
    await s.state.set('lyrics.legacyCandidates', '1');
    assertEquals((await s.get('getLyrics', query)).lyrics, { value: '' });
    await s.state.set('lyrics.legacyCandidates', '2');
    assertEquals((await s.get('getLyrics', query)).lyrics.value, 'rank-10');
    await s.state.set('lyrics.legacyCandidates', '10');
    for (let i = 2; i < 11; i++) await lyricMp3(`${s.root}/${i}.mp3`);
    // The eleventh/twelfth matching song must not escape the ten-song cap.
    assertEquals((await s.get('getLyrics', query)).lyrics, { value: '' });
    await assertRejects(() => s.state.set('lyrics.legacyCandidates', '11'));
  } finally {
    await s.close();
  }
});

Deno.test('H6 advertises songLyrics versions 1 and 2', async () => {
  const s = await setup((root) => lyricMp3(`${root}/song.mp3`));
  try {
    assertEquals(
      (await s.get('getOpenSubsonicExtensions')).openSubsonicExtensions.find((
        e: { name: string },
      ) => e.name === 'songLyrics'),
      { name: 'songLyrics', versions: [1, 2] },
    );
  } finally {
    await s.close();
  }
});

const JPEG = 'tests/fixtures/library/Fixture Artist/Fixture Album/cover.jpg';
const MP3 =
  'tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3';
// Seed through the bundled muxer; fixture preparation is not a product tag writer.
async function writableFixture(
  root: string,
  format: string,
  art: boolean,
  encoder = true,
) {
  const path = `${root}/song.${format}`;
  const seed = `${root}/.seed`;
  if (format === 'ogg' || format === 'opus') {
    const encoded = (await createMedia().transcodeAudio(MP3, format))!;
    await Deno.writeFile(
      seed,
      new Uint8Array(await new Response(encoded.stream).arrayBuffer()),
    );
  } else await Deno.copyFile(`tests/fixtures/media/clip.${format}`, seed);
  await using input = await Demuxer.open(seed);
  await using mux = await Muxer.open(path, {
    input,
    format: format === 'm4a' ? 'mp4' : format === 'opus' ? 'ogg' : format,
    options: format === 'flac' && !encoder ? { fflags: '+bitexact' } : {},
    configure(ctx) {
      using dict = Dictionary.fromObject({
        ...input.metadata,
        lyrics: 'Old embedded words',
        comment: 'Keep this native comment',
      });
      ctx.metadata = dict;
    },
  });
  const mapping = new Map(input.streams.map((stream) => {
    const index = mux.addStream(stream);
    if (format === 'ogg' || format === 'opus') {
      using original = stream.metadata;
      using dict = Dictionary.fromObject({
        ...original?.getAll(),
        encoder: 'Original tool',
        lyrics: 'Old embedded words',
        H6_KEEP: 'Unknown native tag',
      });
      mux.getStream(index)!.metadata = dict;
    }
    return [stream.index, index];
  }));
  for await (const packet of input.packets()) {
    if (!packet) continue;
    try {
      await mux.writePacket(packet, mapping.get(packet.streamIndex)!);
    } finally {
      packet.free();
    }
  }
  await mux.close();
  if (art) {
    await remuxPicture(path, JPEG, `${root}/.pictured`);
    await Deno.rename(`${root}/.pictured`, path);
  }
  if (encoder && (format === 'flac' || format === 'm4a')) {
    const bytes = Buffer.from(await Deno.readFile(path));
    const old = Buffer.from('Lavf62.19.101');
    let count = 0;
    for (
      let at = bytes.indexOf(old);
      at >= 0;
      at = bytes.indexOf(old, at + old.length)
    ) {
      bytes.set(Buffer.from('Original tool'), at);
      count++;
    }
    assert(count > 0);
    await Deno.writeFile(path, bytes);
  }
  await Deno.remove(seed);
  await Deno.writeTextFile(
    `${root}/song.ELRC`,
    '[lang:rus]\n[offset:-10]\n[00:01.000]<00:01.000>Привет <00:01.500>🌍<00:02.000>',
  );
  await Deno.writeTextFile(`${root}/song.TXT`, 'Chosen plain\n\nLast');
}

async function otherTags(path: string) {
  const metadata = await parseFile(path);
  const { lyrics: _lyrics, ...common } = metadata.common;
  const native = Object.values(metadata.native).flat().filter((tag) =>
    !/^(USLT|ULT|SYLT|LYRICS|©lyr)$/i.test(tag.id)
  ).map((tag) => JSON.stringify(tag)).sort();
  return { common, native };
}

for (
  const [format, art, encoder] of [
    ['flac', true, true],
    ['flac', false, false],
    ['m4a', true, true],
    ['ogg', true, true],
    ['opus', true, true],
  ] as const
) {
  for (const synced of [true, false]) {
    Deno.test(`H6 queued lyrics unify ${format} art=${art} synced=${synced}: HTTP, sidecar, backups, all tags, afp/1 and kept identity`, async () => {
      const s = await setup((root) =>
        writableFixture(root, format, art, encoder)
      );
      let runner: Awaited<ReturnType<typeof createLookupRunner>> | undefined;
      try {
        const [song] = await s.songs();
        const path = `${s.root}/song.${format}`;
        const beforeTags = await otherTags(path);
        const beforeFingerprint = await createMedia().fingerprint(path);
        const beforeIdentity = await s.store.catalog.identitySnapshot();
        const oldSidecars = await Promise.all(
          ['ELRC', 'TXT'].map(async (ext) => ({
            origin: `${s.root}/song.${ext}`,
            bytes: Buffer.from(await Deno.readFile(`${s.root}/song.${ext}`))
              .toString('base64'),
          })),
        );
        const candidates =
          (await s.store.candidates.candidatesFor('song', song.id)).filter((
            c,
          ) => c.kind === 'lyrics');
        assertEquals(candidates.length, 3);
        const chosen = candidates.find((c) =>
          c.origin.endsWith(synced ? '.ELRC' : '.TXT')
        )!;
        const expected = synced
          ? [{ start: 1000, value: 'Привет 🌍' }]
          : [{ value: 'Chosen plain' }, { value: '' }, { value: 'Last' }];
        await s.state.set('lookups.maxAttempts', '1');
        await createDecisions(s.store).accept(chosen.id);
        runner = await createLookupRunner({
          store: s.store,
          state: s.state,
          dataDir: `${s.dir}/data`,
          builtin: `${s.dir}/no-plugins`,
        });
        await eventually(async () => {
          const stats = await s.store.lookups.stats('core.unify');
          return stats.done === 1 || stats.failed === 1;
        });
        assertEquals(
          await rawSql(s.store).all(
            'SELECT state, last_error FROM lookup_jobs',
          ),
          [{ state: 'done', last_error: null }],
        );
        assertEquals(await otherTags(path), beforeTags);
        assertEquals(await createMedia().fingerprint(path), beforeFingerprint);
        const [reply] = await s.lyrics(song.id, 'true');
        assertEquals(reply.line, expected);
        assertEquals(reply.synced, synced);
        if (synced) {
          assertEquals(reply.cueLine?.[0].cue[1], {
            start: 1500,
            end: 2000,
            byteStart: 13,
            byteEnd: 16,
            value: '🌍',
          });
        }
        const xml = await (await s.request('getLyricsBySongId', {
          id: song.id,
          enhanced: 'true',
        }, true)).text();
        assert(xml.includes(synced ? 'Привет 🌍' : 'Chosen plain'));
        const sidecar = `${s.root}/song.${synced ? 'lrc' : 'txt'}`;
        assert(
          (await Deno.readTextFile(sidecar)).includes(
            synced ? 'Привет ' : 'Chosen plain',
          ),
        );
        for (const old of oldSidecars) {
          await assertRejects(
            () => Deno.stat(old.origin),
            Deno.errors.NotFound,
          );
        }
        const after = (await s.store.candidates.candidatesFor('song', song.id))
          .filter((c) => c.kind === 'lyrics');
        assertEquals(after.find((c) => c.id === chosen.id)?.state, 'accepted');
        const backups = after.flatMap((c) =>
          Array.isArray(c.details.backups) ? c.details.backups : []
        );
        for (const old of oldSidecars) {
          assert(
            backups.some((b) =>
              b.origin === old.origin && b.bytes === old.bytes
            ),
            'every original sidecar byte must be backed up',
          );
        }
        assert(
          backups.some((b) => b.origin === 'embedded' && b.native),
          'original native lyrics must be backed up',
        );
        await scanLibrary(s.store);
        assertEquals((await s.lyrics(song.id))[0].line, expected);
        assertEquals(
          (await s.store.catalog.identitySnapshot()).map((
            i,
          ) => [i.id, i.fingerprint]),
          beforeIdentity.map((i) => [i.id, i.fingerprint]),
        );
        assertEquals((await s.songs())[0].firstSeenMs, song.firstSeenMs);
        assertEquals(
          (await s.store.candidates.candidatesFor('song', song.id)).filter((
            c,
          ) =>
            c.kind === 'lyrics' && c.state === 'open' && !c.details.preserved
          ),
          [],
        );
        assertEquals(
          (await s.store.catalog.events({ limit: 100 })).filter((e) =>
            e.kind === 'audio_changed'
          ),
          [],
        );
      } finally {
        await runner?.close();
        await s.close();
      }
    });
  }
}

for (const format of ['mp3', 'flac']) {
  Deno.test(`H6 refuses ${format} lyrics before any filesystem change; failed job leaves candidate open`, async () => {
    const s = await setup(async (root) => {
      if (format === 'mp3') {
        await lyricMp3(`${root}/song.mp3`, [{ text: 'Original lyrics' }]);
        await Deno.writeTextFile(`${root}/song.txt`, 'Different');
      } else await writableFixture(root, 'flac', false);
    });
    let runner: Awaited<ReturnType<typeof createLookupRunner>> | undefined;
    try {
      const [song] = await s.songs();
      const path = `${s.root}/song.${format}`;
      const before = await Deno.readFile(path), stat = await Deno.stat(path);
      const listing = [...Deno.readDirSync(s.root)].map((e) => e.name).sort();
      const cache = [...Deno.readDirSync(`${s.root}/.melofon/candidates`)].map((
        e,
      ) => e.name).sort();
      const candidate =
        (await s.store.candidates.candidatesFor('song', song.id)).find((c) =>
          c.kind === 'lyrics'
        )!;
      await s.state.set('lookups.maxAttempts', '1');
      await createDecisions(s.store).accept(candidate.id);
      runner = await createLookupRunner({
        store: s.store,
        state: s.state,
        dataDir: `${s.dir}/data`,
        builtin: `${s.dir}/no-plugins`,
      });
      await eventually(async () =>
        (await s.store.lookups.stats('core.unify')).failed === 1
      );
      const [job] = await rawSql(s.store).all<{ last_error: string }>(
        'SELECT last_error FROM lookup_jobs',
      );
      assert(
        job.last_error.includes(
          format === 'mp3'
            ? 'lyrics write not supported for MP3 yet'
            : 'lyrics write would change the FLAC ENCODER tag',
        ),
      );
      assertEquals(
        (await s.store.candidates.byId(candidate.id))!.state,
        'open',
      );
      assertEquals(await Deno.readFile(path), before);
      assertEquals((await Deno.stat(path)).mtime, stat.mtime);
      assertEquals(
        [...Deno.readDirSync(s.root)].map((e) => e.name).sort(),
        listing,
      );
      assertEquals(
        [...Deno.readDirSync(`${s.root}/.melofon/candidates`)].map((e) =>
          e.name
        ).sort(),
        cache,
      );
      assert(
        (await s.store.candidates.candidatesFor('song', song.id)).every((c) =>
          !c.details.preserved
        ),
      );
    } finally {
      await runner?.close();
      await s.close();
    }
  });
}

Deno.test('H6 POST form, UTF16BE, exact cap boundary and malformed enhanced fallback reach the consumer', async () => {
  const s = await setup(async (root) => {
    await lyricMp3(`${root}/song.mp3`);
    const text = '[00:01.000]Я 🌍';
    const units = Array.from(
      { length: text.length },
      (_, i) => [text.charCodeAt(i) >> 8, text.charCodeAt(i) & 255],
    ).flat();
    await Deno.writeFile(
      `${root}/song.lrc`,
      new Uint8Array([254, 255, ...units]),
    );
    await Deno.writeTextFile(`${root}/song.txt`, 'fallback');
  });
  try {
    const [song] = await s.songs();
    await s.state.set(
      'lyrics.maxBytes',
      String((await Deno.stat(`${s.root}/song.lrc`)).size),
    );
    const response = await (await s.request(
      'getLyricsBySongId',
      { id: song.id, enhanced: 'true' },
      false,
      'POST',
    )).json();
    assertEquals(
      response['subsonic-response'].lyricsList.structuredLyrics[0].line,
      [{ start: 1000, value: 'Я 🌍' }],
    );
    await s.state.set(
      'lyrics.maxBytes',
      String((await Deno.stat(`${s.root}/song.lrc`)).size - 1),
    );
    assertEquals((await s.lyrics(song.id))[0].line, [{ value: 'fallback' }]);
    await s.state.set('lyrics.maxBytes', '1048576');
    await Deno.writeTextFile(
      `${s.root}/song.elrc`,
      '[00:01.00]<00:broken>must not be literal lyrics',
    );
    assertEquals((await s.lyrics(song.id))[0].line, [{
      start: 1000,
      value: 'Я 🌍',
    }]);
    const xml = await (await s.request('getLyrics', {
      artist: 'Album Artist',
      title: 'Song',
    }, true)).text();
    assert(xml.includes('Я 🌍'));
  } finally {
    await s.close();
  }
});

Deno.test('H6 keeps all same-language native entries and refreshes live timing when a text candidate is rescanned', async () => {
  const s = await setup(async (root) => {
    await lyricMp3(`${root}/song.mp3`, [{ lang: 'eng', text: 'First' }, {
      lang: 'eng',
      text: 'Second',
    }]);
    await Deno.writeTextFile(`${root}/song.lrc`, '[00:01.000]Side words');
  });
  try {
    const [song] = await s.songs();
    assertEquals((await s.lyrics(song.id)).map((e) => e.line), [[{
      value: 'First',
    }], [{ value: 'Second' }]]);
    const before = (await s.store.candidates.candidatesFor('song', song.id))
      .find((c) => c.origin.endsWith('.lrc'))!;
    await Deno.writeTextFile(`${s.root}/song.lrc`, '[00:03.000]Side words');
    await scanLibrary(s.store);
    const after = (await s.store.candidates.byId(before.id))!;
    assertEquals(
      (after.details.lyrics as { entry: { lines: { start: number }[] } }).entry
        .lines[0].start,
      3000,
    );
  } finally {
    await s.close();
  }
});

Deno.test('H6 read-only library rejects a stale lyrics choice and a read-only scan keeps display without candidates', async () => {
  const s = await setup((root) => writableFixture(root, 'flac', true));
  try {
    const [song] = await s.songs();
    const candidate = (await s.store.candidates.candidatesFor('song', song.id))
      .find((c) => c.kind === 'lyrics')!;
    const before = await Deno.readFile(song.path);
    await Deno.chmod(s.root, 0o555);
    await assertRejects(() => createDecisions(s.store).accept(candidate.id));
    assertEquals((await s.store.lookups.stats('core.unify')).waiting, 0);
    assertEquals((await s.store.candidates.byId(candidate.id))!.state, 'open');
    await scanLibrary(s.store);
    assertEquals(
      (await s.store.candidates.candidatesFor('song', song.id)).filter((c) =>
        c.kind === 'lyrics'
      ),
      [],
    );
    assertEquals((await s.lyrics(song.id))[0].line, [{
      value: 'Old embedded words',
    }]);
    assertEquals(await Deno.readFile(song.path), before);
  } finally {
    await Deno.chmod(s.root, 0o755);
    await s.close();
  }
});

for (const damage of ['audio', 'tags']) {
  Deno.test(`H6 lyrics integrity guard rejects changed ${damage} without publishing either original`, async () => {
    const s = await setup((root) => writableFixture(root, 'flac', true));
    let runner: Awaited<ReturnType<typeof createLookupRunner>> | undefined;
    try {
      const [song] = await s.songs();
      const before = await Deno.readFile(song.path),
        side = await Deno.readFile(`${s.root}/song.TXT`);
      const candidate =
        (await s.store.candidates.candidatesFor('song', song.id)).find((c) =>
          c.origin.endsWith('.TXT')
        )!;
      await s.state.set('lookups.maxAttempts', '1');
      const unify = createUnify(s.store, {
        remuxLyrics: async (_path, _text, output) => {
          await Deno.copyFile(
            damage === 'audio'
              ? 'tests/fixtures/library/Fixture Artist/Fixture Album/02 - Second Song.mp3'
              : 'tests/fixtures/media/clip.flac',
            output,
          );
        },
      });
      await createDecisions(s.store).accept(candidate.id);
      runner = await createLookupRunner({
        store: s.store,
        state: s.state,
        dataDir: `${s.dir}/data`,
        builtin: `${s.dir}/no-plugins`,
        unify,
      });
      await eventually(async () =>
        (await s.store.lookups.stats('core.unify')).failed === 1
      );
      const [job] = await rawSql(s.store).all<{ last_error: string }>(
        'SELECT last_error FROM lookup_jobs',
      );
      assert(
        job.last_error.includes(
          damage === 'audio' ? 'afp/1' : 'non-lyrics tag',
        ),
      );
      assertEquals(await Deno.readFile(song.path), before);
      assertEquals(await Deno.readFile(`${s.root}/song.TXT`), side);
      assertEquals(
        (await s.store.candidates.byId(candidate.id))!.state,
        'open',
      );
      assertEquals(
        [...Deno.readDirSync(s.root)].filter((e) =>
          e.name.startsWith('.unify-')
        ),
        [],
      );
    } finally {
      await runner?.close();
      await s.close();
    }
  });
}

Deno.test('H6 backs up sidecars changed during remux, then an archived choice restores embedded lyrics after rescan', async () => {
  const s = await setup((root) => writableFixture(root, 'flac', true));
  let runner: Awaited<ReturnType<typeof createLookupRunner>> | undefined;
  try {
    const [song] = await s.songs();
    const candidate = (await s.store.candidates.candidatesFor('song', song.id))
      .find((c) => c.origin.endsWith('.ELRC'))!;
    let mutate = true;
    const unify = createUnify(s.store, {
      remuxLyrics: async (...args) => {
        await remuxLyrics(...args);
        if (mutate) {
          await Deno.writeTextFile(
            `${s.root}/song.TXT`,
            'Changed during remux',
          );
          await Deno.writeFile(
            `${s.root}/song.LRC`,
            new Uint8Array([255, 254, 1]),
          );
          mutate = false;
        }
      },
    });
    await s.state.set('lookups.maxAttempts', '1');
    await createDecisions(s.store).accept(candidate.id);
    runner = await createLookupRunner({
      store: s.store,
      state: s.state,
      dataDir: `${s.dir}/data`,
      builtin: `${s.dir}/no-plugins`,
      unify,
    });
    await eventually(async () => {
      const stats = await s.store.lookups.stats('core.unify');
      return stats.done === 1 || stats.failed === 1;
    });
    assertEquals((await s.store.lookups.stats('core.unify')).done, 1);
    const choices = await s.store.candidates.candidatesFor('song', song.id);
    const backups = choices.flatMap((c) =>
      Array.isArray(c.details.backups) ? c.details.backups : []
    );
    assert(
      backups.some((b) =>
        b.bytes === Buffer.from('Changed during remux').toString('base64')
      ),
    );
    assert(
      backups.some((b) =>
        b.bytes === Buffer.from([255, 254, 1]).toString('base64')
      ),
    );
    await scanLibrary(s.store);
    const original = (await s.store.candidates.candidatesFor('song', song.id))
      .find((c) =>
        c.kind === 'lyrics' && c.origin === song.id && c.details.preserved
      )!;
    assert(original);
    await createDecisions(s.store).accept(original.id);
    await eventually(async () => {
      const stats = await s.store.lookups.stats('core.unify');
      return stats.done === 2 || stats.failed === 1;
    });
    assertEquals((await s.store.lookups.stats('core.unify')).done, 2);
    assertEquals((await s.lyrics(song.id))[0].line, [{
      value: 'Old embedded words',
    }]);
    assertEquals(
      await Deno.readTextFile(`${s.root}/song.txt`),
      'Old embedded words',
    );
    await scanLibrary(s.store);
    assertEquals(
      (await s.store.candidates.candidatesFor('song', song.id)).filter((c) =>
        c.kind === 'lyrics' && c.state === 'open' && !c.details.preserved
      ),
      [],
    );
  } finally {
    await runner?.close();
    await s.close();
  }
});
