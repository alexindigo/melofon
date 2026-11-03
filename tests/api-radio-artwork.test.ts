import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { createRadio } from '../src/radio.ts';
import { createArtwork } from '../src/artwork.ts';
import { createLibrary } from '../src/library.ts';
import { rawSql } from '../src/store/testing.ts';
import { imageHash } from '../src/images.ts';
import { imageHeader } from '../src/image-header.ts';
import { imagePixels } from '../src/media.ts';
import { apiFixture, error } from './helpers/api.ts';
import { pixelPng } from './helpers/pixel-image.ts';

function source(red: number) {
  return pixelPng(
    7,
    3,
    new Uint8Array(
      Array.from({ length: 21 }, () => [red, 20, 40, 255]).flat(),
    ),
  );
}

async function fixture() {
  const root = await Deno.makeTempDir({ prefix: 'melofon-radio-artwork-' });
  let radio!: ReturnType<typeof createRadio>;
  let artwork!: ReturnType<typeof createArtwork>;
  const events: { types: string[]; audience: unknown }[] = [];
  const open = () =>
    apiFixture({
      storeDir: `${root}/data`,
      services: (f) => {
        f.notify!.subscribe((types, _keys, audience) =>
          events.push({ types, audience })
        );
        radio = createRadio(f.store, {
          dataDir: f.cfg.dataDir,
          state: f.state,
          notify: f.notify,
        });
        artwork = createArtwork(createLibrary(f.store), {
          state: f.state,
          dataDir: f.cfg.dataDir,
          radio,
          facts: f.store.artwork,
        });
        return Promise.resolve({ radio, artwork });
      },
    });
  let f = await open();
  const station = await radio.create({
    name: 'Station',
    streamUrl: 'http://station.home/live',
    homePageUrl: null,
  });
  assert(!('invalid' in station));
  return {
    root,
    station,
    events,
    get f() {
      return f;
    },
    get radio() {
      return radio;
    },
    get artwork() {
      return artwork;
    },
    write(
      method: 'PUT' | 'DELETE',
      credential?: string,
      bytes?: Uint8Array | ReadableStream<Uint8Array>,
      id = station.id,
      origin: string | null = f.origin,
      prefix = '',
    ) {
      const headers = new Headers({ 'Content-Type': 'image/png' });
      if (credential) {
        headers.set(
          credential.startsWith('melofon_session=')
            ? 'Cookie'
            : 'Authorization',
          credential.startsWith('melofon_session=')
            ? credential
            : `Bearer ${credential}`,
        );
      }
      if (origin) headers.set('Origin', origin);
      return f.request(`${prefix}/api/v1/radio-stations/${id}/artwork`, {
        method,
        headers,
        ...(bytes ? { body: bytes as BodyInit } : {}),
      });
    },
    async restart() {
      await f.close();
      f = await open();
    },
    async close() {
      await f.close();
      await Deno.remove(root, { recursive: true });
    },
  };
}

