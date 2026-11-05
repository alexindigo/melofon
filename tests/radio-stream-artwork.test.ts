import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { createRadio } from '../src/radio.ts';
import { createArtwork } from '../src/artwork.ts';
import { createLibrary } from '../src/library.ts';
import { createNetwork } from '../src/lookups/net.ts';
import { createPlaybackSource } from '../src/playback-source.ts';
import { createRadioSource } from '../src/radio-source.ts';
import { createQueueResolver } from '../src/queue-source.ts';
import { createMedia, imagePixels } from '../src/media.ts';
import { rawSql } from '../src/store/testing.ts';
import { apiFixture } from './helpers/api.ts';
import { pixelPng } from './helpers/pixel-image.ts';
import { httpRadio, icyBlock, type RadioReply } from './helpers/http-radio.ts';
import { speakerMedia } from './helpers/speaker-consumer.ts';

async function until(predicate: () => boolean | Promise<boolean>) {
  const end = performance.now() + 20000;
  while (!await predicate()) {
    assert(performance.now() < end, 'Radio artwork outcome timed out');
    await new Promise((done) => setTimeout(done, 10));
  }
}

const image = (red: number) =>
  pixelPng(
    3,
    1,
    new Uint8Array([red, 20, 40, 255, red, 20, 40, 255, red, 20, 40, 255]),
  );

