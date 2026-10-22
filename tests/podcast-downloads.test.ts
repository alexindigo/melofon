import { assert, assertEquals, assertRejects } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { createState } from '../src/state.ts';
import { createPodcasts } from '../src/podcasts.ts';
import { createNetwork } from '../src/lookups/net.ts';
import { createMedia } from '../src/media.ts';
import { createLibrary } from '../src/library.ts';
import { createArtwork } from '../src/artwork.ts';
import { imageHeader } from '../src/image-header.ts';
import { createStream } from '../src/stream.ts';
import { createFileSource } from '../src/file-source.ts';
import { createPlayback } from '../src/playback.ts';
import { createOutputs, createPlayer } from '../src/player.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { seedFirstUser } from '../src/users.ts';
import { createUserService } from '../src/user.ts';
import { createBinds } from '../src/binds.ts';
import { loadLayers } from '../src/layers.ts';
import { facade } from '../src/facade.ts';

const AUTH = 'u=admin&p=test&v=1.16.1&c=p2&f=json';
const fixture = 'tests/fixtures/library/Fixture Artist/Fixture Album';
const item = (n: number, url = `https://files.test/${n}.mp3`) =>
  `<item><guid>${n}</guid><title>Episode ${n}</title><pubDate>${
    new Date(Date.UTC(2026, 9, n)).toUTCString()
  }</pubDate><enclosure url="${url}" type="audio/mpeg"/><itunes:duration>9999</itunes:duration></item>`;
const feed = (items: string, image = true) =>
  `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>P2 Show</title>${
    image ? '<itunes:image href="https://images.test/cover.jpg"/>' : ''
  }${items}</channel></rss>`;