async function uploaded(response: Response) {
  assertEquals(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert(body.artwork);
  assertEquals(body.artwork.sourceKind, 'radio-upload');
  assertEquals([body.artwork.width, body.artwork.height, body.artwork.mime], [
    7,
    3,
    'image/png',
  ]);
  assertEquals(JSON.stringify(body).includes('radio-images'), false);
  return body.artwork as { url: string; version: string; sourceHash: string };
}

async function original(
  f: Awaited<ReturnType<typeof apiFixture>>,
  url: string,
  key: string,
  bytes: Uint8Array,
) {
  const r = await f.get(url, key);
  assertEquals(r.status, 200, await r.clone().text());
  assertEquals(r.headers.get('content-type'), 'image/png');
  assertEquals(r.headers.get('etag'), `"${await imageHash(bytes)}"`);
  assertEquals(
    r.headers.get('cache-control'),
    'private, max-age=31536000, immutable',
  );
  assertEquals(new Uint8Array(await r.arrayBuffer()), bytes);
}

Deno.test('radio artwork HTTP: upload, shared pixels/legacy delivery, replacement, restart and removal', async () => {
  const t = await fixture();
  try {
    assert(
      (await Deno.resolveDns('melofon.home', 'A')).every((ip) =>
        !ip.startsWith('127.')
      ),
    );
    const cookie = (await t.f.login()).credential;
    const fallback = await t.artwork.describe({
      kind: 'radio',
      id: t.station.id,
    });
    assert(fallback.kind === 'image');
    assertEquals(fallback.descriptor.sourceKind, 'radio-name');
    await error(
      await t.write('PUT', undefined, source(200)),
      401,
      'unauthenticated',
    );
    await error(
      await t.write(
        'PUT',
        cookie,
        source(200),
        t.station.id,
        'http://foreign.home',
      ),
      403,
      'origin',
    );
    const first = await uploaded(await t.write('PUT', cookie, source(200)));
    assertEquals(first.sourceHash, await imageHash(source(200)));
    await original(t.f, first.url, cookie, source(200));
    const repeat = await t.f.get(first.url, cookie, {
      'If-None-Match': `W/"${first.sourceHash}"`,
    });
    assertEquals(repeat.status, 304);
    assertEquals(await repeat.text(), '');
    const resized = await t.f.get(`${first.url}&size=3`, cookie);
    const small = new Uint8Array(await resized.arrayBuffer());
    assertEquals([imageHeader(small)!.width, imageHeader(small)!.height], [
      3,
      1,
    ]);
    assertEquals(
      await imagePixels(small, 3, 1),
      new Uint8Array([200, 20, 40, 255, 200, 20, 40, 255, 200, 20, 40, 255]),
    );
    const pixels = await t.artwork.pixels({ kind: 'radio', id: t.station.id }, {
      size: 7,
    });
    assert(pixels.kind === 'pixels');
    assertEquals(pixels.descriptor.sourceHash, first.sourceHash);
    assertEquals(
      pixels.rgba,
      new Uint8Array(
        Array.from({ length: 21 }, () => [200, 20, 40, 255]).flat(),
      ),
    );
    assertEquals(
      new Uint8Array(await (await t.artwork.cover(t.station.id)).arrayBuffer()),
      source(200),
    );

    // Native mutations are available to ordinary signed-in users, independent
    // of OpenSubsonic's protocol-only admin restriction.
    const created = await t.f.json('/api/v1/admin/users', 'POST', {
      username: 'listener',
      password: 'password-listener',
      role: 'user',
    }, cookie);
    assertEquals(created.status, 201, await created.clone().text());
    await created.json();
    const bearer =
      (await t.f.login('bearer', 'listener', 'password-listener')).credential;
    const second = await uploaded(await t.write('PUT', bearer, source(40)));
    assertNotEquals(second.version, first.version);
    await original(t.f, second.url, bearer, source(40));
    const stale = await t.f.get(first.url, cookie);
    assertEquals(stale.headers.get('cache-control'), 'private, no-cache');
    assertEquals(new Uint8Array(await stale.arrayBuffer()), source(40));
    await t.radio.update(t.station.id, {
      ...t.station,
      name: 'Renamed',
      streamUrl: 'https://new.home/live',
    });
    await t.restart();
    const after = (await t.f.login('bearer')).credential;
    await original(t.f, second.url, after, source(40));
    const description = await t.artwork.describe({
      kind: 'radio',
      id: t.station.id,
    });
    assert(description.kind === 'image');
    assertEquals(description.descriptor.version, second.version);
    const removed = await t.write('DELETE', after);
    assertEquals(removed.status, 200);
    await removed.json();
    const revealed = await t.f.get(second.url, after, {
      'If-None-Match': `"${second.sourceHash}"`,
    });
    assertEquals(revealed.status, 200);
    assertEquals(revealed.headers.get('cache-control'), 'private, no-cache');
    assertNotEquals(revealed.headers.get('etag'), `"${second.sourceHash}"`);
    const revealedBytes = new Uint8Array(await revealed.arrayBuffer());
    assertEquals(imageHeader(revealedBytes)?.width, 512);
    await t.restart();
    const restored = await t.artwork.snapshot({
      kind: 'radio',
      id: t.station.id,
    });
    assert(restored.kind === 'image');
    assertEquals(restored.descriptor.sourceKind, 'radio-name');
    assertEquals(restored.bytes, revealedBytes);
    assertEquals(
      Array.from(Deno.readDirSync(`${t.root}/data/radio-images`)),
      [],
    );
    assert(
      t.events.filter((e) => e.types.includes('library')).every((e) =>
        e.audience === 'all'
      ),
    );
    assertEquals(t.events.filter((e) => e.types.includes('library')).length, 3);
  } finally {
    await t.close();
  }
});

Deno.test('radio artwork HTTP: invalid, oversized, chunked and unknown uploads preserve prior bytes', async () => {
  const t = await fixture();
  try {
    const key = (await t.f.login('bearer')).credential;
    const first = await uploaded(await t.write('PUT', key, source(200)));
    for (
      const bytes of [
        new Uint8Array(),
        new Uint8Array([1, 2, 3]),
        source(10).slice(0, 33),
      ]
    ) {
      await error(await t.write('PUT', key, bytes), 400, 'invalid_image');
      await original(t.f, first.url, key, source(200));
    }
    await t.f.state.set('radio.maxArtworkPixels', '20');
    await error(await t.write('PUT', key, source(10)), 400, 'invalid_image');
    await t.f.state.set('radio.maxArtworkPixels', '64000000');
    await t.f.state.set(
      'radio.maxArtworkBytes',
      String(source(200).length - 1),
    );
    await error(await t.write('PUT', key, source(10)), 413, 'too_large');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(source(10));
        controller.close();
      },
    });
    await error(await t.write('PUT', key, stream), 413, 'too_large');
    await t.f.state.set('radio.maxArtworkBytes', '20971520');
    await error(
      await t.write('PUT', key, source(10), 'absent'),
      404,
      'not_found',
    );
    await error(
      await t.write('DELETE', key, undefined, 'absent'),
      404,
      'not_found',
    );
    await original(t.f, first.url, key, source(200));
    assertEquals(
      Array.from(Deno.readDirSync(`${t.root}/data/radio-images`)).length,
      1,
    );
    await error(
      await t.f.get('/api/v1/artwork/radio:absent', key),
      404,
      'not_found',
    );
    const result = await t.radio.putArtwork(
      t.station.id,
      new Uint8Array(20971521),
    );
    assertEquals(result, { invalid: 'too_large' });
    await original(t.f, first.url, key, source(200));
  } finally {
    await t.close();
  }
});

