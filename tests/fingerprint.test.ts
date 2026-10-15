import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { createMedia, type Media } from '../src/media.ts';

const MP3 =
  'tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3';
const SECOND =
  'tests/fixtures/library/Fixture Artist/Fixture Album/02 - Second Song.mp3';
const VIDEO =
  'tests/fixtures/library/Fixture Artist/Fixture Album/03 - Clip.mp4';

interface Fingerprint {
  fingerprint: string | null;
  pcmMd5: string | null;
}

// Capability assertion keeps the unchanged-HEAD red run assertion-only.
function fingerprint(media = createMedia()) {
  const fn = (media as Media & {
    fingerprint?: (path: string) => Promise<Fingerprint>;
  }).fingerprint;
  assert(typeof fn === 'function', 'media.fingerprint must exist');
  return fn.bind(media);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function id3(text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const tag = new Uint8Array(10 + payload.length);
  tag.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, payload.length]);
  tag.set(payload, 10);
  return tag;
}

function ape(header: boolean): Uint8Array {
  const item = concat(
    new Uint8Array([5, 0, 0, 0, 0, 0, 0, 0]),
    new TextEncoder().encode('Title\0hello'),
  );
  const block = (isHeader: boolean) => {
    const bytes = new Uint8Array(32);
    bytes.set(new TextEncoder().encode('APETAGEX'));
    const view = new DataView(bytes.buffer);
    view.setUint32(8, 2000, true);
    view.setUint32(12, 32 + item.length, true);
    view.setUint32(16, 1, true);
    view.setUint32(
      20,
      (header ? 0x80000000 : 0) | (isHeader ? 0x20000000 : 0),
      true,
    );
    return bytes;
  };
  return concat(...(header ? [block(true)] : []), item, block(false));
}

Deno.test('fingerprint: tag edits, trailing tags and renamed copies preserve audio identity', async () => {
  const fp = fingerprint();
  const dir = await Deno.makeTempDir({ prefix: 'melofon-fingerprint-' });
  try {
    const original = await Deno.readFile(MP3);
    // Remove any existing leading ID3v2 tag before creating the variants.
    const tagSize =
      original[0] === 0x49 && original[1] === 0x44 && original[2] === 0x33
        ? 10 +
          ((original[6] << 21) | (original[7] << 14) | (original[8] << 7) |
            original[9])
        : 0;
    const audio = original.subarray(tagSize);
    const tail = new Uint8Array(128);
    tail.set(new TextEncoder().encode('TAGdifferent title'));
    const variants = [
      concat(id3('new metadata'), audio),
      concat(id3('changed metadata'), audio),
      concat(original, tail),
      concat(original, ape(true)),
      concat(original, ape(false)),
      original,
    ];
    const expected = await fp(MP3);
    assert(expected.fingerprint !== null);
    assert(/^[0-9a-f]{32}$/.test(expected.fingerprint));
    assertEquals(expected.pcmMd5, null);
    for (let i = 0; i < variants.length; i++) {
      const path = `${dir}/renamed-${i}.mp3`;
      await Deno.writeFile(path, variants[i]);
      assertEquals(await fp(path), expected, `tag variant ${i}`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('fingerprint: different audio differs', async () => {
  const fp = fingerprint();
  const first = await fp(MP3);
  const second = await fp(SECOND);
  assert(first.fingerprint !== null && second.fingerprint !== null);
  assertNotEquals(first.fingerprint, second.fingerprint);
});

Deno.test('fingerprint: video follows the probed audio stream', async () => {
  const media = createMedia();
  const fp = fingerprint(media);
  const probe = await media.probe(VIDEO);
  const got = await fp(VIDEO);
  if (probe.hasAudio) {
    assert(got.fingerprint !== null);
    assert(/^[0-9a-f]{32}$/.test(got.fingerprint));
  } else {
    assertEquals(got, { fingerprint: null, pcmMd5: null });
  }
});

Deno.test('fingerprint: deterministic across independent demuxers', async () => {
  const fp = fingerprint();
  const first = await fp(MP3);
  assert(first.fingerprint !== null);
  assertEquals(await fp(MP3), first);
});

for (const format of ['opus', 'ogg', 'aac']) {
  Deno.test(`fingerprint: transcoded ${format} copies match and differ from MP3`, async () => {
    const media = createMedia();
    const fp = fingerprint(media);
    const dir = await Deno.makeTempDir({
      prefix: 'melofon-fingerprint-transcode-',
    });
    try {
      const result = await media.transcodeAudio(MP3, format);
      assert(result !== null);
      const path = `${dir}/audio.${format}`;
      await Deno.writeFile(
        path,
        new Uint8Array(await new Response(result.stream).arrayBuffer()),
      );
      const copy = `${dir}/copy.${format}`;
      await Deno.copyFile(path, copy);
      const got = await fp(path);
      assert(got.fingerprint !== null);
      assertEquals(await fp(copy), got);
      assertNotEquals(got.fingerprint, (await fp(MP3)).fingerprint);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test('fingerprint: FLAC retains its STREAMINFO PCM checksum', async () => {
  const fp = fingerprint();
  const path = 'tests/fixtures/media/clip.flac';
  const bytes = await Deno.readFile(path);
  assertEquals(new TextDecoder().decode(bytes.subarray(0, 4)), 'fLaC');
  const md5 = Array.from(
    bytes.subarray(26, 42),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  const got = await fp(path);
  assert(got.fingerprint !== null);
  assertEquals(got.pcmMd5, /^0+$/.test(md5) ? null : md5);
});