async function setup(auto: number | null = 0) {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-p2-' });
  const dataDir = `${dir}/data`;
  let store = await openStore(dataDir);
  let state = createState(store);
  const media = createMedia();
  const audio = await Deno.readFile(`${fixture}/01 - First Song.mp3`);
  const picture = await Deno.readFile(`${fixture}/cover.jpg`);
  let xml = feed(item(1));
  let imageType = 'image/jpeg';
  let imageBytes = picture;
  let audioBytes = audio;
  let audioStatus = 200;
  let release: Promise<void> = Promise.resolve();
  let started = Promise.withResolvers<void>();
  const hits: string[] = [];
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request): Promise<Response> => {
      const path = new URL(request.url).pathname;
      hits.push(path);
      if (path === '/feed') return new Response(xml);
      if (path === '/cover.jpg') {
        return new Response(imageBytes, {
          headers: { 'content-type': imageType },
        });
      }
      if (path === '/redirect.mp3') {
        return new Response(null, {
          status: 302,
          headers: {
            location: `http://127.0.0.1:${server.addr.port}/private.mp3`,
          },
        });
      }
      started.resolve();
      await release;
      return new Response(audioBytes, {
        status: audioStatus,
        headers: { 'content-type': 'audio/mpeg' },
      });
    },
  );
  const network = () =>
    createNetwork({
      state,
      fixtures: Object.fromEntries(
        ['feed.test', 'files.test', 'images.test'].map((
          host,
        ) => [host, `http://127.0.0.1:${server.addr.port}`]),
      ),
    });
  state.declare('podcasts.autoDownloadNewest', {
    type: 'integer',
    default: 1,
    minimum: 0,
  });
  if (auto !== null) {
    await state.set('podcasts.autoDownloadNewest', String(auto));
  }
  let podcasts = await createPodcasts({
    store,
    state,
    media,
    network: network(),
    dataDir,
  });
  await state.set('podcasts.requestsPerMinute', '600000');
  const cfg = {
    listen: undefined,
    dataDir,
    user: 'admin',
    password: 'test',
    secret: 'p2',
    version: 'test',
  };
  await seedFirstUser(store, cfg);
  const library = createLibrary(store);
  const player = createPlayer();
  const nowPlaying = createNowPlaying(store);
  const playback = createPlayback({ player, nowPlaying, library, cfg });
  const stream = createStream(
    media,
    playback,
    cfg,
    undefined,
    createFileSource(library, { fileSource: (id) => podcasts.fileSource(id) }),
  );
  const artwork = createArtwork(library, {
    state,
    dataDir,
    podcasts: { cover: (id, max) => podcasts.cover(id, max) },
  });
  const bag = {
    cfg,
    state,
    library,
    podcasts,
    stream,
    artwork,
    playback,
    player,
    nowPlaying,
    outputs: createOutputs(),
    user: createUserService(store, cfg),
    binds: createBinds(() => layers, {}),
  };
  const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
  const layers = await loadLayers({ app: bag });
  let app = facade(core, layers);
  const owntone = facade(core, layers, {
    listenPort: 3689,
    defaultPort: 4534,
    env: {},
  });
  return {
    dir,
    dataDir,
    media,
    audio,
    picture,
    hits,
    app,
    library,
    playback,
    nowPlaying,
    get state() {
      return state;
    },
    ownPlayer: () => owntone(new Request('http://x/api/player')),
    get store() {
      return store;
    },
    get podcasts() {
      return podcasts;
    },
    feed(body: string) {
      xml = body;
    },
    image(type: string, bytes = picture) {
      imageType = type;
      imageBytes = bytes;
    },
    audioResponse(bytes: Uint8Array, status = 200) {
      audioBytes = new Uint8Array(bytes);
      audioStatus = status;
    },
    hold() {
      const barrier = Promise.withResolvers<void>();
      release = barrier.promise;
      started = Promise.withResolvers<void>();
      return {
        started: started.promise,
        release: () => {
          barrier.resolve();
          release = Promise.resolve();
        },
      };
    },
    async add() {
      return await podcasts.addChannel('https://feed.test/feed');
    },
    call(op: string, extra = '', init?: RequestInit) {
      return app(new Request(`http://x/rest/${op}?${AUTH}${extra}`, init));
    },
    async restart(reopen = false) {
      await podcasts.close();
      if (reopen) {
        await store.close();
        store = await openStore(dataDir);
        state = createState(store);
      }
      podcasts = await createPodcasts({
        store,
        state,
        media,
        network: network(),
        dataDir,
      });
      const nextLibrary = createLibrary(store);
      const nextBag = {
        ...bag,
        state,
        podcasts,
        library: nextLibrary,
        stream: createStream(
          media,
          undefined,
          cfg,
          undefined,
          createFileSource(nextLibrary, podcasts),
        ),
        artwork: createArtwork(nextLibrary, { state, dataDir, podcasts }),
        user: createUserService(store, cfg),
      };
      const nextLayers = await loadLayers({ app: nextBag });
      app = facade(core, nextLayers);
    },
    async close() {
      await podcasts.close();
      playback.close();
      await server.shutdown();
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

async function decoded(media: ReturnType<typeof createMedia>, path: string) {
  const pcm = await media.decodePcm(path);
  assert(pcm);
  let count = 0;
  for await (const bytes of pcm) count += bytes.length;
  assert(count > 0);
  return count;
}

Deno.test('user-entered LAN feed downloads same-host episodes and artwork without a private-address setting', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore(`${dir}/data`);
  const state = createState(store);
  const audio = await Deno.readFile(`${fixture}/01 - First Song.mp3`);
  const image = await Deno.readFile(`${fixture}/cover.jpg`);
  const hits: string[] = [];
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    (request) => {
      const path = new URL(request.url).pathname;
      hits.push(path);
      if (path === '/feed') {
        return new Response(
          `<rss version="2.0"><channel><title>LAN</title><image><url>/cover.jpg</url></image><item><guid>lan</guid><enclosure url="/episode.mp3" type="audio/mpeg"/></item></channel></rss>`,
        );
      }
      return new Response(path === '/cover.jpg' ? image : audio, {
        headers: {
          'content-type': path === '/cover.jpg' ? 'image/jpeg' : 'audio/mpeg',
        },
      });
    },
  );
  const podcasts = await createPodcasts({
    store,
    state,
    dataDir: `${dir}/data`,
  });
  try {
    await state.set('podcasts.requestsPerMinute', '600000');
    const channel = await podcasts.addChannel(
      `http://127.0.0.1:${server.addr.port}/feed`,
    );
    await podcasts.idle();
    assertEquals(channel.status, 'completed');
    assert(channel.imagePath);
    assertEquals(await Deno.readFile(channel.imagePath), image);
    const [episode] = await podcasts.episodes(channel.id);
    assertEquals(episode.status, 'completed');
    const source = await podcasts.fileSource(episode.streamId!);
    assert(source);
    assertEquals(await Deno.readFile(source.path), audio);
    assertEquals(hits, ['/feed', '/cover.jpg', '/episode.mp3']);
    await podcasts.close();
    const restarted = await createPodcasts({
      store,
      state,
      dataDir: `${dir}/data`,
    });
    try {
      await restarted.download(episode.id);
      await restarted.idle();
      assertEquals((await restarted.episode(episode.id))?.status, 'completed');
      assertEquals(
        await Deno.readFile(
          (await restarted.fileSource(episode.streamId!))!.path,
        ),
        audio,
      );
    } finally {
      await restarted.close();
    }
  } finally {
    await podcasts.close();
    await server.shutdown();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('podcast downloads persist probed facts and stream raw, ranges, bitrate, transcode and offsets through the facade without catalog or playback effects', async () => {
  const s = await setup();
  try {
    const channel = await s.add();
    const [fresh] = await s.podcasts.episodes(channel.id);
    assert(!fresh.streamId);
    assertEquals((await s.podcasts.download(fresh.id))?.status, 'downloading');
    await s.podcasts.idle();
    const row = (await s.podcasts.episode(fresh.id))!;
    assertEquals(row.status, 'completed');
    assert(row.streamId && row.filePath);
    assertEquals(await Deno.readFile(row.filePath), s.audio);
    assertEquals(row.size, s.audio.length);
    const probe = await s.media.probe(row.filePath);
    assertEquals(row.duration, probe.durationMs! / 1000);
    assert(row.duration! > 0 && row.duration! < 9999);
    assertEquals(await s.library.getSong(row.id), null);
    assertEquals(await s.library.getSong(row.streamId), null);
    const raw = await s.call('stream', `&id=${row.streamId}&format=raw`);
    assertEquals(raw.status, 200);
    assertEquals(new Uint8Array(await raw.arrayBuffer()), s.audio);
    await decoded(s.media, row.filePath);
    const range = await s.call('stream', `&id=${row.streamId}`, {
      headers: { range: 'bytes=10-99' },
    });
    assertEquals(range.status, 206);
    assertEquals(
      range.headers.get('content-range'),
      `bytes 10-99/${s.audio.length}`,
    );
    assertEquals(
      new Uint8Array(await range.arrayBuffer()),
      s.audio.slice(10, 100),
    );
    const response = await s.call(
      'stream',
      `&id=${row.streamId}&format=opus&maxBitRate=32`,
    );
    assertEquals(response.status, 200);
    assertEquals(response.headers.get('accept-ranges'), 'none');
    const path = `${s.dir}/transcoded.opus`;
    await Deno.writeFile(path, new Uint8Array(await response.arrayBuffer()));
    assertEquals((await s.media.probe(path)).audioCodec, 'opus');
    await decoded(s.media, path);
    const limited = await s.call('stream', `&id=${row.streamId}&maxBitRate=32`);
    const limitedPath = `${s.dir}/limited.mp3`;
    await Deno.writeFile(
      limitedPath,
      new Uint8Array(await limited.arrayBuffer()),
    );
    assert(
      (await s.media.probe(limitedPath)).bitrateKbps! < probe.bitrateKbps!,
    );
    await decoded(s.media, limitedPath);
    const offset = await s.call(
      'stream',
      `&id=${row.streamId}&format=opus&timeOffset=${
        Math.ceil(row.duration!) + 1
      }`,
    );
    assertEquals((await offset.arrayBuffer()).byteLength, 0);
    const head = await s.call('stream', `&id=${row.streamId}&format=opus`, {
      method: 'HEAD',
    });
    assertEquals(head.status, 200);
    assertEquals((await head.arrayBuffer()).byteLength, 0);
    assertEquals(await s.nowPlaying.list(), []);
    assertEquals(await rawSql(s.store).all('SELECT * FROM listens'), []);
    assertEquals((await (await s.ownPlayer()).json()).state, 'stop');
    await s.podcasts.refresh(channel.id);
    assertEquals(
      (await s.podcasts.episode(row.id))?.duration,
      row.duration,
      'refresh preserves measured duration',
    );
    const hits = s.hits.filter((path) => path.endsWith('.mp3')).length;
    assertEquals((await s.podcasts.download(row.id))?.status, 'downloading');
    await s.podcasts.idle();
    const repeated = (await s.podcasts.episode(row.id))!;
    assertEquals(repeated.status, 'completed');
    assertEquals(await Deno.readFile(repeated.filePath!), s.audio);
    assertEquals(
      s.hits.filter((path) => path.endsWith('.mp3')).length,
      hits + 1,
    );
  } finally {
    await s.close();
  }
});

Deno.test('podcast auto-download selects the newest window, honors zero and does not backfill deleted or completed newest episodes', async () => {
  const s = await setup(null);
  try {
    assertEquals(await s.state.getTyped('podcasts.autoDownloadNewest'), 1);
    assertEquals(await s.state.getTyped('podcasts.keepEpisodes'), 0);
    s.feed(feed(item(1) + item(2) + item(3)));
    const channel = await s.add();
    await s.podcasts.idle();
    let rows = await s.podcasts.episodes(channel.id);
    assertEquals(rows.map((r) => r.status), ['completed', 'new', 'new']);
    await s.podcasts.deleteEpisode(rows[0].id);
    await s.podcasts.refresh(channel.id);
    await s.podcasts.idle();
    assertEquals((await s.podcasts.episodes(channel.id)).map((r) => r.status), [
      'deleted',
      'new',
      'new',
    ]);
    await s.state.set('podcasts.autoDownloadNewest', '2');
    s.feed(feed(item(1) + item(2) + item(3) + item(4) + item(5)));
    await s.podcasts.refresh(channel.id);
    await s.podcasts.idle();
    rows = await s.podcasts.episodes(channel.id);
    assertEquals(rows.map((r) => r.status), [
      'completed',
      'completed',
      'deleted',
      'new',
      'new',
    ]);
    await s.state.set('podcasts.autoDownloadNewest', '0');
    s.feed(feed(item(6)));
    await s.podcasts.refresh(channel.id);
    await s.podcasts.idle();
    assertEquals((await s.podcasts.episodes(channel.id))[0].status, 'new');
  } finally {
    await s.close();
  }
});

Deno.test('podcast queue persists interrupted intent and restarts from scratch with one file worker', async () => {
  const s = await setup();
  let barrier: ReturnType<typeof s.hold> | undefined;
  try {
    s.feed(feed(item(1) + item(2), false));
    const channel = await s.add();
    const rows = await s.podcasts.episodes(channel.id);
    barrier = s.hold();
    await s.podcasts.download(rows[0].id);
    await barrier.started;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const queued = await Promise.race([
        s.podcasts.download(rows[1].id),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error('Second intent blocked behind active transfer')),
            3000,
          );
        }),
      ]);
      assertEquals(queued?.status, 'downloading');
    } finally {
      clearTimeout(timer);
    }
    assertEquals(
      s.hits.filter((path) => /\.mp3$/.test(path)).length,
      1,
      'one transfer while the other intent is persisted',
    );
    const closing = s.podcasts.close();
    barrier.release();
    await closing;
    assertEquals((await s.podcasts.episodes(channel.id)).map((r) => r.status), [
      'downloading',
      'downloading',
    ]);
    const dir = `${s.dataDir}/podcasts/${channel.id}`;
    await Deno.writeTextFile(
      `${dir}/${rows[0].id}.download.stale.part`,
      'interrupted bytes',
    );
    await s.restart(true);
    await s.podcasts.idle();
    for (const row of await s.podcasts.episodes(channel.id)) {
      assertEquals(row.status, 'completed');
      assertEquals(await Deno.readFile(row.filePath!), s.audio);
    }
    const names = [];
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
    assertEquals(names.length, 2);
    assert(names.every((name) => name.endsWith('.mp3')));
    assertEquals(s.hits.filter((path) => /\.mp3$/.test(path)).length, 3);
  } finally {
    barrier?.release();
    await s.close();
  }
});