Deno.test('radio artwork HTTP: publication failures, concurrent replacement and station deletion retire only owned files', async () => {
  const t = await fixture();
  try {
    const key = (await t.f.login()).credential;
    const first = await uploaded(await t.write('PUT', key, source(200)));
    const directory = `${t.root}/data/radio-images`;
    await Deno.rename(directory, `${directory}-saved`);
    await Deno.writeTextFile(directory, 'not a directory');
    try {
      await error(await t.write('PUT', key, source(40)), 500, 'internal_error');
    } finally {
      await Deno.remove(directory);
      await Deno.rename(`${directory}-saved`, directory);
    }
    await original(t.f, first.url, key, source(200));
    const publish = t.f.store.radio.setArtwork;
    t.f.store.radio.setArtwork = () =>
      Promise.reject(new Error('Injected publication failure'));
    try {
      await error(await t.write('PUT', key, source(40)), 500, 'internal_error');
    } finally {
      t.f.store.radio.setArtwork = publish;
    }
    await original(t.f, first.url, key, source(200));
    assertEquals(Array.from(Deno.readDirSync(directory)).length, 1);
    await Promise.all(
      [40, 80, 120].map(async (red) =>
        uploaded(await t.write('PUT', key, source(red)))
      ),
    );
    assertEquals(Array.from(Deno.readDirSync(directory)).length, 1);
    await Deno.writeTextFile(`${directory}/unrelated.txt`, 'keep');
    await Deno.writeTextFile(
      `${directory}/${crypto.randomUUID()}.part`,
      'interrupted',
    );
    await t.restart();
    const current = await t.artwork.snapshot({
      kind: 'radio',
      id: t.station.id,
    });
    assert(current.kind === 'image');
    assert(
      [40, 80, 120].some((red) =>
        source(red).every((b, i) => b === current.bytes[i])
      ),
    );
    assertEquals(Array.from(Deno.readDirSync(directory)).length, 2);
    assertEquals(await t.radio.delete(t.station.id), true);
    const after = (await t.f.login('bearer')).credential;
    await error(
      await t.f.get(`/api/v1/artwork/radio:${t.station.id}`, after, {
        'If-None-Match': '*',
      }),
      404,
      'not_found',
    );
    assertEquals(await Deno.readTextFile(`${directory}/unrelated.txt`), 'keep');
    assertEquals(Array.from(Deno.readDirSync(directory)).map((e) => e.name), [
      'unrelated.txt',
    ]);
  } finally {
    await t.close();
  }
});