async function fixture() {
  const root = await Deno.makeTempDir({ prefix: 'stream-artwork-' });
  let radio!: ReturnType<typeof createRadio>;
  let artwork!: ReturnType<typeof createArtwork>;
  let sources!: ReturnType<typeof createPlaybackSource>;
  const open = () =>
    apiFixture({
      storeDir: `${root}/data`,
      services(f) {
        const network = createNetwork({ state: f.state });
        radio = createRadio(f.store, {
          dataDir: f.cfg.dataDir,
          state: f.state,
          notify: f.notify,
          network,
        });
        sources = createPlaybackSource({
          media: createMedia(),
          artwork: radio,
          radio: createRadioSource({ network, state: f.state }),
        });
        artwork = createArtwork(createLibrary(f.store), {
          radio,
          state: f.state,
          dataDir: f.cfg.dataDir,
          facts: f.store.artwork,
        });
        return Promise.resolve({ radio, artwork });
      },
    });
  let f = await open();
  return {
    root,
    get f() {
      return f;
    },
    get radio() {
      return radio;
    },
    async station(url: string) {
      const station = await radio.create({
        name: 'Station',
        streamUrl: url,
        homePageUrl: null,
      });
      assert(!('invalid' in station));
      return station;
    },
    async start(id: string) {
      const resolve = createQueueResolver({
        getSong: () => Promise.resolve(null),
        getStation: radio.get,
      });
      const media = await resolve({ kind: 'station', id });
      assert(media);
      const stop = new AbortController();
      let count = 0;
      const running = (async () => {
        const pcm = await sources.open(media, {
          signal: stop.signal,
          startMs: 0,
        });
        assert(pcm);
        for await (const chunk of pcm) count += chunk.length;
      })().catch((error) => {
        if (!stop.signal.aborted) throw error;
      });
      return {
        get bytes() {
          return count;
        },
        async close() {
          stop.abort();
          await running;
        },
      };
    },
    async art(id: string, key: string) {
      const response = await f.get(`/api/v1/radio-stations/${id}`, key);
      assertEquals(response.status, 200);
      const wire = (await response.json()).radioStation.artwork;
      const core = await artwork.describe({ kind: 'radio', id });
      assert(core.kind === 'image');
      // Source provenance stays in core; the consumer receives a local URL and
      // version. Tests below fetch that URL and verify its actual image bytes.
      return {
        ...wire,
        sourceKind: core.descriptor.sourceKind,
        sourceHash: core.descriptor.sourceHash,
      } as {
        sourceKind: string;
        version: string;
        url: string;
        sourceHash: string;
      };
    },
    async bytes(url: string, key: string) {
      const response = await f.get(url, key);
      assertEquals(response.status, 200);
      return new Uint8Array(await response.arrayBuffer());
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

async function liveStation() {
  const dir = await Deno.makeTempDir({ prefix: 'artwork-icy-' });
  await speakerMedia(dir);
  const wav = await Deno.readFile(`${dir}/media/signal.wav`);
  new DataView(wav.buffer).setUint32(4, 0xffffffff, true);
  new DataView(wav.buffer).setUint32(40, 0xffffffff, true);
  let send: ((value: string | null) => void) | undefined;
  const server = httpRadio((request, signal): RadioReply => {
    const path = new URL(request.url).pathname;
    if (path !== '/live') {
      return {
        headers: { 'content-type': 'image/png' },
        body: [image(path === '/a' ? 200 : 40)],
      };
    }
    assertEquals(request.headers.get('icy-metadata'), '1');
    return {
      headers: { 'content-type': 'audio/wav', 'icy-metaint': '65536' },
      body: (async function* () {
        let at = 0;
        while (!signal.aborted) {
          yield wav.subarray(at, at + 65536);
          at += 65536;
          const value = await new Promise<string | null>((done) => {
            send = done;
            if (signal.aborted) done(null);
            else {signal.addEventListener('abort', () => done(null), {
                once: true,
              });}
          });
          send = undefined;
          yield value === null ? new Uint8Array([0]) : icyBlock(value);
        }
      })(),
    };
  }, { requireMetadata: false });
  return {
    server,
    async send(value: string | null) {
      await until(() => !!send);
      const done = send!;
      send = undefined;
      done(value);
      await until(() => !!send);
    },
    async close() {
      await server.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('ICY StreamUrl -> core acquisition -> native versioned image; upload precedence, replacement and durable shared art', async () => {
  const live = await liveStation();
  const t = await fixture();
  let stream: Awaited<ReturnType<typeof t.start>> | undefined;
  try {
    const station = await t.station(`${live.server.origin}/live`);
    const cookie = (await t.f.login()).credential;
    const bearer = (await t.f.login('bearer')).credential;
    const fallback = await t.art(station.id, cookie);
    assertEquals(fallback.sourceKind, 'radio-name');
    stream = await t.start(station.id);
    await live.send(`StreamTitle='First';StreamUrl='${live.server.origin}/a';`);
    await until(async () =>
      (await t.art(station.id, cookie)).sourceKind === 'radio-stream'
    );
    const first = await t.art(station.id, cookie);
    assertEquals(await t.bytes(first.url, cookie), image(200));
    assertEquals(
      await imagePixels(await t.bytes(first.url, bearer), 3, 1),
      new Uint8Array([200, 20, 40, 255, 200, 20, 40, 255, 200, 20, 40, 255]),
    );
    const repeat = await t.f.get(first.url, bearer, {
      'If-None-Match': `W/"${first.sourceHash}"`,
    });
    assertEquals(repeat.status, 304);
    await repeat.text();
    const requests = live.server.requests.length;
    await live.send(null);
    await live.send(`StreamUrl='${live.server.origin}/a';`);
    assertEquals((await t.art(station.id, cookie)).version, first.version);
    assertEquals(
      live.server.requests.length,
      requests,
      'zero blocks/duplicates do not refetch',
    );
    const upload = await t.f.request(
      `/api/v1/radio-stations/${station.id}/artwork`,
      {
        method: 'PUT',
        headers: { Cookie: cookie, Origin: t.f.origin },
        body: image(90),
      },
    );
    assertEquals(upload.status, 200);
    const uploaded = (await upload.json()).artwork;
    await live.send(`StreamUrl='${live.server.origin}/b';`);
    await until(() =>
      live.server.requests.some((r) => new URL(r.url).pathname === '/b')
    );
    // Wait for acquisition publication while the higher-priority upload remains visible.
    await until(async () => !!await t.f.store.radio.streamArtwork(station.id));
    assertEquals(await t.bytes(uploaded.url, bearer), image(90));
    const removal = await t.f.request(
      `/api/v1/radio-stations/${station.id}/artwork`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${bearer}`, Origin: t.f.origin },
      },
    );
    assertEquals(removal.status, 200);
    await removal.text();
    const second = await t.art(station.id, bearer);
    assertEquals(second.sourceKind, 'radio-stream');
    assertNotEquals(second.version, first.version);
    assertEquals(await t.bytes(second.url, bearer), image(40));
    const stale = await t.f.get(first.url, cookie);
    assertEquals(stale.headers.get('cache-control'), 'private, no-cache');
    assertEquals(new Uint8Array(await stale.arrayBuffer()), image(40));
    await until(() => stream!.bytes > 0);
    assertEquals(
      live.server.requests.filter((r) => new URL(r.url).pathname === '/live')
        .length,
      1,
    );
    await stream.close();
    stream = undefined;
    await t.restart();
    const key = (await t.f.login('bearer')).credential;
    assertEquals((await t.art(station.id, key)).version, second.version);
    assertEquals(await t.bytes(second.url, key), image(40));
    assert(t.f.notifications.every((names) => !names.includes('queue')));
  } finally {
    await stream?.close();
    await t.close();
    await live.close();
  }
});

Deno.test('stream artwork validates bytes/MIME/budgets and keeps entered-host trust across direct and redirected metadata', async () => {
  const forbidden = httpRadio(() => ({ body: [image(1)] }), {
    requireMetadata: false,
  });
  const external = forbidden.origin.replace('melofon.home', '127.0.0.1');
  const server = httpRadio((r): RadioReply => {
    const path = new URL(r.url).pathname;
    if (path === '/redirect') {
      return {
        statusLine: 'HTTP/1.1 302 Found',
        headers: { location: external },
      };
    }
    if (path === '/same') {
      return {
        statusLine: 'HTTP/1.1 302 Found',
        headers: { location: '/valid' },
      };
    }
    if (path === '/html') {
      return {
        headers: { 'content-type': 'text/html' },
        body: [new TextEncoder().encode('<html>page</html>')],
      };
    }
    return {
      headers: { 'content-type': path === '/mime' ? 'text/html' : 'image/png' },
      body: [path === '/corrupt' ? image(2).slice(0, 33) : image(200)],
    };
  }, { requireMetadata: false });
  const t = await fixture();
  try {
    const station = await t.station(`${server.origin}/live`);
    const key = (await t.f.login('bearer')).credential;
    const fallback = await t.art(station.id, key);
    const tile = await t.bytes(fallback.url, key);
    const session = t.radio.streamArtwork(
      station.id,
      station.streamUrl,
      new AbortController().signal,
    );
    try {
      await session.observe(`${server.origin}/same`);
      await until(async () =>
        (await t.art(station.id, key)).sourceKind === 'radio-stream'
      );
      assertEquals(
        await t.bytes((await t.art(station.id, key)).url, key),
        image(200),
      );
      for (
        const url of [
          external,
          `${server.origin}/redirect`,
          `${server.origin}/html`,
          `${server.origin}/mime`,
          `${server.origin}/corrupt`,
          'file:///etc/passwd',
          '',
          'https://user:password@example.test/image',
        ]
      ) {
        await session.observe(url);
        await until(async () =>
          (await t.art(station.id, key)).sourceKind === 'radio-name'
        );
        assertEquals(await t.bytes(fallback.url, key), tile);
      }
      await session.close();
      assertEquals(
        forbidden.requests.length,
        0,
        'different private host never contacted, including redirect',
      );
      for (
        const [setting, value] of [['radio.maxArtworkPixels', '2'], [
          'radio.maxArtworkBytes',
          '20',
        ]] as const
      ) {
        await t.f.state.set(setting, value);
        const limited = t.radio.streamArtwork(
          station.id,
          station.streamUrl,
          new AbortController().signal,
        );
        await limited.observe(`${server.origin}/valid`);
        await limited.close();
        assertEquals((await t.art(station.id, key)).sourceKind, 'radio-name');
        await t.f.state.set(
          setting,
          setting.endsWith('Pixels') ? '64000000' : '20971520',
        );
      }
    } finally {
      await session.close();
    }
  } finally {
    await t.close();
    await server.close();
    await forbidden.close();
  }
});

Deno.test('stream artwork rejects late old metadata, closed generations and edited/deleted stations; existing installs migrate', async () => {
  const release: (() => void)[] = [];
  const server = httpRadio((request, signal) => {
    if (new URL(request.url).pathname === '/slow') {
      return {
        headers: { 'content-type': 'image/png' },
        body: (async function* () {
          await new Promise<void>((done) => {
            release.push(done);
            signal.addEventListener('abort', () => done(), { once: true });
          });
          if (!signal.aborted) yield image(200);
        })(),
      };
    }
    return { headers: { 'content-type': 'image/png' }, body: [image(40)] };
  }, { requireMetadata: false });
  const t = await fixture();
  try {
    const station = await t.station(`${server.origin}/live`);
    let key = (await t.f.login('bearer')).credential;
    await t.radio.putArtwork(station.id, image(90));
    await rawSql(t.f.store).run(
      'ALTER TABLE radio_stations DROP COLUMN stream_artwork',
    );
    await t.restart();
    key = (await t.f.login('bearer')).credential;
    assertEquals(
      await t.bytes((await t.art(station.id, key)).url, key),
      image(90),
    );
    await t.radio.removeArtwork(station.id);
    const old = t.radio.streamArtwork(
      station.id,
      station.streamUrl,
      new AbortController().signal,
    );
    old.observe(`${server.origin}/slow`);
    await until(() => release.length === 1);
    old.observe(`${server.origin}/fast`);
    await until(async () =>
      (await t.art(station.id, key)).sourceKind === 'radio-stream'
    );
    const current = await t.art(station.id, key);
    release[0]();
    await old.close();
    assertEquals(await t.bytes(current.url, key), image(40));
    const superseded = t.radio.streamArtwork(
      station.id,
      station.streamUrl,
      new AbortController().signal,
    );
    superseded.observe(`${server.origin}/slow`);
    await until(() => release.length === 2);
    const replacement = t.radio.streamArtwork(
      station.id,
      station.streamUrl,
      new AbortController().signal,
    );
    await replacement.observe(`${server.origin}/fast`);
    release[1]();
    await superseded.close();
    superseded.observe(`${server.origin}/slow`);
    await replacement.close();
    assertEquals(
      await t.bytes((await t.art(station.id, key)).url, key),
      image(40),
    );
    const aborted = new AbortController();
    const late = t.radio.streamArtwork(
      station.id,
      station.streamUrl,
      aborted.signal,
    );
    late.observe(`${server.origin}/slow`);
    await until(() => release.length === 3);
    aborted.abort();
    await late.close();
    release[2]();
    assertEquals((await t.art(station.id, key)).sourceKind, 'radio-name');
    const edited = t.radio.streamArtwork(
      station.id,
      station.streamUrl,
      new AbortController().signal,
    );
    edited.observe(`${server.origin}/slow`);
    await until(() => release.length === 4);
    await t.radio.update(station.id, {
      ...station,
      streamUrl: `${server.origin}/new`,
    });
    release[3]();
    await edited.close();
    assertEquals((await t.art(station.id, key)).sourceKind, 'radio-name');
    const fresh = t.radio.streamArtwork(
      station.id,
      `${server.origin}/new`,
      new AbortController().signal,
    );
    fresh.observe(`${server.origin}/fast`);
    await until(async () =>
      (await t.art(station.id, key)).sourceKind === 'radio-stream'
    );
    const deleted = t.radio.streamArtwork(
      station.id,
      `${server.origin}/new`,
      new AbortController().signal,
    );
    deleted.observe(`${server.origin}/slow`);
    await until(() => release.length === 5);
    await t.radio.delete(station.id);
    release[4]();
    await Promise.all([fresh.close(), deleted.close()]);
    const response = await t.f.get(current.url, key, { 'If-None-Match': '*' });
    assertEquals(response.status, 404);
    await response.text();
    assertEquals(
      Array.from(Deno.readDirSync(`${t.root}/data/radio-images`)),
      [],
    );
  } finally {
    for (const done of release) done();
    await t.close();
    await server.close();
  }
});