Deno.test('podcast keep policy is live, newest-first and restricted to owned podcast files', async () => {
  const s = await setup();
  try {
    s.feed(feed(item(1) + item(2) + item(3), false));
    const channel = await s.add();
    const rows = await s.podcasts.episodes(channel.id);
    await Promise.all(rows.map((r) => s.podcasts.download(r.id)));
    await s.podcasts.idle();
    const before = await s.podcasts.episodes(channel.id);
    const outside = `${s.dir}/library-sentinel.mp3`;
    await Deno.writeFile(outside, s.audio);
    await s.store.podcasts.finish(rows[2].id, {
      status: 'completed',
      path: outside,
      size: s.audio.length,
      duration: 1,
    });
    await s.state.set('podcasts.keepEpisodes', '1');
    await s.podcasts.idle();
    assertEquals((await s.podcasts.episodes(channel.id)).map((r) => r.status), [
      'completed',
      'deleted',
      'deleted',
    ]);
    await assertRejects(
      () => Deno.stat(before[1].filePath!),
      Deno.errors.NotFound,
    );
    assertEquals(await Deno.readFile(outside), s.audio);
    assertEquals(await Deno.readFile(before[0].filePath!), s.audio);
    await s.podcasts.refresh(channel.id);
    assertEquals((await s.podcasts.episodes(channel.id))[2].status, 'deleted');
  } finally {
    await s.close();
  }
});

