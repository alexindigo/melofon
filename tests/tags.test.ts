import { assert, assertEquals, assertRejects } from '@std/assert';
import { Buffer } from 'node:buffer';
import { parseFile } from 'music-metadata';
import { createMedia } from '../src/media.ts';
import { createTagWriter, unchangedTagFacts, writeTags } from '../src/tags.ts';
import { lyricMp3 } from './helpers/lyrics.ts';

const JPEG = 'tests/fixtures/library/Fixture Artist/Fixture Album/cover.jpg';

// Keep this first: the writer's WASI instance initializes lazily on first use.
Deno.test('TagLib initializes and writes from its installed package without HTTP fetch', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'tags-offline-' });
  const path = `${dir}/song.mp3`;
  const originalFetch = globalThis.fetch;
  const attempted: string[] = [];
  try {
    await lyricMp3(path, [{ text: 'Original words' }]);
    const before = await parseFile(path);
    const fingerprint = await createMedia().fingerprint(path);
    globalThis.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (/^https?:/i.test(url)) {
        attempted.push(url);
        return Promise.reject(
          new Error(`Unexpected runtime HTTP fetch: ${url}`),
        );
      }
      return originalFetch(input, init);
    };
    const lyrics = { text: 'Installed offline words', lang: 'eng' };
    await writeTags(path, { lyrics });
    const after = await parseFile(path);
    assertEquals(
      Object.values(after.native).flat().filter((tag) => tag.id === 'USLT')
        .map((tag) => tag.value),
      [{ language: 'eng', descriptor: '', text: lyrics.text }],
    );
    assertEquals(
      unchangedTagFacts(after, { lyrics }),
      unchangedTagFacts(before, { lyrics }),
    );
    assertEquals(await createMedia().fingerprint(path), fingerprint);
    assertEquals(attempted, []);
  } finally {
    globalThis.fetch = originalFetch;
    await Deno.remove(dir, { recursive: true });
  }
});

function trailer(enhanced: boolean) {
  const v1 = Buffer.alloc(128);
  v1.write('TAG');
  v1.write('Original ID3v1 title', 3);
  v1.write('Original ID3v1 artist', 33);
  v1.write('Original ID3v1 album', 63);
  v1.write('1991', 93);
  v1.write('Keep this exact trailer', 97);
  v1[125] = 0;
  v1[126] = 7;
  v1[127] = 17;
  const plus = Buffer.alloc(227);
  plus.write('TAG+');
  plus.write('Extended original title', 4);
  plus.write('Extended original artist', 64);
  plus.write('Extended original album', 124);
  return enhanced ? Buffer.concat([plus, v1]) : v1;
}