Deno.test('radio artwork HTTP: six-column installed schema upgrades without losing stations; prefixed uploads persist', async () => {
  const t = await fixture();
  try {
    // A real old schema, not a prepared fixture: migration is the subject.
    await rawSql(t.f.store).run(
      'ALTER TABLE radio_stations DROP COLUMN uploaded_artwork',
    );
    await t.restart();
    assertEquals(await t.radio.get(t.station.id), t.station);
    const next = await t.radio.create({
      name: 'Next',
      streamUrl: 'http://station.home/next',
      homePageUrl: null,
    });
    assert(!('invalid' in next));
    await t.f.state.set('server.baseUrl', 'http://melofon.home/music');
    const key = (await t.f.login('bearer')).credential;
    const art = await uploaded(
      await t.write('PUT', key, source(80), t.station.id, t.f.origin, '/music'),
    );
    assert(art.url.startsWith('/music/api/v1/artwork/radio%3A'));
    await original(t.f, art.url, key, source(80));
    await t.restart();
    const restored = (await t.f.login()).credential;
    await original(t.f, art.url, restored, source(80));
    assertEquals((await t.radio.list()).length, 2);
  } finally {
    await t.close();
  }
});

function radioUrl(id: string, version?: string) {
  return `/api/v1/artwork/${encodeURIComponent(`radio:${id}`)}${
    version ? `?v=${version}` : ''
  }`;
}

// Independent upstream glyph vectors (Unifont 18.0.01), not renderer output.
// Compare the entire decoded HTTP tile with the expected glyph mask at 5x.
function assertGlyph(pixels: Uint8Array, glyph: string) {
  const width = glyph.length / 4;
  const background = pixels.slice(0, 4);
  assertEquals(background[3], 255);
  assert(
    background.subarray(0, 3).every((value) => value >= 24 && value <= 87),
  );
  const left = (512 - width * 5) / 2;
  const top = (512 - 16 * 5) / 2;
  for (let y = 0; y < 512; y++) {
    for (let x = 0; x < 512; x++) {
      const col = Math.floor((x - left) / 5);
      const row = Math.floor((y - top) / 5);
      const ink = col >= 0 && col < width && row >= 0 && row < 16 &&
        (parseInt(glyph.slice(row * width / 4, (row + 1) * width / 4), 16) &
          (1 << (width - col - 1)));
      const i = (y * 512 + x) * 4;
      for (let c = 0; c < 4; c++) {
        assertEquals(pixels[i + c], ink ? 255 : background[c]);
      }
    }
  }
}

