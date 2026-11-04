import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { createNetwork, type LookupNetwork } from '../src/lookups/net.ts';
import { createRadioSource, RadioSourceError } from '../src/radio-source.ts';
import { createState } from '../src/state.ts';
import { openStore } from '../src/store/index.ts';
import { httpRadio, type RadioReply } from './helpers/http-radio.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const signal = () => new AbortController().signal;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const untilAborted = (signal: AbortSignal) =>
  signal.aborted
    ? Promise.resolve()
    : new Promise<void>((done) =>
      signal.addEventListener('abort', () => done(), { once: true })
    );
async function eventually(check: () => boolean) {
  const end = performance.now() + 3000;
  while (!check()) {
    assert(performance.now() < end, 'HTTP fixture did not observe cleanup');
    await sleep(10);
  }
}
function reply(text: string, mime = 'audio/x-mpegurl'): RadioReply {
  return { headers: { 'content-type': mime }, body: [encoder.encode(text)] };
}
function redirect(location: string): RadioReply {
  return { statusLine: 'HTTP/1.1 302 Found', headers: { location } };
}
function resolver(
  network: Pick<LookupNetwork, 'stream'> = createNetwork(),
  settings: Record<string, number> = {},
) {
  return createRadioSource({
    network,
    state: {
      declare() {},
      getTyped: (key) =>
        Promise.resolve(
          key === 'radio.sourceRequestsPerMinute' ? 600000 : settings[key],
        ),
    },
  });
}
function paths(server: ReturnType<typeof httpRadio>) {
  return server.requests.map((request) => new URL(request.url).pathname);
}
async function text(
  source: ReturnType<ReturnType<typeof resolver>['session']>,
) {
  const lease = await source.open();
  try {
    return await lease.response.text();
  } finally {
    await lease.close();
  }
}

Deno.test('radio PLS sorts numbered alternatives and resolves relative URLs against final redirected playlist URL', async () => {
  const audio = await Deno.readFile(
    new URL(
      './fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3',
      import.meta.url,
    ),
  );
  const server = httpRadio((request) => {
    assertEquals(request.headers.get('accept-encoding'), 'identity');
    const url = new URL(request.url);
    if (url.pathname === '/start') {
      return redirect('/dir/station.PLS?token=kept');
    }
    if (url.pathname === '/dir/station.PLS') {
      return reply(
        '[playlist]\r\nFile2=/backup\r\nTitle1=Station\r\nFile1=../audio?token=a%2Cb&x=1#ignored\r\nNumberOfEntries=2\r\nVersion=2',
        'text/plain',
      );
    }
    if (url.pathname === '/audio') {
      assertEquals(url.search, '?token=a%2Cb&x=1');
      return { headers: { 'icy-name': 'One station' }, body: [audio] };
    }
    return reply('backup', 'audio/mpeg');
  });
  const source = resolver().session(`${server.origin}/start`, signal());
  try {
    const lease = await source.open();
    assertEquals(lease.url, `${server.origin}/audio?token=a%2Cb&x=1`);
    assertEquals(lease.response.headers.get('icy-name'), 'One station');
    assertEquals(new Uint8Array(await lease.response.arrayBuffer()), audio);
    await lease.close();
    assertEquals(paths(server), ['/start', '/dir/station.PLS', '/audio']);
    assertEquals(await text(source), 'backup');
    assertEquals(paths(server), [
      '/start',
      '/dir/station.PLS',
      '/audio',
      '/backup',
    ]);
  } finally {
    await source.close();
    await server.close();
  }
});

Deno.test('radio recognizes M3U/PLS by MIME, suffix or a fragmented BOM prefix without a MIME hint', async () => {
  for (const type of ['suffix', 'mime', 'sniff-m3u', 'sniff-pls', 'plain']) {
    const server = httpRadio((request) => {
      if (new URL(request.url).pathname === '/audio') {
        return reply('ID3-audio', 'audio/mpeg');
      }
      const playlist = type === 'sniff-pls'
        ? '\uFEFF[playlist]\nFile1=audio\n'
        : type === 'plain'
        ? 'audio\n'
        : '\uFEFF#EXTM3U\n#EXTINF:-1,Station\naudio\n';
      return {
        headers: {
          'content-type': type === 'mime' || type === 'plain'
            ? 'Audio/X-MpegURL; charset=utf-8'
            : 'application/octet-stream',
        },
        body: (function* () {
          for (const byte of encoder.encode(playlist)) {
            yield new Uint8Array([byte]);
          }
        })(),
      };
    });
    const source = resolver().session(
      `${server.origin}/${type === 'suffix' ? 'radio.M3U' : 'radio'}`,
      signal(),
    );
    try {
      assertEquals(await text(source), 'ID3-audio');
      assertEquals(paths(server).length, 2);
    } finally {
      await source.close();
      await server.close();
    }
  }
});