for (const kind of ['absent', 'v1', 'enhanced']) {
  Deno.test(`TagLib MP3 picture then USLT/SYLT: ${kind} ID3v1 trailer preserved exactly`, async () => {
    const dir = await Deno.makeTempDir({ prefix: 'tags-' });
    const path = `${dir}/song.mp3`;
    try {
      await lyricMp3(path, [{ lang: 'eng', text: 'Old words' }], {
        TSSE: 'Original encoder',
      });
      const originalTrailer = kind === 'absent'
        ? new Uint8Array()
        : new Uint8Array(trailer(kind === 'enhanced'));
      await Deno.writeFile(path, originalTrailer, { append: true });
      const before = await parseFile(path);
      const fingerprint = await createMedia().fingerprint(path);
      const bytes = await Deno.readFile(JPEG);
      const picture = { bytes, mime: 'image/jpeg' };
      await writeTags(path, { picture });
      const pictured = await parseFile(path);
      assertEquals(
        unchangedTagFacts(pictured, { picture }),
        unchangedTagFacts(before, { picture }),
      );
      assertEquals(pictured.common.picture?.map((p) => p.data), [bytes]);
      const lyrics = {
        text: 'Привет 🌍\nSecond',
        lang: 'rus',
        synced: [{ timeMs: 1234, text: '\nПривет 🌍' }, {
          timeMs: 2345,
          text: '\nSecond',
        }],
      };
      await writeTags(path, { lyrics });
      const after = await parseFile(path);
      assertEquals(
        unchangedTagFacts(after, { lyrics }),
        unchangedTagFacts(pictured, { lyrics }),
      );
      assertEquals(
        Object.values(after.native).flat().filter((t) => t.id === 'USLT').map((
          t,
        ) => t.value),
        [{ language: 'rus', descriptor: '', text: lyrics.text }],
      );
      const sylt = Object.values(after.native).flat().find((t) =>
        t.id === 'SYLT'
      )!.value as {
        language: string;
        timeStampFormat: number;
        contentType: number;
        syncText: unknown;
      };
      assertEquals(sylt.language, 'rus');
      assertEquals(sylt.timeStampFormat, 2);
      assertEquals(sylt.contentType, 1);
      assertEquals(sylt.syncText, [{ text: '\nПривет 🌍', timestamp: 1234 }, {
        text: '\nSecond',
        timestamp: 2345,
      }]);
      assertEquals(await createMedia().fingerprint(path), fingerprint);
      const saved = await Deno.readFile(path);
      if (originalTrailer.length) {
        assertEquals(saved.slice(-originalTrailer.length), originalTrailer);
      } else {assertEquals(
          new TextDecoder().decode(saved.slice(-128, -125)) === 'TAG',
          false,
        );}
      assertEquals([...Deno.readDirSync(dir)].map((e) => e.name), ['song.mp3']);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test('TagLib upgrades ID3v2.3 to v2.4 without changing other tags or afp/1', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'tags-v23-' });
  const path = `${dir}/song.mp3`;
  try {
    await lyricMp3(path, [], { TSSE: 'Original encoder' });
    const input = Buffer.from(await Deno.readFile(path));
    const end = 10 + input[6] * 2097152 + input[7] * 16384 + input[8] * 128 +
      input[9];
    for (let at = 10; at + 10 <= end;) {
      const length = input[at + 4] * 2097152 + input[at + 5] * 16384 +
        input[at + 6] * 128 + input[at + 7];
      input.writeUInt32BE(length, at + 4);
      at += 10 + length;
    }
    input[3] = 3;
    await Deno.writeFile(path, input);
    const before = await parseFile(path);
    assert(before.native['ID3v2.3']);
    const fingerprint = await createMedia().fingerprint(path);
    const lyrics = { text: 'New words', lang: 'eng' };
    await writeTags(path, { lyrics });
    const after = await parseFile(path);
    assert(after.native['ID3v2.4']);
    assertEquals((await Deno.readFile(path))[3], 4);
    assertEquals(
      unchangedTagFacts(after, { lyrics }),
      unchangedTagFacts(before, { lyrics }),
    );
    assertEquals(await createMedia().fingerprint(path), fingerprint);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('TagLib copy edit failure discards partial bytes and preserves original bytes, mtime and mode', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'tags-failure-' });
  const path = `${dir}/song.mp3`;
  try {
    await lyricMp3(path, [{ text: 'Original words' }]);
    const original = await Deno.readFile(path);
    const stat = await Deno.stat(path);
    const write = createTagWriter({
      editCopy: async (copy) => {
        await Deno.writeTextFile(copy, 'partial write');
        throw new Error('injected mid-write failure');
      },
    });
    await assertRejects(
      () => write(path, { lyrics: { text: 'New words' } }),
      Error,
      'injected mid-write failure',
    );
    assertEquals(await Deno.readFile(path), original);
    assertEquals((await Deno.stat(path)).mtime, stat.mtime);
    assertEquals((await Deno.stat(path)).mode, stat.mode);
    assertEquals([...Deno.readDirSync(dir)].map((e) => e.name), ['song.mp3']);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('TagLib copy verification rejects an unrelated native tag before publishing', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'tags-integrity-' });
  const path = `${dir}/song.mp3`;
  try {
    await lyricMp3(path, [{ text: 'Original words' }]);
    const original = await Deno.readFile(path);
    const write = createTagWriter({
      editCopy: async (copy) => {
        await lyricMp3(copy, [{ text: 'New words' }], {
          TIT2: 'Changed title',
        });
      },
    });
    await assertRejects(
      () => write(path, { lyrics: { text: 'New words' } }),
      Error,
      'unrelated tag',
    );
    assertEquals(await Deno.readFile(path), original);
    assertEquals([...Deno.readDirSync(dir)].map((e) => e.name), ['song.mp3']);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
