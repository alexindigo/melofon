import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { createState } from '../src/state.ts';
import { createPodcasts, type PodcastClock } from '../src/podcasts.ts';
import { createNetwork } from '../src/lookups/net.ts';

Deno.test('opening an existing pre-podcast store creates kept podcast tables without changing prior state', async () => {
  const dir = await Deno.makeTempDir();
  let store = await openStore(`${dir}/data`);
  try {
    await store.state.set('existing.setting', 'kept');
    // A legacy installation has the existing schema and data but neither of
    // the new tables. Raw schema setup stays behind the store's test seam.
    await rawSql(store).run('DROP TABLE podcast_episodes');
    await rawSql(store).run('DROP TABLE podcast_channels');
    await store.close();
    store = await openStore(`${dir}/data`);
    assertEquals(await store.state.get('existing.setting'), 'kept');
    const row = await store.podcasts.add('https://example.test/feed');
    assertEquals(row.status, 'new');
    assertEquals(await store.podcasts.episodes(row.id), []);
    assertEquals(await store.podcasts.delete(row.id), true);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

const item = (
  guid: string,
  title = 'Episode',
  duration = '01:02:03',
  date = 'Tue, 20 Oct 2026 12:30:00 GMT',
) =>
  `<item><guid isPermaLink="false">${guid}</guid><title>${title}</title><description><![CDATA[<p>Hello &amp; goodbye</p><script>bad()</script>]]></description><pubDate>${date}</pubDate><enclosure url="https://cdn.example.test/${guid}.mp3" type="audio/mpeg" length="12345"/><itunes:duration>${duration}</itunes:duration></item>`;
const rss = (
  items = item('one'),
  image = '<itunes:image href="https://images.example.test/cover.jpg"/>',
) =>
  `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Fixture &amp; News</title><description><![CDATA[<p>A <b>show</b></p>]]></description>${image}${items}</channel></rss>`;
class Clock implements PodcastClock {
  time = 1803038400000;
  callback?: () => void;
  due = 0;
  now = () => this.time;
  setTimeout(callback: () => void, ms: number) {
    this.callback = callback;
    this.due = this.time + ms;
    return callback;
  }
  clearTimeout() {
    this.callback = undefined;
  }
  async advance(ms: number) {
    this.time += ms;
    if (this.callback && this.time >= this.due) {
      const callback = this.callback;
      this.callback = undefined;
      callback();
    }
    await Promise.resolve();
  }
}
async function setup() {
  const dir = await Deno.makeTempDir();
  const store = await openStore(`${dir}/data`);
  const state = createState(store);
  // This fixture exercises feed facts only; downloads have their own real-file consumers.
  state.declare('podcasts.autoDownloadNewest', {
    type: 'integer',
    default: 1,
    minimum: 0,
  });
  await state.set('podcasts.autoDownloadNewest', '0');
  const clock = new Clock();
  let body = rss(), status = 200, hits = 0;
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    (request) => {
      if (!new URL(request.url).pathname.startsWith('/feed')) {
        return new Response(null, { status: 404 });
      }
      hits++;
      return new Response(body, { status });
    },
  );
  const network = createNetwork({
    state,
    fixtures: { 'images.example.test': `http://127.0.0.1:${server.addr.port}` },
  });
  await state.set('net.allowPrivateDestinations', 'true');
  const podcasts = await createPodcasts({
    store,
    state,
    network,
    clock,
    dataDir: `${dir}/data`,
  });
  await state.set('podcasts.requestsPerMinute', '600000');
  return {
    dir,
    store,
    state,
    clock,
    network,
    podcasts,
    url: `http://127.0.0.1:${server.addr.port}/feed`,
    set(xml: string, code = 200) {
      body = xml;
      status = code;
    },
    hits: () => hits,
    async close() {
      await podcasts.close();
      await server.shutdown();
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('podcast service adds RSS facts, idempotently refreshes and keeps stable episode identity without users', async () => {
  const s = await setup();
  try {
    const channel = await s.podcasts.addChannel(s.url);
    assertEquals(channel.status, 'completed');
    assertEquals(channel.title, 'Fixture & News');
    assertEquals(channel.description, 'A show');
    assertEquals(channel.imageUrl, 'https://images.example.test/cover.jpg');
    assertEquals(channel.lastRefreshMs, s.clock.time);
    const [episode] = await s.podcasts.episodes(channel.id);
    assertEquals({ ...episode, id: '', channelId: '' }, {
      id: '',
      channelId: '',
      guid: 'one',
      title: 'Episode',
      description: 'Hello & goodbye',
      publishDate: '2026-10-20T12:30:00.000Z',
      enclosureUrl: 'https://cdn.example.test/one.mp3',
      contentType: 'audio/mpeg',
      enclosureLength: 12345,
      duration: 3723,
      status: 'new',
      filePath: null,
      size: null,
      errorMessage: null,
    });
    s.set(
      rss(
        item('one', 'Changed', '90') +
          item('two', 'New', '02:03', 'Wed, 21 Oct 2026 12:30:00 GMT'),
        '<image><url>https://images.example.test/new.png</url></image>',
      ),
    );
    await Promise.all([s.podcasts.refresh(channel.id), s.podcasts.refresh()]);
    assertEquals((await s.podcasts.channels()).length, 1);
    assertEquals((await s.podcasts.episodes(channel.id)).length, 2);
    assertEquals((await s.podcasts.episode(episode.id))?.title, 'Changed');
    assertEquals((await s.podcasts.episode(episode.id))?.duration, 90);
    assertEquals(
      (await s.podcasts.channels())[0].imageUrl,
      'https://images.example.test/new.png',
    );
    const [newest] = await s.podcasts.newest(1);
    assertEquals(newest.guid, 'two');
    assertEquals(newest.duration, 123);
    assertEquals((await s.podcasts.addChannel(s.url)).id, channel.id);
    assertEquals(await s.podcasts.episode('absent'), null);
    assertEquals(await s.podcasts.newest(0), []);
    await assertRejects(() => s.podcasts.addChannel('file:///etc/passwd'));
    assertEquals((await s.podcasts.channels()).length, 1);
  } finally {
    await s.close();
  }
});

Deno.test('podcast failures remain visible, preserve prior episodes and recover on a later refresh', async () => {
  const s = await setup();
  try {
    s.set('<rss><channel>');
    const channel = await s.podcasts.addChannel(s.url);
    assertEquals(channel.status, 'error');
    assert(channel.errorMessage?.includes('Bad XML'));
    assertEquals(await s.podcasts.episodes(channel.id), []);
    s.set(rss());
    await s.podcasts.refresh(channel.id);
    const before = await s.podcasts.episodes(channel.id);
    for (
      const [body, code, error] of [['missing', 404, 'HTTP 404'], [
        '<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title></feed>',
        200,
        'Unsupported feed',
      ], [
        '<!DOCTYPE rss [<!ENTITY x "bad">]><rss version="2.0"><channel><title>&x;</title></channel></rss>',
        200,
        'Unsupported feed declaration',
      ]] as const
    ) {
      s.set(body, code);
      await s.podcasts.refresh(channel.id);
      const failed = (await s.podcasts.channels())[0];
      assertEquals(failed.status, 'error');
      assert(failed.errorMessage?.includes(error));
      assertEquals(await s.podcasts.episodes(channel.id), before);
    }
    s.set(rss());
    await s.podcasts.refresh(channel.id);
    assertEquals((await s.podcasts.channels())[0].errorMessage, null);
    await s.state.set('net.allowPrivateDestinations', 'false');
    const hits = s.hits();
    await s.podcasts.refresh(channel.id);
    assert(
      (await s.podcasts.channels())[0].errorMessage?.includes(
        'destination refused',
      ),
    );
    assertEquals(s.hits(), hits);
  } finally {
    await s.close();
  }
});

Deno.test('podcast feed cap is live and GUID fallback, missing facts and duplicate items remain well-defined', async () => {
  const s = await setup();
  try {
    assertEquals(await s.state.getTyped('podcasts.maxFeedMegabytes'), 10);
    await s.state.set('podcasts.maxFeedMegabytes', '0.001');
    s.set(rss(item('one', 'x'.repeat(2048))));
    const channel = await s.podcasts.addChannel(s.url);
    assertEquals(channel.status, 'error');
    assert(channel.errorMessage?.includes('size cap'));
    await s.state.set('podcasts.maxFeedMegabytes', '1');
    const fallback =
      '<item><title>00012</title><pubDate>invalid</pubDate><itunes:duration>01:99:00</itunes:duration><enclosure url="/fallback.mp3" length="invalid"/></item>';
    s.set(
      rss(fallback + fallback + '<item><title>No enclosure</title></item>'),
    );
    await s.podcasts.refresh(channel.id);
    const episodes = await s.podcasts.episodes(channel.id);
    assertEquals(episodes.length, 1);
    assertEquals(episodes[0].guid, new URL('/fallback.mp3', s.url).href);
    assertEquals(episodes[0].title, '00012');
    assertEquals(episodes[0].publishDate, null);
    assertEquals(episodes[0].duration, null);
    assertEquals(episodes[0].enclosureLength, null);
  } finally {
    await s.close();
  }
});

Deno.test('podcast refresh schedule uses persisted per-channel age, injected time, live interval and startup catch-up', async () => {
  const s = await setup();
  try {
    assertEquals(await s.state.getTyped('podcasts.refreshHours'), 24);
    const channel = await s.podcasts.addChannel(s.url);
    const initial = s.hits();
    await s.clock.advance(23 * 3600000);
    await s.podcasts.idle();
    assertEquals(s.hits(), initial);
    s.set(rss(item('two')));
    await s.clock.advance(3600000);
    await s.podcasts.idle();
    assertEquals(s.hits(), initial + 1);
    assertEquals((await s.podcasts.episodes(channel.id)).length, 2);
    await s.state.set('podcasts.refreshHours', '1');
    await s.podcasts.idle();
    await s.clock.advance(3600000);
    await s.podcasts.idle();
    assertEquals(s.hits(), initial + 2);
    await s.podcasts.close();
    await s.clock.advance(2 * 3600000);
    const restarted = await createPodcasts({
      store: s.store,
      state: s.state,
      network: s.network,
      clock: s.clock,
      dataDir: `${s.dir}/data`,
    });
    try {
      assertEquals(s.hits(), initial + 3);
      assertEquals((await restarted.channels())[0].lastRefreshMs, s.clock.time);
    } finally {
      await restarted.close();
    }
  } finally {
    await s.close();
  }
});

Deno.test('podcast shutdown owns timers created by an already-running refresh', async () => {
  const s = await setup();
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const read = s.state.getTyped;
  try {
    const channel = await s.podcasts.addChannel(s.url);
    s.state.getTyped = (key) => {
      if (key !== 'podcasts.refreshHours') return read(key);
      reached.resolve();
      return release.promise.then(() => read(key));
    };
    const refreshing = s.podcasts.refresh(channel.id);
    await reached.promise;
    const closing = s.podcasts.close();
    release.resolve();
    await Promise.all([refreshing, closing]);
    assertEquals(
      s.clock.callback,
      undefined,
      'shutdown leaves no refresh timer, even when its settings read was in flight',
    );
  } finally {
    release.resolve();
    await s.close();
  }
});

Deno.test('podcast kept rows survive store reopen and deletion atomically removes only the selected channel', async () => {
  const s = await setup();
  try {
    const one = await s.podcasts.addChannel(s.url);
    const two = await s.podcasts.addChannel(`${s.url}?second`);
    const episode = (await s.podcasts.episodes(one.id))[0];
    await s.podcasts.close();
    await s.store.close();
    const reopened = await openStore(`${s.dir}/data`);
    const restarted = await createPodcasts({
      store: reopened,
      state: createState(reopened),
      clock: new Clock(),
      dataDir: `${s.dir}/data`,
    });
    try {
      assertEquals((await restarted.channels()).length, 2);
      assertEquals(await restarted.episode(episode.id), episode);
      assertEquals(await restarted.deleteChannel(one.id), true);
      assertEquals(await restarted.episode(episode.id), null);
      assertEquals(await restarted.episodes(one.id), []);
      assertEquals(await restarted.deleteChannel(one.id), false);
      assertEquals((await restarted.channels()).map((row) => row.id), [two.id]);
      assertEquals((await restarted.episodes(two.id)).length, 1);
    } finally {
      await restarted.close();
      await reopened.close();
    }
  } finally {
    await s.close();
  }
});