Deno.test('radio alternatives are lazy depth-first source attempts, return failures to the retry owner and wrap only on a later call', async () => {
  const server = httpRadio((request) => {
    switch (new URL(request.url).pathname) {
      case '/root.m3u':
        return reply('nested.pls\nlast\n');
      case '/nested.pls':
        return reply('[playlist]\nFile2=good\nFile1=bad\n', 'audio/x-scpls');
      case '/bad':
        return { statusLine: 'HTTP/1.1 503 Unavailable' };
      default:
        return reply('ID3-good', 'audio/mpeg');
    }
  });
  const source = resolver().session(`${server.origin}/root.m3u`, signal());
  try {
    await assertRejects(() => source.open(), RadioSourceError, 'HTTP 503');
    assertEquals(paths(server), ['/root.m3u', '/nested.pls', '/bad']);
    assertEquals(await text(source), 'ID3-good');
    assertEquals(paths(server), ['/root.m3u', '/nested.pls', '/bad', '/good']);
    assertEquals(await text(source), 'ID3-good');
    assertEquals(paths(server).at(-1), '/last');
    await assertRejects(() => source.open(), RadioSourceError, 'HTTP 503');
    assertEquals(paths(server).slice(-3), ['/root.m3u', '/nested.pls', '/bad']);
  } finally {
    await source.close();
    await server.close();
  }
});

Deno.test('radio leaves the active final response open and replays its prefix byte-exactly beyond the resolution deadline', async () => {
  const first = new Uint8Array([0xff, 0xfb, 0, 1, 2, 3]);
  let more!: () => void;
  const ready = new Promise<void>((done) => more = done);
  const server = httpRadio((_request, stopped) => ({
    headers: {
      'content-length': '999999999',
      'content-type': 'application/octet-stream',
    },
    body: (async function* () {
      yield first;
      await ready;
      yield encoder.encode('later');
      await untilAborted(stopped);
    })(),
  }));
  const source = resolver(undefined, { 'radio.resolveTimeoutSeconds': 0.2 })
    .session(server.origin, signal());
  try {
    const lease = await source.open();
    const reader = lease.response.body!.getReader();
    assertEquals((await reader.read()).value, first);
    assertEquals(server.closed, 0);
    await sleep(300);
    more();
    assertEquals(decoder.decode((await reader.read()).value), 'later');
    assertEquals(server.closed, 0);
    reader.releaseLock();
    await lease.close();
    await eventually(() => server.closed === 1);
    assertEquals(paths(server), ['/']);
  } finally {
    more();
    await source.close();
    await server.close();
  }
});

Deno.test('radio never trusts a private external playlist entry, while the original host on a different port stays trusted', async () => {
  let forbidden = 0;
  const other = httpRadio((request) => {
    if (new URL(request.url).pathname === '/forbidden') forbidden++;
    return reply('ID3-port', 'audio/mpeg');
  });
  const server = httpRadio(() =>
    reply(
      `http://external.test:${
        new URL(other.origin).port
      }/forbidden\n${other.origin}/same-host\n`,
    )
  );
  const ip =
    Deno.networkInterfaces().find((nic) =>
      nic.family === 'IPv4' && !nic.address.startsWith('127.')
    )!.address;
  const network = createNetwork({ resolve: () => Promise.resolve([ip]) });
  const source = resolver(network).session(
    `${server.origin}/root.m3u`,
    signal(),
  );
  try {
    await assertRejects(() => source.open(), Error, 'destination refused');
    assertEquals(forbidden, 0);
    assertEquals(paths(other), []);
    assertEquals(await text(source), 'ID3-port');
    assertEquals(paths(other), ['/same-host']);
    assertEquals(paths(server), ['/root.m3u']);
  } finally {
    await source.close();
    await server.close();
    await other.close();
  }
});