Deno.test('radio name tile HTTP: real Latin, Cyrillic, Greek, Chinese, Japanese and Korean glyph pixels', async () => {
  const t = await fixture();
  try {
    const cookie = (await t.f.login()).credential;
    const bearer = (await t.f.login('bearer')).credential;
    const samples = [
      ['A', '0000000018242442427E424242420000'],
      ['e\u0301', '00000C3000003C42427E4040423C0000'],
      ['\u0420', '000000007C4242427C40404040400000'],
      ['\u03a9', '000000003E4141414141221414770000'],
      [
        '\u4e2d',
        '01000100010001003FF8210821082108210821083FF821080100010001000100',
      ],
      [
        '\u65e5',
        '00001FF0101010101010101010101FF01010101010101010101010101FF01010',
      ],
      [
        '\u3042',
        '00000400020002C01F000480048007E00D101508220826082A10106000000000',
      ],
      [
        '\u30a2',
        '00000000000021F01E1000200240018001000100010002000200040008000000',
      ],
      [
        '\ud55c',
        '0000000004047FC400041F07208420841F040004000410041000100010000FFC',
      ],
    ];
    for (const [index, [name, glyph]] of samples.entries()) {
      await t.radio.update(t.station.id, { ...t.station, name });
      const response = await t.f.get(
        radioUrl(t.station.id),
        index % 2 ? cookie : bearer,
      );
      assertEquals(response.status, 200);
      assertEquals(response.headers.get('content-type'), 'image/png');
      const bytes = new Uint8Array(await response.arrayBuffer());
      assertEquals([imageHeader(bytes)!.width, imageHeader(bytes)!.height], [
        512,
        512,
      ]);
      assertGlyph(await imagePixels(bytes, 512, 512), glyph);
    }
  } finally {
    await t.close();
  }
});

Deno.test('radio name tile HTTP: stable source/palette/version across restart; name and URL edits invalidate; upload removal reveals same source', async () => {
  const t = await fixture();
  try {
    const key = (await t.f.login()).credential;
    const ref = { kind: 'radio' as const, id: t.station.id };
    const first = await t.artwork.snapshot(ref);
    assert(first.kind === 'image');
    assertEquals(first.descriptor.sourceKind, 'radio-name');
    await original(
      t.f,
      radioUrl(t.station.id, first.descriptor.version),
      key,
      first.bytes,
    );
    const firstPixels = await t.artwork.pixels(ref, { size: 73 });
    assert(firstPixels.kind === 'pixels');
    assertEquals([
      firstPixels.width,
      firstPixels.height,
      firstPixels.rgba.length,
    ], [73, 73, 73 * 73 * 4]);
    const resized = await t.f.get(`${radioUrl(t.station.id)}?size=73`, key);
    assertEquals(
      await imagePixels(new Uint8Array(await resized.arrayBuffer()), 73, 73),
      firstPixels.rgba,
    );
    assertEquals(
      new Uint8Array(await (await t.artwork.cover(t.station.id)).arrayBuffer()),
      first.bytes,
    );
    const repeat = await t.f.get(
      radioUrl(t.station.id, first.descriptor.version),
      key,
      { 'If-None-Match': `W/"${first.descriptor.sourceHash}"` },
    );
    assertEquals(repeat.status, 304);
    assertEquals(await repeat.text(), '');
    await t.restart();
    const after = (await t.f.login('bearer')).credential;
    const restored = await t.artwork.snapshot(ref);
    assert(restored.kind === 'image');
    assertEquals(restored.descriptor, first.descriptor);
    assertEquals(restored.bytes, first.bytes);
    // A new owner without the disposable cache also produces the identical PNG.
    const uncached = createArtwork(createLibrary(t.f.store), {
      radio: t.radio,
    });
    const regenerated = await uncached.snapshot(ref);
    assert(regenerated.kind === 'image');
    assertEquals(regenerated.bytes, first.bytes);
    await t.radio.update(t.station.id, {
      ...t.station,
      name: 'Different station',
    });
    const renamed = await t.artwork.snapshot(ref);
    assert(renamed.kind === 'image');
    assertNotEquals(renamed.descriptor.version, first.descriptor.version);
    const a = await imagePixels(first.bytes, 512, 512);
    const b = await imagePixels(renamed.bytes, 512, 512);
    assertEquals(a.slice(0, 4), b.slice(0, 4));
    assertNotEquals(a, b);
    await t.radio.update(t.station.id, {
      ...t.station,
      name: 'Different station',
      streamUrl: 'https://another.home/radio',
    });
    const moved = await t.artwork.snapshot(ref);
    assert(moved.kind === 'image');
    assertNotEquals(moved.descriptor.version, renamed.descriptor.version);
    const c = await imagePixels(moved.bytes, 512, 512);
    assertNotEquals(c.slice(0, 4), b.slice(0, 4));
    // The same glyph mask remains after changing the URL-derived palette.
    for (let i = 0; i < b.length; i += 4) {
      assertEquals(b[i] === 255, c[i] === 255);
    }
    const override = await uploaded(await t.write('PUT', after, source(80)));
    await original(t.f, override.url, after, source(80));
    const removal = await t.write('DELETE', after);
    assertEquals(removal.status, 200);
    await removal.json();
    await original(
      t.f,
      radioUrl(t.station.id, moved.descriptor.version),
      after,
      moved.bytes,
    );
    const stale = await t.f.get(
      radioUrl(t.station.id, first.descriptor.version),
      after,
      { 'If-None-Match': `"${first.descriptor.sourceHash}"` },
    );
    assertEquals(stale.status, 200);
    assertEquals(stale.headers.get('cache-control'), 'private, no-cache');
    assertEquals(new Uint8Array(await stale.arrayBuffer()), moved.bytes);
    // Normalization can produce identical pixels for different stored names.
    // Input identity still changes the encoded source and immutable URL version.
    await t.radio.update(t.station.id, { ...t.station, name: 'Cafe\u0301' });
    const decomposed = await t.artwork.snapshot(ref);
    await t.radio.update(t.station.id, { ...t.station, name: 'Caf\u00e9' });
    const composed = await t.artwork.snapshot(ref);
    assert(decomposed.kind === 'image' && composed.kind === 'image');
    assertEquals(
      await imagePixels(decomposed.bytes, 512, 512),
      await imagePixels(composed.bytes, 512, 512),
    );
    assertNotEquals(decomposed.descriptor.version, composed.descriptor.version);
    assertNotEquals(
      decomposed.descriptor.sourceHash,
      composed.descriptor.sourceHash,
    );
  } finally {
    await t.close();
  }
});