Deno.test('podcast deletion cancels active downloads, revokes streams and removes channel files without resurrection', async () => {
  const s = await setup();
  let barrier: ReturnType<typeof s.hold> | undefined;
  const releaseProbe = Promise.withResolvers<void>();
  try {
    const channel = await s.add();
    const [row] = await s.podcasts.episodes(channel.id);
    barrier = s.hold();
    await s.podcasts.download(row.id);
    await barrier.started;
    const deleting = s.podcasts.deleteEpisode(row.id);
    barrier.release();
    assertEquals(await deleting, true);
    await s.podcasts.idle();
    assertEquals((await s.podcasts.episode(row.id))?.status, 'deleted');
    await s.podcasts.download(row.id);
    await s.podcasts.idle();
    const downloaded = (await s.podcasts.episode(row.id))!;
    assertEquals(downloaded.status, 'completed');
    await s.podcasts.deleteEpisode(row.id);
    await assertRejects(
      () => Deno.stat(downloaded.filePath!),
      Deno.errors.NotFound,
    );
    const response = await s.call('stream', `&id=${downloaded.streamId}`);
    assertEquals((await response.json())['subsonic-response'].error.code, 70);
    await s.podcasts.refresh(channel.id);
    assertEquals((await s.podcasts.episode(row.id))?.status, 'deleted');
    const probing = Promise.withResolvers<void>();
    const probe = s.media.probe;
    s.media.probe = async (path) => {
      const facts = await probe(path);
      probing.resolve();
      await releaseProbe.promise;
      return facts;
    };
    await s.podcasts.download(row.id);
    await probing.promise;
    await s.podcasts.deleteChannel(channel.id);
    releaseProbe.resolve();
    await s.podcasts.idle();
    await assertRejects(
      () => Deno.stat(`${s.dataDir}/podcasts/${channel.id}`),
      Deno.errors.NotFound,
    );
    assertEquals(await s.podcasts.episode(row.id), null);
    assertEquals(await s.podcasts.deleteEpisode(row.id), false);
    assertEquals(await s.podcasts.deleteChannel(channel.id), false);
  } finally {
    releaseProbe.resolve();
    barrier?.release();
    await s.close();
  }
});