Deno.test('radio retains entered trust through public cross-host redirects, nested playlists and subsequent alternative attempts', async () => {
  const server = httpRadio((request) => {
    switch (new URL(request.url).pathname) {
      case '/start':
        return redirect('http://public.test/dir/root.m3u');
      case '/dir/root.m3u':
        return reply('child.pls\n/audio\n');
      case '/dir/child.pls':
        return reply(
          '[playlist]\nFile1=http://private.test/secret\n',
          'audio/x-scpls',
        );
      default:
        return reply('ID3-public', 'audio/mpeg');
    }
  });
  const network = createNetwork({
    fixtures: { 'public.test': server.origin },
    resolve: () => Promise.resolve(['127.0.0.1']),
  });
  const contexts: string[][] = [];
  const source = resolver({
    stream(authority, ...args) {
      contexts.push([...authority.trustedHosts]);
      return network.stream(authority, ...args);
    },
  }).session(`${server.origin}/start`, signal());
  try {
    await assertRejects(() => source.open(), Error, 'destination refused');
    assertEquals(paths(server), ['/start', '/dir/root.m3u', '/dir/child.pls']);
    assertEquals(await text(source), 'ID3-public');
    assertEquals(contexts.length, 4);
    assert(
      contexts.every((hosts) =>
        hosts.length === 1 && hosts[0] === 'melofon.home'
      ),
    );
    assert(!paths(server).includes('/secret'));
  } finally {
    await source.close();
    await server.close();
  }
});

Deno.test('radio detects path and redirect-alias cycles without losing a remaining backup', async () => {
  for (const alias of [false, true]) {
    const server = httpRadio((request) => {
      const path = new URL(request.url).pathname;
      if (path === '/root.m3u') {
        return reply(`${alias ? 'alias' : 'root.m3u#fragment'}\naudio\n`);
      }
      if (path === '/alias') return redirect('/root.m3u');
      return reply('ID3-backup', 'audio/mpeg');
    });
    const source = resolver().session(`${server.origin}/root.m3u`, signal());
    try {
      await assertRejects(() => source.open(), RadioSourceError, 'cycle');
      assertEquals(
        paths(server),
        alias ? ['/root.m3u', '/alias', '/root.m3u'] : ['/root.m3u'],
      );
      assertEquals(await text(source), 'ID3-backup');
    } finally {
      await source.close();
      await server.close();
    }
  }
});

Deno.test('radio permits shared nested playlists on sibling branches rather than confusing repeats with cycles', async () => {
  const server = httpRadio((request) => {
    const path = new URL(request.url).pathname;
    return path === '/root.m3u'
      ? reply('shared.m3u\nshared.m3u\n')
      : path === '/shared.m3u'
      ? reply('audio\n')
      : reply('ID3-shared', 'audio/mpeg');
  });
  const source = resolver().session(`${server.origin}/root.m3u`, signal());
  try {
    assertEquals(await text(source), 'ID3-shared');
    assertEquals(await text(source), 'ID3-shared');
    assertEquals(paths(server), [
      '/root.m3u',
      '/shared.m3u',
      '/audio',
      '/shared.m3u',
      '/audio',
    ]);
  } finally {
    await source.close();
    await server.close();
  }
});

Deno.test('radio bounds playlist bytes with and without Content-Length and closes a still-streaming document', async () => {
  for (const declared of [false, true]) {
    const server = httpRadio((_request, stopped) => ({
      headers: {
        'content-type': 'audio/x-mpegurl',
        ...(declared ? { 'content-length': '10000' } : {}),
      },
      body: (async function* () {
        yield encoder.encode('#'.repeat(65));
        await untilAborted(stopped);
      })(),
    }));
    const source = resolver(undefined, { 'radio.playlistMaxBytes': 64 })
      .session(server.origin, signal());
    try {
      await assertRejects(() => source.open(), RadioSourceError, 'byte limit');
      await eventually(() => server.closed === 1);
      assertEquals(paths(server), ['/']);
    } finally {
      await source.close();
      await server.close();
    }
  }
});

Deno.test('radio bounds nesting, cumulative entries and documents across the lazy alternative tree', async () => {
  for (const bound of ['Depth', 'Entries', 'Documents']) {
    const server = httpRadio((request) => {
      switch (new URL(request.url).pathname) {
        case '/root.m3u':
          return reply('child.m3u\naudio\n');
        case '/child.m3u':
          return reply('grandchild.m3u\n');
        case '/grandchild.m3u':
          return reply('audio\n');
        default:
          return reply('ID3-audio', 'audio/mpeg');
      }
    });
    const source = resolver(undefined, {
      [`radio.playlistMax${bound}`]: bound === 'Entries' ? 2 : 1,
    })
      .session(`${server.origin}/root.m3u`, signal());
    try {
      await assertRejects(
        () => source.open(),
        RadioSourceError,
        bound === 'Entries' ? 'entry limit' : 'nesting/document limit',
      );
      assertEquals(paths(server), ['/root.m3u', '/child.m3u']);
      assertEquals(
        await text(source),
        'ID3-audio',
        'a failure returns to the owner; the next attempt can reach a sibling',
      );
    } finally {
      await source.close();
      await server.close();
    }
  }
});