Deno.test('radio name tile HTTP: bounded wrapped text, size settings and unavailable admission are retryable', async () => {
  const t = await fixture();
  try {
    const key = (await t.f.login('bearer')).credential;
    const ref = { kind: 'radio' as const, id: t.station.id };
    const before = await t.artwork.describe(ref);
    assert(before.kind === 'image');
    await t.f.state.set('artwork.radioTileSize', '64');
    await t.f.state.set('artwork.radioTileCharacters', '12');
    await t.radio.update(t.station.id, {
      ...t.station,
      name: 'Long unbroken name: \u4e2d\u6587'.repeat(100),
    });
    const result = await t.f.get(radioUrl(t.station.id), key);
    assertEquals(result.status, 200);
    const bytes = new Uint8Array(await result.arrayBuffer());
    assertEquals([imageHeader(bytes)!.width, imageHeader(bytes)!.height], [
      64,
      64,
    ]);
    const pixels = await imagePixels(bytes, 64, 64);
    assert(pixels.some((v, i) => i % 4 === 0 && v === 255));
    // Text is wrapped inside the padding, never clipped into the border.
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        if (x < 4 || y < 4 || x >= 60 || y >= 60) {
          assertEquals(pixels[(y * 64 + x) * 4], pixels[0]);
        }
      }
    }
    const changed = await t.artwork.describe(ref);
    assert(changed.kind === 'image');
    assertNotEquals(changed.descriptor.version, before.descriptor.version);
    await t.f.state.set('artwork.maxPixels', '4095');
    assertEquals(
      (await t.artwork.pixels(ref, { size: 10 })).kind,
      'unavailable',
    );
    await t.f.state.set('artwork.maxPixels', '64000000');
    await t.f.state.set('artwork.maxSourceMegabytes', '0');
    assertEquals(
      (await t.artwork.pixels(ref, { size: 10 })).kind,
      'unavailable',
    );
    await t.f.state.set('artwork.maxSourceMegabytes', '20');
    assertEquals((await t.artwork.pixels(ref, { size: 10 })).kind, 'pixels');
  } finally {
    await t.close();
  }
});