Deno.test('podcast channel image downloads once, survives reopen and uses real artwork resize/cache through getCoverArt', async () => {
  const s = await setup();
  try {
    const channel = await s.add();
    assert(channel.imagePath);
    const get = () => s.call('getCoverArt', `&id=${channel.id}&size=16`);
    const first = await get();
    const resized = new Uint8Array(await first.arrayBuffer());
    const dimensions = imageHeader(resized)!;
    assertEquals(Math.max(dimensions.width, dimensions.height), 16);
    const cached = await get();
    assertEquals(cached.headers.get('x-artwork-cache'), 'hit');
    assertEquals(new Uint8Array(await cached.arrayBuffer()), resized);
    await s.podcasts.refresh(channel.id);
    assertEquals(s.hits.filter((p) => p === '/cover.jpg').length, 1);
    await s.restart(true);
    const original = await s.call('getCoverArt', `&id=${channel.id}`);
    assertEquals(new Uint8Array(await original.arrayBuffer()), s.picture);
  } finally {
    await s.close();
  }
});

Deno.test('podcast image validation rejects non-images and honors the shared lookup byte cap', async () => {
  const s = await setup();
  try {
    s.image('text/html');
    const channel = await s.add();
    assertEquals(channel.imagePath, null);
    s.image('image/jpeg', new TextEncoder().encode('not an image'));
    await s.podcasts.refresh(channel.id);
    assertEquals((await s.podcasts.channels())[0].imagePath, null);
    await s.state.set('lookups.imageMaxMegabytes', '1');
    s.image('image/jpeg', new Uint8Array(1024 * 1024 + 1));
    await s.podcasts.refresh(channel.id);
    assertEquals((await s.podcasts.channels())[0].imagePath, null);
    s.image('image/jpeg');
    await s.podcasts.refresh(channel.id);
    assert((await s.podcasts.channels())[0].imagePath);
  } finally {
    await s.close();
  }
});