Deno.test('radio explicitly rejects HLS by suffix, MIME or manifest tags, plus legacy ICY status lines, without secondary requests', async () => {
  const server = httpRadio((request) => {
    switch (new URL(request.url).pathname) {
      case '/legacy':
        return { statusLine: 'ICY 200 OK' };
      case '/mime':
        return reply('#EXTM3U\n', 'application/vnd.apple.mpegurl');
      case '/radio.m3u8':
        return reply('#EXTM3U\n');
      default:
        return reply(
          '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="/key"\n#EXT-X-TARGETDURATION:10\nsegment.ts\n',
          'audio/mpeg',
        );
    }
  });
  try {
    for (
      const path of [
        '/radio.m3u8',
        '/mime',
        '/radio.m3u',
        '/disguised',
        '/legacy',
      ]
    ) {
      const source = resolver().session(`${server.origin}${path}`, signal());
      try {
        if (path === '/legacy') {
          await assertRejects(() => source.open(), Error, 'Parse Error');
        } else {
          await assertRejects(
            () => source.open(),
            RadioSourceError,
            'HLS radio is not supported',
          );
        }
      } finally {
        await source.close();
      }
    }
    assertEquals(paths(server), [
      '/radio.m3u8',
      '/mime',
      '/radio.m3u',
      '/disguised',
      '/legacy',
    ]);
  } finally {
    await server.close();
  }
});

Deno.test('radio rejects malformed/empty playlists and unsupported addresses instead of silently skipping or contacting them', async () => {
  const server = httpRadio((request) => {
    switch (new URL(request.url).pathname) {
      case '/empty.m3u':
        return reply('#EXTM3U\n#comment\n');
      case '/invalid.pls':
        return reply('not a playlist', 'audio/x-scpls');
      case '/duplicate.pls':
        return reply('[playlist]\nFile1=/audio\nFile1=/other', 'audio/x-scpls');
      case '/zero.pls':
        return reply('[playlist]\nFile0=/audio', 'audio/x-scpls');
      case '/empty.pls':
        return reply('[playlist]\nFile1=', 'audio/x-scpls');
      case '/scheme.m3u':
        return reply('file:///etc/passwd\n/audio');
      case '/userinfo.m3u':
        return reply('http://user:pass@melofon.home/secret\n/audio');
      case '/bodyless':
        return { statusLine: 'HTTP/1.1 204 No Content' };
      default:
        return reply('ID3-audio', 'audio/mpeg');
    }
  });
  try {
    const api = resolver();
    for (
      const url of [
        'file:///etc/passwd',
        'ftp://melofon.home/a',
        'http://user:pass@melofon.home/a',
      ]
    ) {
      assertThrows(
        () => api.session(url, signal()),
        RadioSourceError,
        'HTTP(S)',
      );
    }
    for (
      const path of [
        '/empty.m3u',
        '/invalid.pls',
        '/duplicate.pls',
        '/zero.pls',
        '/empty.pls',
        '/scheme.m3u',
        '/userinfo.m3u',
        '/bodyless',
      ]
    ) {
      const source = api.session(`${server.origin}${path}`, signal());
      try {
        await assertRejects(() => source.open(), RadioSourceError);
        if (path === '/scheme.m3u' || path === '/userinfo.m3u') {
          assertEquals(await text(source), 'ID3-audio');
        }
      } finally {
        await source.close();
      }
    }
    assert(!paths(server).includes('/secret'));
    assertEquals(paths(server).filter((path) => path === '/audio').length, 2);
  } finally {
    await server.close();
  }
});

Deno.test('radio resolution timeout bounds a slow playlist and a parked prefix, preserving caller cancellation and closing TCP', async () => {
  for (
    const mode of [
      'playlist-timeout',
      'prefix-timeout',
      'caller-abort',
      'close',
    ]
  ) {
    const server = httpRadio((_request, stopped) => ({
      headers: {
        'content-type': mode === 'playlist-timeout' || mode === 'caller-abort'
          ? 'audio/x-mpegurl'
          : 'audio/mpeg',
      },
      body: (async function* () {
        yield encoder.encode(
          mode.startsWith('playlist') || mode === 'caller-abort'
            ? '#EXTM3U\n'
            : 'h',
        );
        await untilAborted(stopped);
      })(),
    }));
    const cancel = new AbortController();
    const source = resolver(undefined, { 'radio.resolveTimeoutSeconds': 0.2 })
      .session(server.origin, cancel.signal);
    try {
      const opening = source.open();
      const rejected = assertRejects(
        () => opening,
        mode === 'caller-abort'
          ? Error
          : mode === 'close'
          ? DOMException
          : RadioSourceError,
        mode === 'caller-abort'
          ? 'caller stopped'
          : mode === 'close'
          ? 'session closed'
          : 'resolution timed out',
      );
      await eventually(() => server.requests.length === 1);
      if (mode === 'caller-abort') cancel.abort(new Error('caller stopped'));
      if (mode === 'close') await source.close();
      await rejected;
      await eventually(() => server.closed === 1);
      assertEquals(paths(server), ['/']);
    } finally {
      await source.close();
      await server.close();
    }
  }
});

