import { assert, assertEquals, assertRejects } from '@std/assert';
import { createMedia } from '../src/media.ts';
import { createNetwork } from '../src/lookups/net.ts';
import { createRadioSource } from '../src/radio-source.ts';
import { createPlaybackSource } from '../src/playback-source.ts';
import { createQueueResolver } from '../src/queue-source.ts';
import { createPlayback, type Playback } from '../src/playback.ts';
import { createOutputs, createPlayer, planRestore } from '../src/player.ts';
import { createLibrary } from '../src/library.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { httpRadio, type RadioReply } from './helpers/http-radio.ts';
import { apiFixture } from './helpers/api.ts';
import { until } from './helpers/speaker-consumer.ts';

const encode = (text: string) => new TextEncoder().encode(text);
const resolve = createQueueResolver({
  getSong: () => Promise.resolve(null),
  getStation: () => Promise.resolve(null),
});
async function urlMedia(url: string) {
  const item = await resolve({ kind: 'url', url });
  assert(item);
  return item;
}
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
function wav() {
  const bytes = new Uint8Array(44 + 44100 * 4);
  const view = new DataView(bytes.buffer);
  for (
    const [at, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [
      36,
      'data',
    ]] as const
  ) {
    bytes.set(encode(text), at);
  }
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 44100, true);
  view.setUint32(28, 176400, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, bytes.length - 44, true);
  for (let i = 44; i < bytes.length; i += 2) {
    view.setInt16(i, i % 13001 - 6500, true);
  }
  return bytes;
}
async function compressed(format: string) {
  const result = await createMedia().transcodeAudio(
    'tests/fixtures/media/clip.flac',
    format,
  );
  assert(result);
  const bytes = new Uint8Array(await new Response(result.stream).arrayBuffer());
  await result.completion;
  return bytes;
}
function sources(settings: Record<string, number> = {}) {
  return createPlaybackSource({
    media: createMedia(),
    radio: createRadioSource({ network: createNetwork() }),
    state: { declare() {}, getTyped: (key) => Promise.resolve(settings[key]) },
  });
}
async function fixture() {
  let playback!: Playback;
  const f = await apiFixture({
    hats: {
      layersRoot: 'layers',
      extraPorts: 1,
      env: ([port]) => ({ MELOFON_LISTEN_owntone: `${port},${port}` }),
    },
    services(f) {
      const library = createLibrary(f.store);
      const outputs = createOutputs({ notify: f.notify });
      const source = createPlaybackSource({
        media: createMedia(),
        state: f.state,
        radio: createRadioSource({
          network: createNetwork({ state: f.state }),
          state: f.state,
        }),
      });
      playback = createPlayback({
        player: createPlayer(),
        outputs,
        library,
        cfg: f.cfg,
        nowPlaying: createNowPlaying(f.store),
        notify: f.notify,
        prepareQueueMedia: source.prepare,
        resolveQueueReference: resolve,
      });
      return Promise.resolve({ playback, library, outputs });
    },
  });
  return {
    f,
    playback,
    async own(path: string, method = 'GET') {
      const response = await fetch(
        `http://melofon.home:${f.extraPorts[0]}/api${path}`,
        {
          method,
          signal: AbortSignal.timeout(5000),
        },
      );
      const body = await response.text();
      assertEquals(response.status, method === 'GET' ? 200 : 204, body);
      return body ? JSON.parse(body) : undefined;
    },
    async close() {
      await playback.close();
      await f.close();
    },
  };
}

Deno.test('URL preparation publishes finite slow speech duration before queue events and first real OwnTone read', async () => {
  const bytes = wav();
  let release!: () => void;
  const barrier = new Promise<void>((done) => release = done);
  let waiting = false;
  const server = httpRadio(() => ({
    headers: { 'content-type': 'application/octet-stream' },
    body: (async function* () {
      yield bytes.subarray(0, 8192);
      waiting = true;
      await barrier;
      for (let i = 8192; i < bytes.length; i += 4093) {
        await sleep(1);
        yield bytes.subarray(i, i + 4093);
      }
    })(),
  }));
  const t = await fixture();
  const published: (number | null)[] = [];
  const unsubscribe = t.f.notify.subscribe((types) => {
    if (!types.includes('queue')) return;
    const item = t.playback.queueView().items[0];
    if (item?.facts.kind === 'web') published.push(item.facts.durationMs);
  });
  try {
    const pending = t.playback.queueAddSources([
      await urlMedia(`${server.origin}/speech`),
    ], { clear: true });
    await until(() => waiting);
    assertEquals((await t.own('/queue')).items, []);
    const events = t.f.notifications.length;
    // Network preparation must never occupy the store connection.
    assertEquals(
      await t.f.state.getTyped('playback.source.prepareBytes'),
      1048576,
    );
    assertEquals(t.f.notifications.length, events);
    release();
    const added = await pending;
    const queue = await t.own('/queue');
    assertEquals(queue.items[0].length_ms, 1000);
    assertEquals(queue.items[0].id, added[0].id);
    assertEquals(queue.items[0].data_kind, 'http');
    assert(added[0].facts.kind === 'web');
    assertEquals(added[0].facts.mode, 'finite');
    assertEquals(published, [1000]);
    assertEquals(
      (await createLibrary(t.f.store).listSongs({ size: 10, offset: 0 }))
        .length,
      0,
    );
    await until(() => server.closed === 1);
  } finally {
    release();
    unsubscribe();
    await t.close();
    await server.close();
  }
});

