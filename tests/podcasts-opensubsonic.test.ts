import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { parse, type XmlElement } from '@std/xml';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { createState } from '../src/state.ts';
import { encryptPassword, seedFirstUser } from '../src/users.ts';
import { createUserService } from '../src/user.ts';
import { createPodcasts } from '../src/podcasts.ts';
import { createNetwork } from '../src/lookups/net.ts';
import { createMedia } from '../src/media.ts';
import { createLibrary } from '../src/library.ts';
import { createLibraries } from '../src/libraries.ts';
import { createFileSource } from '../src/file-source.ts';
import { createStream } from '../src/stream.ts';
import { createArtwork } from '../src/artwork.ts';
import { createPlaylists } from '../src/playlists.ts';
import { createShares } from '../src/shares.ts';
import { loadLayers } from '../src/layers.ts';
import { facade } from '../src/facade.ts';

interface Episode {
  id: string;
  channelId: string;
  isDir: boolean;
  title: string;
  album?: string;
  type: string;
  status: string;
  description?: string;
  publishDate?: string;
  streamId?: string;
  coverArt?: string;
  contentType?: string;
  suffix?: string;
  size?: number;
  duration?: number;
}
interface Channel {
  id: string;
  url: string;
  title?: string;
  description?: string;
  coverArt?: string;
  originalImageUrl?: string;
  status: string;
  errorMessage?: string;
  episode?: Episode[];
}
const fixture = 'tests/fixtures/library/Fixture Artist/Fixture Album';
const item = (n: number) =>
  `<item><guid>${n}</guid><title>Episode ${n} &amp; &quot;Friends&quot;</title><description>Facts &amp; details</description><pubDate>${
    new Date(Date.UTC(2026, 9, n)).toUTCString()
  }</pubDate><enclosure url="https://podcast.test/${n}.mp3" type="audio/mpeg" length="999999"/><itunes:duration>123</itunes:duration></item>`;