Deno.test('podcast enclosure caps, HTTP failures, invalid audio and hostile file/private/redirect URLs are visible errors without publication', async () => {
  const s = await setup();
  try {
    s.feed(feed(item(1), false));
    const channel = await s.add();
    const [row] = await s.podcasts.episodes(channel.id);
    const run = async (url: string, expected: RegExp) => {
      const original = (await s.store.podcasts.episode(row.id))!;
      await s.store.podcasts.saveFeed(channel.id, {
        title: null,
        description: null,
        imageUrl: null,
        episodes: [{ ...original, enclosureUrl: url }],
      }, Date.now());
      await s.podcasts.download(row.id);
      await s.podcasts.idle();
      const result = (await s.podcasts.episode(row.id))!;
      assertEquals(result.status, 'error');
      assert(expected.test(result.errorMessage!), result.errorMessage!);
      assertEquals(result.filePath, null);
      assert(!result.streamId);
    };
    await s.state.set('podcasts.maxEpisodeMegabytes', '0.001');
    await run('https://files.test/1.mp3', /size cap/);
    await s.state.set('podcasts.maxEpisodeMegabytes', '1024');
    s.audioResponse(s.audio, 404);
    await run('https://files.test/1.mp3', /HTTP 404/);
    s.audioResponse(new TextEncoder().encode('not audio'));
    await run('https://files.test/1.mp3', /no readable audio/);
    s.audioResponse(s.audio);
    const before = s.hits.length;
    await run('file:///etc/passwd', /Host not granted/);
    await run('http://127.0.0.1/private.mp3', /destination refused/);
    assertEquals(s.hits.length, before);
    await run('https://files.test/redirect.mp3', /destination refused/);
    assert(!s.hits.includes('/private.mp3'));
    const names = [];
    for await (
      const entry of Deno.readDir(`${s.dataDir}/podcasts/${channel.id}`)
    ) names.push(entry.name);
    assertEquals(names, []);
  } finally {
    await s.close();
  }
});

Deno.test('podcast filesystem owner refuses symlink escapes for writes and stored source reads', async () => {
  const s = await setup();
  try {
    s.feed(feed(item(1), false));
    const channel = await s.add();
    const [row] = await s.podcasts.episodes(channel.id);
    const outside = `${s.dir}/outside`;
    await Deno.mkdir(outside);
    await Deno.mkdir(`${s.dataDir}/podcasts`);
    await Deno.symlink(outside, `${s.dataDir}/podcasts/${channel.id}`);
    await s.podcasts.download(row.id);
    await s.podcasts.idle();
    const error = (await s.podcasts.episode(row.id))!;
    assertEquals(error.status, 'error');
    assert(error.errorMessage?.includes('Unsafe podcast directory'));
    const contents = [];
    for await (const entry of Deno.readDir(outside)) contents.push(entry.name);
    assertEquals(contents, []);
    await Deno.remove(`${s.dataDir}/podcasts/${channel.id}`);
    await s.podcasts.download(row.id);
    await s.podcasts.idle();
    const downloaded = (await s.podcasts.episode(row.id))!;
    await Deno.remove(downloaded.filePath!);
    const sentinel = `${outside}/sentinel.mp3`;
    await Deno.writeFile(sentinel, s.audio);
    await Deno.symlink(sentinel, downloaded.filePath!);
    assertEquals(await s.podcasts.fileSource(downloaded.streamId!), null);
    await s.podcasts.deleteEpisode(row.id);
    assertEquals(await Deno.readFile(sentinel), s.audio);
  } finally {
    await s.close();
  }
});

Deno.test('p1 podcast schema upgrades with kept feed rows, image references and download error persistence', async () => {
  const s = await setup();
  try {
    s.feed(feed(item(1), false));
    const channel = await s.add();
    const [row] = await s.podcasts.episodes(channel.id);
    await s.podcasts.close();
    for (
      const [table, column] of [['podcast_channels', 'image_path'], [
        'podcast_channels',
        'image_source_url',
      ], ['podcast_episodes', 'error_message']]
    ) {
      await rawSql(s.store).run(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
    await s.restart(true);
    assertEquals((await s.podcasts.episode(row.id))?.guid, row.guid);
    await s.state.set('podcasts.maxEpisodeMegabytes', '0.001');
    // The reopened service uses its own state object over the same persistent settings.
    await s.podcasts.download(row.id);
    await s.podcasts.idle();
    assertEquals((await s.podcasts.episode(row.id))?.status, 'error');
    await s.restart(true);
    assert(
      (await s.podcasts.episode(row.id))?.errorMessage?.includes('size cap'),
    );
  } finally {
    await s.close();
  }
});