Deno.test('radio abort, session close, lease close and consumer cancel revoke unread replay and pending audio without opening backups', async () => {
  for (
    const mode of [
      'abort-unread',
      'abort-pending',
      'session',
      'lease',
      'consumer',
      'replace',
    ]
  ) {
    const server = httpRadio((request, stopped) =>
      new URL(request.url).pathname === '/root.m3u'
        ? reply('live\nbackup\n')
        : {
          body: (async function* () {
            yield encoder.encode('ID3-live');
            await untilAborted(stopped);
          })(),
        }
    );
    const cancel = new AbortController();
    const source = resolver().session(
      `${server.origin}/root.m3u`,
      cancel.signal,
    );
    try {
      const lease = await source.open();
      const reader = lease.response.body!.getReader();
      let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
      if (mode === 'abort-pending') {
        assertEquals(decoder.decode((await reader.read()).value), 'ID3-live');
        pending = reader.read();
      }
      if (mode === 'consumer') {
        await reader.cancel();
        reader.releaseLock();
      } else {
        const rejected = pending ? assertRejects(() => pending!) : undefined;
        if (mode.startsWith('abort')) cancel.abort(new Error('revoked'));
        else if (mode === 'session') await source.close();
        else if (mode === 'replace') {
          const replacement = await source.open();
          await replacement.close();
        } else await Promise.all([lease.close(), lease.close()]);
        await (rejected ?? assertRejects(() => reader.read()));
        reader.releaseLock();
      }
      await lease.close();
      await eventually(() => server.closed === server.requests.length);
      assertEquals(
        paths(server),
        mode === 'replace'
          ? ['/root.m3u', '/live', '/backup']
          : ['/root.m3u', '/live'],
      );
    } finally {
      await source.close();
      await server.close();
    }
  }
});

Deno.test('radio serializes attempt ownership and closing during headers waits for the original open to settle', async () => {
  const server = httpRadio(async (_request, stopped) => {
    await untilAborted(stopped);
    return {};
  });
  const source = resolver().session(server.origin, signal());
  try {
    const opening = source.open();
    const rejected = assertRejects(
      () => opening,
      DOMException,
      'session closed',
    );
    await eventually(() => server.requests.length === 1);
    await assertRejects(
      () => source.open(),
      RadioSourceError,
      'already opening',
    );
    await source.close();
    await rejected;
    await assertRejects(() => source.open(), DOMException, 'session closed');
    await eventually(() => server.closed === 1);
    assertEquals(paths(server), ['/']);
  } finally {
    await source.close();
    await server.close();
  }
});

Deno.test('radio declares validated owner settings and applies changed playlist limits on subsequent attempts', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore(`${dir}/data`);
  const state = createState(store);
  const api = createRadioSource({ network: createNetwork({ state }), state });
  const server = httpRadio((request) =>
    new URL(request.url).pathname === '/root.m3u'
      ? reply('audio\n')
      : reply('ID3-audio', 'audio/mpeg')
  );
  const source = api.session(`${server.origin}/root.m3u`, signal());
  try {
    for (
      const [key, expected] of Object.entries({
        resolveTimeoutSeconds: 10,
        playlistMaxBytes: 65536,
        playlistMaxDepth: 4,
        playlistMaxDocuments: 16,
        playlistMaxEntries: 128,
        playlistProbeBytes: 512,
        sourceRequestsPerMinute: 600,
      })
    ) {
      assertEquals(await state.getTyped(`radio.${key}`), expected);
      await assertRejects(() => state.set(`radio.${key}`, '0'));
    }
    await assertRejects(() => state.set('radio.playlistMaxEntries', '1.5'));
    await state.set('radio.playlistMaxBytes', '5');
    await assertRejects(() => source.open(), RadioSourceError, 'byte limit');
    await state.set('radio.playlistMaxBytes', '6');
    assertEquals(await text(source), 'ID3-audio');
  } finally {
    await source.close();
    await server.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