const feed = (items: string, image = true) =>
  `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Show &amp; &quot;Friends&quot;</title><description>Shared &amp; factual</description>${
    image ? '<itunes:image href="https://podcast.test/cover.jpg"/>' : ''
  }${items}</channel></rss>`;

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-p3-' });
  const store = await openStore(`${dir}/data`);
  const state = createState(store);
  const media = createMedia();
  const audio = await Deno.readFile(`${fixture}/01 - First Song.mp3`);
  const image = await Deno.readFile(`${fixture}/cover.jpg`);
  let body = feed(item(1) + item(2));
  const hits: string[] = [];
  const feedServer = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    (request) => {
      const path = new URL(request.url).pathname;
      hits.push(path);
      if (path === '/bad') return new Response('bad feed', { status: 404 });
      if (path === '/other') return new Response(feed(item(28), false));
      if (path === '/feed') return new Response(body);
      if (path === '/cover.jpg') {
        return new Response(image, {
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      return new Response(audio, { headers: { 'content-type': 'audio/mpeg' } });
    },
  );
  const podcasts = await createPodcasts({
    store,
    state,
    media,
    dataDir: `${dir}/data`,
    network: createNetwork({
      state,
      fixtures: { 'podcast.test': `http://127.0.0.1:${feedServer.addr.port}` },
    }),
  });
  await state.set('podcasts.autoDownloadNewest', '0');
  await state.set('podcasts.requestsPerMinute', '600000');
  const cfg = {
    listen: undefined,
    dataDir: `${dir}/data`,
    user: 'admin',
    password: 'test',
    secret: 'p3-test',
    version: 'p3-test',
  };
  await seedFirstUser(store, cfg);
  const enc = (await encryptPassword(cfg.secret, 'test')).replaceAll("'", "''");
  await rawSql(store).run(
    `INSERT INTO users (id,name,password_enc,created_at) VALUES ('listener','listener','${enc}',now())`,
  );
  const calls: string[] = [];
  const tracked = {
    ...podcasts,
    addChannel(...args: Parameters<typeof podcasts.addChannel>) {
      calls.push('create');
      return podcasts.addChannel(...args);
    },
    refresh(...args: Parameters<typeof podcasts.refresh>) {
      calls.push('refresh');
      return podcasts.refresh(...args);
    },
    download(...args: Parameters<typeof podcasts.download>) {
      calls.push('download');
      return podcasts.download(...args);
    },
    deleteChannel(...args: Parameters<typeof podcasts.deleteChannel>) {
      calls.push('deleteChannel');
      return podcasts.deleteChannel(...args);
    },
    deleteEpisode(...args: Parameters<typeof podcasts.deleteEpisode>) {
      calls.push('deleteEpisode');
      return podcasts.deleteEpisode(...args);
    },
  };
  const library = createLibrary(store);
  const playlists = createPlaylists(store);
  const app = facade(
    await pathfinder({ roots: ['core/'], app: { store, cfg } }),
    await loadLayers({
      app: {
        cfg,
        state,
        library,
        playlists,
        shares: createShares(store, state, library, playlists),
        libraries: createLibraries(store),
        podcasts: tracked,
        user: createUserService(store, cfg),
        stream: createStream(
          media,
          cfg,
          undefined,
          createFileSource(library, podcasts),
        ),
        artwork: createArtwork(library, {
          state,
          dataDir: cfg.dataDir,
          podcasts,
        }),
      },
    }),
  );
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    app,
  );
  const request = (
    op: string,
    params: Record<string, string> = {},
    post = false,
    user = 'listener',
    headers?: HeadersInit,
  ) => {
    const p = new URLSearchParams({
      u: user,
      p: 'test',
      v: '1.16.1',
      c: 'p3-test',
      f: 'json',
      ...params,
    });
    const url = `http://127.0.0.1:${server.addr.port}/rest/${op}.view`;
    return fetch(post ? url : `${url}?${p}`, {
      method: post ? 'POST' : 'GET',
      body: post ? p : undefined,
      headers,
    });
  };
  const json = async (
    op: string,
    params: Record<string, string> = {},
    post = false,
    user = 'listener',
  ) => {
    const res = await request(op, params, post, user);
    assertEquals(res.status, 200);
    return (await res.json())['subsonic-response'];
  };
  const ok = async (
    op: string,
    params: Record<string, string> = {},
    post = false,
    user = 'listener',
  ) => {
    const value = await json(op, params, post, user);
    assertEquals(value.status, 'ok', JSON.stringify({ op, value }));
    return value;
  };
  const channels = async (
    params: Record<string, string> = {},
    post = false,
  ): Promise<Channel[]> =>
    (await ok('getPodcasts', params, post)).podcasts.channel;
  const episode = async (id: string, post = false): Promise<Episode> =>
    (await ok('getPodcastEpisode', { id }, post)).podcastEpisode;
  const create = (post = false, path = '/feed') =>
    ok(
      'createPodcastChannel',
      { url: `https://podcast.test${path}` },
      post,
      'admin',
    );
  const xml = async (
    op: string,
    params: Record<string, string> = {},
    post = false,
    user = 'listener',
  ) => {
    const response = await request(op, { ...params, f: 'xml' }, post, user);
    assertEquals(response.status, 200);
    const text = await response.text();
    // Project XML elements onto the existing wire-assertion shape. Attributes
    // stay strings and only repeated sibling elements become arrays.
    // deno-lint-ignore no-explicit-any -- Heterogeneous protocol response tree.
    const project = (element: XmlElement): any => {
      const result: Record<string, unknown> = { ...element.attributes };
      for (const node of element.children) {
        if (node.type !== 'element') continue;
        const key = node.name.raw;
        const entry = project(node);
        result[key] = key in result
          ? [
            ...(Array.isArray(result[key]) ? result[key] : [result[key]]),
            entry,
          ]
          : entry;
      }
      return result;
    };
    const root = parse(text).root;
    assertEquals(root.name.raw, 'subsonic-response');
    const value = project(root);
    assertEquals(value.status, 'ok', text);
    return { text, value };
  };
  return {
    dir,
    store,
    state,
    media,
    podcasts,
    audio,
    image,
    hits,
    calls,
    request,
    json,
    ok,
    channels,
    episode,
    create,
    xml,
    feed(xml: string) {
      body = xml;
    },
    async close() {
      await server.shutdown();
      await podcasts.close();
      await feedServer.shutdown();
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('podcast HTTP browse: shared channel and Child facts, includeEpisodes, id and GET/form XML parity', async () => {
  const s = await setup();
  try {
    assertEquals(await s.channels(), []);
    const created = await s.create(true);
    assertEquals(Object.keys(created).sort(), [
      'openSubsonic',
      'serverVersion',
      'status',
      'type',
      'version',
    ]);
    const [channel] = await s.channels();
    assert(channel.episode);
    assertEquals(channel, {
      id: channel.id,
      url: 'https://podcast.test/feed',
      title: 'Show & "Friends"',
      description: 'Shared & factual',
      coverArt: channel.id,
      originalImageUrl: 'https://podcast.test/cover.jpg',
      status: 'completed',
      episode: channel.episode,
    });
    assertEquals(channel.episode.map((e) => e.title), [
      'Episode 2 & "Friends"',
      'Episode 1 & "Friends"',
    ]);
    const first = channel.episode[0];
    assertEquals(first, {
      id: first.id,
      isDir: false,
      title: 'Episode 2 & "Friends"',
      album: channel.title,
      type: 'podcast',
      duration: 123,
      coverArt: channel.id,
      channelId: channel.id,
      description: 'Facts & details',
      status: 'new',
      publishDate: '2026-10-02T00:00:00.000Z',
    });
    for (const post of [false, true]) {
      assertEquals(await s.channels({ id: channel.id }, post), [channel]);
      assertEquals(await s.episode(first.id, post), first);
      for (const token of ['false', '0']) {
        const rows = await s.channels({ includeEpisodes: token }, post);
        assertEquals(
          rows,
          [{ ...channel, episode: undefined }].map((
            { episode: _omitted, ...rest },
          ) => rest),
        );
      }
      const xml = await s.xml('getPodcasts', { id: channel.id }, post);
      assertStringIncludes(xml.text, 'title="Show &amp; &quot;Friends&quot;"');
      assertEquals(xml.value.podcasts.channel.id, channel.id);
      assertEquals(xml.value.podcasts.channel.episode[0].id, first.id);
      assertEquals(xml.value.podcasts.channel.episode[0].isDir, 'false');
      const without = await s.xml(
        'getPodcasts',
        { includeEpisodes: 'false' },
        post,
      );
      assertEquals(without.value.podcasts.channel.episode, undefined);
      const single = await s.xml('getPodcastEpisode', { id: first.id }, post);
      assertEquals(single.value.podcastEpisode.channelId, channel.id);
      assertEquals(single.value.podcastEpisode.streamId, undefined);
    }
    const cover = await s.request('getCoverArt', { id: channel.coverArt! });
    assertEquals(cover.status, 200);
    assertEquals(new Uint8Array(await cover.arrayBuffer()), s.image);
    assertEquals(await s.store.catalog.getSong(first.id), null);
  } finally {
    await s.close();
  }
});

Deno.test('podcast HTTP newest: publish-date ordering across channels, default20, count zero and no arbitrary cap', async () => {
  const s = await setup();
  try {
    s.feed(feed(Array.from({ length: 22 }, (_, i) => item(i + 1)).join('')));
    await s.create();
    await s.create(true, '/other');
    const all = await s.channels();
    const newer = all.find((row) => row.url.endsWith('/other'))!;
    assertEquals(newer.coverArt, undefined);
    const newestId = newer.episode![0].id;
    for (const post of [false, true]) {
      const list = (await s.ok('getNewestPodcasts', {}, post)).newestPodcasts
        .episode as Episode[];
      assertEquals(list.length, 20);
      assertEquals(list[0].id, newestId);
      assertEquals(list[0].coverArt, undefined);
      assertEquals(list[0], await s.episode(newestId));
      assertEquals(
        (await s.ok('getNewestPodcasts', { count: '0' }, post)).newestPodcasts
          .episode,
        [],
      );
      assertEquals(
        (await s.ok('getNewestPodcasts', { count: '1' }, post)).newestPodcasts
          .episode,
        [list[0]],
      );
      assertEquals(
        (await s.ok('getNewestPodcasts', { count: '1000' }, post))
          .newestPodcasts.episode.length,
        23,
      );
      const xml = await s.xml('getNewestPodcasts', { count: '1' }, post);
      assertEquals(xml.value.newestPodcasts.episode.id, newestId);
    }
  } finally {
    await s.close();
  }
});

Deno.test('podcast HTTP download lifecycle: completed streamId, decodable stream, original download, tombstone and channel deletion', async () => {
  const s = await setup();
  try {
    // Exercise each mutating route successfully in both transports.
    for (const post of [false, true]) {
      await s.create(post);
      const [channel] = await s.channels();
      const id = channel.episode![0].id;
      await s.ok('downloadPodcastEpisode', { id }, post, 'admin');
      await s.podcasts.idle();
      const complete = await s.episode(id, post);
      assertEquals(complete.status, 'completed');
      assert(complete.streamId);
      assertEquals(complete.size, s.audio.length);
      assertEquals(complete.contentType, 'audio/mpeg');
      assertEquals(complete.suffix, 'mp3');
      assert(complete.duration! < 123);
      const listed =
        (await s.channels({ id: channel.id }, post))[0].episode![0];
      assertEquals(listed, complete);
      const newest =
        (await s.ok('getNewestPodcasts', { count: '1' }, post)).newestPodcasts
          .episode[0];
      assertEquals(newest, complete);
      const xml = await s.xml('getPodcastEpisode', { id }, post);
      assertEquals(xml.value.podcastEpisode.streamId, complete.streamId);
      const raw = await s.request('stream', {
        id: complete.streamId,
        format: 'raw',
      }, post);
      assertEquals(raw.status, 200);
      assertEquals(new Uint8Array(await raw.arrayBuffer()), s.audio);
      const direct = await s.request('stream', { id: complete.streamId }, post);
      assertEquals(direct.status, 200);
      assertEquals(new Uint8Array(await direct.arrayBuffer()), s.audio);
      const stream = await s.request('stream', {
        id: complete.streamId,
        format: 'opus',
      }, post);
      assertEquals(stream.status, 200);
      const path = `${s.dir}/consumer-${post}.opus`;
      await Deno.writeFile(path, new Uint8Array(await stream.arrayBuffer()));
      const pcm = await s.media.decodePcm(path);
      assert(pcm);
      let bytes = 0;
      for await (const chunk of pcm) bytes += chunk.length;
      assert(bytes > 0);
      const download = await s.request('download', {
        id: complete.streamId,
        format: 'opus',
      }, post);
      assertEquals(download.status, 200);
      assertStringIncludes(
        download.headers.get('content-disposition')!,
        'attachment; filename=',
      );
      assertEquals(new Uint8Array(await download.arrayBuffer()), s.audio);
      const range = await s.request(
        'download',
        { id: complete.streamId },
        post,
        'listener',
        { range: 'bytes=0-63' },
      );
      assertEquals(range.status, 206);
      assertEquals(
        new Uint8Array(await range.arrayBuffer()),
        s.audio.slice(0, 64),
      );
      await s.ok('deletePodcastEpisode', { id }, post, 'admin');
      assertEquals((await s.episode(id)).status, 'deleted');
      assertEquals((await s.episode(id)).streamId, undefined);
      await s.xml('refreshPodcasts', {}, post, 'admin');
      assertEquals((await s.episode(id)).status, 'deleted');
      for (const op of ['stream', 'download']) {
        assertEquals(
          (await s.json(op, { id: complete.streamId })).error.code,
          70,
        );
      }
      await s.ok('deletePodcastChannel', { id: channel.id }, post, 'admin');
      assertEquals(await s.channels(), []);
      assertEquals((await s.json('getPodcastEpisode', { id })).error.code, 70);
    }
  } finally {
    await s.close();
  }
});

Deno.test('podcast HTTP admin guard: denied GET/form JSON/XML never reaches core or changes state', async () => {
  const s = await setup();
  try {
    await s.create();
    const [channel] = await s.channels();
    const before = await s.channels();
    const calls = [...s.calls];
    const hits = [...s.hits];
    for (const post of [false, true]) {
      for (const f of ['json', 'xml']) {
        for (const id of [channel.episode![0].id, 'unknown']) {
          for (
            const [op, params] of [
              ['createPodcastChannel', { url: 'https://podcast.test/other' }],
              ['refreshPodcasts', {}],
              ['downloadPodcastEpisode', { id }],
              ['deletePodcastEpisode', { id }],
              ['deletePodcastChannel', {
                id: id === 'unknown' ? id : channel.id,
              }],
            ] as [string, Record<string, string>][]
          ) {
            const response = await s.request(op, { ...params, f }, post);
            assertEquals(response.status, 200);
            if (f === 'json') {
              const value = (await response.json())['subsonic-response'];
              assertEquals(
                [value.status, value.error.code],
                ['failed', 50],
                op,
              );
            } else {
              const text = await response.text();
              assertStringIncludes(text, 'status="failed"');
              assertStringIncludes(text, '<error code="50"');
            }
            assertEquals(s.calls, calls, op);
            assertEquals(s.hits, hits, op);
            assertEquals(await s.channels(), before, op);
          }
        }
      }
    }
  } finally {
    await s.close();
  }
});

Deno.test('podcast HTTP errors: required10, unknown70, invalid URL and failed-feed success with visible error', async () => {
  const s = await setup();
  try {
    for (const post of [false, true]) {
      for (
        const op of [
          'getPodcastEpisode',
          'deletePodcastEpisode',
          'deletePodcastChannel',
          'downloadPodcastEpisode',
          'createPodcastChannel',
        ]
      ) {
        assertEquals((await s.json(op, {}, post, 'admin')).error.code, 10, op);
        const xml = await (await s.request(op, { f: 'xml' }, post, 'admin'))
          .text();
        assertStringIncludes(xml, '<error code="10"');
      }
      for (
        const op of [
          'getPodcastEpisode',
          'getPodcasts',
          'deletePodcastEpisode',
          'deletePodcastChannel',
          'downloadPodcastEpisode',
        ]
      ) {
        assertEquals(
          (await s.json(op, { id: 'unknown' }, post, 'admin')).error.code,
          70,
          op,
        );
        const xml = await (await s.request(
          op,
          { id: 'unknown', f: 'xml' },
          post,
          'admin',
        )).text();
        assertStringIncludes(xml, '<error code="70"');
      }
      for (const url of ['relative', 'file:///not-a-feed']) {
        assertEquals(
          (await s.json('createPodcastChannel', { url }, post, 'admin')).error
            .code,
          0,
        );
        assertEquals(await s.channels(), []);
      }
    }
    await s.create(true, '/bad');
    const [failed] = await s.channels();
    assertEquals(failed.status, 'error');
    assertStringIncludes(failed.errorMessage!, '404');
    assertEquals(failed.title, undefined);
    assertEquals(failed.coverArt, undefined);
    assertEquals(failed.episode, []);
    const xml = await s.xml('getPodcasts');
    assertEquals(xml.value.podcasts.channel.status, 'error');
    assertStringIncludes(xml.value.podcasts.channel.errorMessage, '404');
    await s.ok('deletePodcastChannel', { id: failed.id }, true, 'admin');
    // Required Child title is a hat display label, not an invented core fact.
    s.feed(
      '<rss version="2.0"><channel><item><guid>untitled</guid><enclosure url="https://podcast.test/1.mp3"/></item></channel></rss>',
    );
    await s.create();
    const [unknown] = await s.channels();
    const episode = unknown.episode![0];
    assertEquals(episode.title, '[Untitled Episode]');
    for (
      const field of [
        'album',
        'duration',
        'publishDate',
        'coverArt',
        'size',
        'contentType',
        'suffix',
        'streamId',
      ]
    ) {
      assertEquals(Object.hasOwn(episode, field), false, field);
    }
  } finally {
    await s.close();
  }
});

Deno.test('podcast HTTP capabilities: getPodcastEpisode v1 and live podcastRole agree with enforced role', async () => {
  const s = await setup();
  try {
    for (const post of [false, true]) {
      const extensions = (await s.ok('getOpenSubsonicExtensions', {}, post))
        .openSubsonicExtensions;
      assertEquals(
        extensions.filter((e: { name: string }) =>
          e.name === 'getPodcastEpisode'
        ),
        [{ name: 'getPodcastEpisode', versions: [1] }],
      );
      const xml = await s.xml('getOpenSubsonicExtensions', {}, post);
      assertStringIncludes(
        xml.text,
        '<openSubsonicExtensions name="getPodcastEpisode"><versions>1</versions></openSubsonicExtensions>',
      );
      for (const user of ['admin', 'listener']) {
        assertEquals(
          (await s.ok('getUser', { username: user }, post, user)).user
            .podcastRole,
          user === 'admin',
        );
        const profile = await s.xml('getUser', { username: user }, post, user);
        assertEquals(profile.value.user.podcastRole, String(user === 'admin'));
      }
    }
    await rawSql(s.store).run(
      "UPDATE users SET role='user' WHERE name='admin'",
    );
    assertEquals(
      (await s.ok('getUser', { username: 'admin' }, false, 'admin')).user
        .podcastRole,
      false,
    );
    assertEquals(
      (await s.json('refreshPodcasts', {}, true, 'admin')).error.code,
      50,
    );
  } finally {
    await s.close();
  }
});
