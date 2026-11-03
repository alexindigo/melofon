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
    assertEquals(
      (await t.artwork.describe({ kind: 'radio', id: t.station.id })).kind,
      'missing',
    );
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
    const missing = await t.f.get(second.url, after, { 'If-None-Match': '*' });
    assertEquals(missing.headers.get('cache-control'), 'no-store');
    assertEquals(missing.headers.get('etag'), null);
    await missing.arrayBuffer();
    await t.restart();
    assertEquals(
      (await t.artwork.describe({ kind: 'radio', id: t.station.id })).kind,
      'missing',
    );
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