Deno.test('URL preparation derives finite MP3 and raw AAC length from complete bounded audio, without MIME or Content-Length', async () => {
  for (const format of ['mp3', 'aac']) {
    const bytes = await compressed(format);
    const server = httpRadio(() => ({ body: [bytes] }));
    try {
      const owner = sources();
      const item = await owner.prepare(
        await urlMedia(`${server.origin}/${format}`),
        new AbortController().signal,
      );
      assert(item.facts.kind === 'web');
      assertEquals(item.facts.mode, 'finite');
      let length = 0;
      const pcm = await owner.open(item, {
        signal: new AbortController().signal,
        startMs: 0,
      });
      assert(pcm);
      for await (const part of pcm) length += part.length;
      assert(length > 0);
      assertEquals(item.facts.durationMs, Math.round(length / 176400 * 1000));
      await until(() => server.closed === 2);
    } finally {
      await server.close();
    }
  }
});

Deno.test('URL preparation accepts ICY and ambiguous usable audio as live-like; OwnTone seek is a true no-op', async () => {
  const bytes = await compressed('mp3');
  const server = httpRadio((request, signal) => ({
    headers: new URL(request.url).pathname === '/icy'
      ? { 'icy-name': 'A station' }
      : undefined,
    body: (async function* () {
      yield bytes;
      await new Promise<void>((done) =>
        signal.addEventListener('abort', () => done(), { once: true })
      );
    })(),
  }));
  const t = await fixture();
  try {
    await t.f.state.set('playback.source.prepareTimeoutMs', '100');
    for (const path of ['/icy', '/ambiguous']) {
      const added = await t.playback.queueAddSources([
        await urlMedia(`${server.origin}${path}`),
      ], { clear: true, play: true });
      const facts = added[0].facts;
      assert(facts.kind === 'web');
      assertEquals([facts.mode, facts.durationMs, facts.seekable], [
        'live',
        null,
        false,
      ]);
      assertEquals((await t.own('/queue')).items[0].length_ms, 0);
      const before = t.playback.playerView();
      const events = t.f.notifications.length;
      await t.own('/player/seek?position_ms=5000', 'PUT');
      assertEquals(t.playback.playerView().generation, before.generation);
      assertEquals(t.f.notifications.length, events);
      assertEquals(server.requests.length, path === '/icy' ? 1 : 2);
      await until(() => server.closed === server.requests.length);
    }
  } finally {
    await t.close();
    await server.close();
  }
});

Deno.test('URL preparation failures leave old queue, bookmark, options and revision intact even with clear/play', async () => {
  const server = httpRadio((request): RadioReply => {
    switch (new URL(request.url).pathname) {
      case '/ok':
        return { body: [wav()] };
      case '/http':
        return { statusLine: 'HTTP/1.1 503 Unavailable' };
      case '/hls.m3u':
        return { body: [encode('#EXTM3U\n#EXT-X-TARGETDURATION:1\n/child\n')] };
      case '/icy':
        return { headers: { 'icy-metaint': '0' }, body: [wav()] };
      default:
        return { body: [encode('<html>not audio</html>')] };
    }
  });
  const t = await fixture();
  try {
    await t.playback.queueAddSources([await urlMedia(`${server.origin}/ok`)], {
      play: true,
    });
    t.playback.pause();
    const before = t.playback.playerView();
    const queue = await t.own('/queue');
    const command = t.playback.lastCommand();
    const events = t.f.notifications.length;
    for (const path of ['/http', '/hls.m3u', '/icy', '/page']) {
      await assertRejects(async () =>
        await t.playback.queueAddSources([
          await urlMedia(`${server.origin}/ok`),
          await urlMedia(`${server.origin}${path}`),
        ], { clear: true, play: true, shuffle: true })
      );
      assertEquals(await t.own('/queue'), queue);
      assertEquals(t.playback.playerView(), before);
      assertEquals(t.playback.lastCommand(), command);
      assertEquals(t.f.notifications.length, events);
    }
    assert(!server.requests.some((r) => new URL(r.url).pathname === '/child'));
    await until(() => server.closed === server.requests.length);
  } finally {
    await t.close();
    await server.close();
  }
});

Deno.test('newer clear revokes parked URL preparation and cannot publish its stale queue', async () => {
  let parked = false;
  const server = httpRadio((_request, signal) => ({
    body: (async function* () {
      yield encode('ID3');
      parked = true;
      await new Promise<void>((done) =>
        signal.addEventListener('abort', () => done(), { once: true })
      );
    })(),
  }));
  const t = await fixture();
  try {
    for (const restoring of [false, true]) {
      parked = false;
      const item = await urlMedia(`${server.origin}/parked`);
      const pending = restoring
        ? t.playback.restore({
          queue: [{ ...item, id: 41 }],
          nextId: 42,
          version: 10,
          state: 'play',
          currentIndex: 0,
          positionMs: 0,
          repeat: 'off',
          shuffle: false,
          consume: false,
        })
        : t.playback.queueAddSources([item], { clear: true, play: true });
      const rejected = assertRejects(() => Promise.resolve(pending));
      await until(() => parked);
      t.playback.queueClear();
      await rejected;
      await until(() => server.closed === server.requests.length);
      assertEquals((await t.own('/queue')).items, []);
      assertEquals((await t.own('/player')).state, 'stop');
    }
    assertEquals(server.requests.length, 2);
  } finally {
    await t.close();
    await server.close();
  }
});

Deno.test('finite URL seek decodes forward to exact PCM samples and restored unknown facts prepare on activation', async () => {
  const bytes = wav();
  const server = httpRadio(() => ({ body: [bytes] }));
  const t = await fixture();
  try {
    const reference = { kind: 'url' as const, url: `${server.origin}/speech` };
    const snapshot = await planRestore({
      queue: { items: [{ id: 41, reference }], nextId: 42, version: 10 },
      saved: {
        state: 'pause',
        currentIndex: 0,
        positionMs: 0,
        repeat: 'off',
        shuffle: false,
        consume: false,
        updatedAtMs: 0,
      },
      resolve,
      nowMs: 1000,
      maxAgeMs: 0,
      selectedOutputPresent: false,
    });
    assert(snapshot);
    await t.playback.restore(snapshot);
    assertEquals(server.requests.length, 0);
    await t.playback.play();
    assertEquals((await t.own('/queue')).items[0].length_ms, 1000);
    const item = t.playback.queueView().items[0];
    assertEquals(item.id, 41);
    const pcm = await sources().open(item, {
      signal: new AbortController().signal,
      startMs: 250,
    });
    assert(pcm);
    let offset = 44 + 44100 * 4 / 4;
    for await (const part of pcm) {
      assertEquals(part, bytes.subarray(offset, offset + part.length));
      offset += part.length;
    }
    assertEquals(offset, bytes.length);
    await until(() => server.closed === 2);
  } finally {
    await t.close();
    await server.close();
  }
});

Deno.test('URL preparation byte budget is owner-declared and incomplete usable audio stays unknown-length', async () => {
  const bytes = await compressed('mp3');
  const server = httpRadio(() => ({
    body: (function* () {
      for (let i = 0; i < 100; i++) yield bytes;
    })(),
  }));
  const t = await fixture();
  try {
    await assertRejects(() =>
      t.f.state.set('playback.source.prepareBytes', '0')
    );
    await assertRejects(() =>
      t.f.state.set('playback.source.prepareTimeoutMs', '0')
    );
    await t.f.state.set('playback.source.prepareBytes', '8192');
    const added = await t.playback.queueAddSources([
      await urlMedia(`${server.origin}/many`),
    ], { clear: true });
    assert(added[0].facts.kind === 'web');
    assertEquals(added[0].facts.mode, 'live');
    assertEquals(added[0].facts.durationMs, null);
    await until(() => server.closed === 1);
  } finally {
    await t.close();
    await server.close();
  }
});

Deno.test('auto-resume prepares fresh URL facts; an unavailable restored URL keeps its occurrence paused', async () => {
  const server = httpRadio((request) =>
    new URL(request.url).pathname === '/ok'
      ? { body: [wav()] }
      : { statusLine: 'HTTP/1.1 503 Unavailable' }
  );
  const t = await fixture();
  try {
    for (const path of ['/ok', '/unavailable']) {
      const item = await urlMedia(`${server.origin}${path}`);
      await t.playback.restore({
        queue: [{ ...item, id: 41 }],
        nextId: 42,
        version: 10,
        state: 'play',
        currentIndex: 0,
        positionMs: 0,
        repeat: 'off',
        shuffle: false,
        consume: false,
      });
      const queue = await t.own('/queue');
      assertEquals(queue.items[0].id, 41);
      assertEquals(queue.items[0].length_ms, path === '/ok' ? 1000 : 0);
      assertEquals(
        (await t.own('/player')).state,
        path === '/ok' ? 'play' : 'pause',
      );
    }
    await until(() => server.closed === 2);
  } finally {
    await t.close();
    await server.close();
  }
});

Deno.test('bounded prefix preparation retains a finite container duration without reading the full body', async () => {
  const bytes = wav();
  const server = httpRadio((_request, signal) => ({
    headers: { 'content-length': String(bytes.length) },
    body: (async function* () {
      yield bytes.subarray(0, 8192);
      await new Promise<void>((done) =>
        signal.addEventListener('abort', () => done(), { once: true })
      );
    })(),
  }));
  try {
    const item = await sources({ 'playback.source.prepareBytes': 8192 })
      .prepare(
        await urlMedia(`${server.origin}/speech`),
        new AbortController().signal,
      );
    assert(item.facts.kind === 'web');
    assertEquals(item.facts.mode, 'finite');
    assertEquals(item.facts.durationMs, 1000);
    await until(() => server.closed === 1);
  } finally {
    await server.close();
  }
});
