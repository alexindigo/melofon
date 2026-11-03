import { assert, assertEquals } from '@std/assert';
import { apiFixture, error } from './helpers/api.ts';
import { authFixture } from './helpers/authentication.ts';
import { restored } from './helpers/prepared.ts';
import { createLibraries } from '../src/libraries.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibrary } from '../src/library.ts';
import { createMedia, type Media } from '../src/media.ts';
import { createStream } from '../src/stream.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createPlayback } from '../src/playback.ts';
import { createPlayer } from '../src/player.ts';
import { createListens } from '../src/listens.ts';
import { decoded, landmark, RATE } from './h5-helpers.ts';

const direct = {
  name: 'Native player',
  platform: 'HTTP',
  directPlayProfiles: [{
    containers: [],
    audioCodecs: [],
    protocols: ['http'],
  }],
  transcodingProfiles: [{
    container: 'mp3',
    audioCodec: 'mp3',
    protocol: 'http',
  }],
};
const capabilitiesPath = '/api/v1/me/playback-capabilities';

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert(Date.now() < deadline, 'stream observer timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function setup(seconds?: number) {
  // Private media roots are intentionally not prepared DB templates.
  const mediaDir = seconds === undefined ? undefined : await Deno.makeTempDir();
  if (mediaDir) {
    const bytes = RATE * seconds! * 4;
    const wav = new Uint8Array(44 + bytes);
    const view = new DataView(wav.buffer);
    const text = (at: number, value: string) =>
      wav.set(new TextEncoder().encode(value), at);
    text(0, 'RIFF');
    view.setUint32(4, wav.length - 8, true);
    text(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, RATE, true);
    view.setUint32(28, RATE * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, bytes, true);
    for (let i = 0; i < RATE * seconds!; i++) {
      const value = Math.round(12000 * landmark(i / RATE));
      view.setInt16(44 + i * 4, value, true);
      view.setInt16(46 + i * 4, value, true);
    }
    await Deno.writeFile(`${mediaDir}/landmark.wav`, wav);
  }
  const build = async (dir: string) => {
    const f = await authFixture(undefined, dir);
    try {
      await createLibraries(f.store).add(
        'Music',
        mediaDir ?? await Deno.realPath('tests/fixtures/library'),
      );
      await scanLibrary(f.store);
    } finally {
      await f.close();
    }
  };
  const dir = mediaDir
    ? await Deno.makeTempDir()
    : await restored('api-stream', build, 'melofon-api-stream-');
  if (mediaDir) await build(dir);
  let media!: Media;
  let started = 0, active = 0;
  let encoders = true;
  const f = await apiFixture({
    storeDir: dir,
    services: (f) => {
      const library = createLibrary(f.store);
      media = createMedia(undefined, f.state);
      const transcode = media.transcodeAudio.bind(media);
      media.transcodeAudio = async (...args) => {
        started++;
        const result = await transcode(...args);
        if (result) {
          active++;
          void result.completion.finally(() => active--);
        }
        return result;
      };
      const profiles = media.audioProfiles.bind(media);
      media.audioProfiles = () => encoders ? profiles() : Promise.resolve([]);
      return Promise.resolve({
        library,
        playback: createPlayback({
          library,
          player: createPlayer(),
          cfg: f.cfg,
          notify: f.notify,
          nowPlaying: createNowPlaying(f.store, { state: f.state }),
          sessions: f.auth.sessions,
        }),
        stream: createStream(
          media,
          f.cfg,
          undefined,
          undefined,
          f.auth.sessions,
        ),
      });
    },
  });
  const ips = await Deno.resolveDns('melofon.home', 'A');
  assert(ips.length > 0 && ips.every((ip) => !ip.startsWith('127.')));
  const songs = await createLibrary(f.store).listSongs({
    size: 100,
    offset: 0,
  });
  const song = songs.find((s) => !s.isVideo)!;
  const video = songs.find((s) => s.isVideo);
  const cookie = (await f.login('cookie')).credential;
  const bearer = (await f.login('bearer')).credential;
  const route = (id = song.id, query = '') =>
    `/api/v1/songs/${id}/stream${query}`;
  const register = async (credential: string, body: unknown = direct) => {
    const r = await f.json(capabilitiesPath, 'PUT', body, credential);
    assertEquals(r.status, 200, await r.clone().text());
    await r.body?.cancel();
  };
  return {
    f,
    song,
    video,
    cookie,
    bearer,
    media,
    dir,
    route,
    register,
    counts: () => ({ started, active }),
    noEncoders: () => {
      encoders = false;
    },
    async close() {
      await waitFor(() => active === 0);
      await f.close();
      await Deno.remove(dir, { recursive: true });
      if (mediaDir) await Deno.remove(mediaDir, { recursive: true });
    },
  };
}

Deno.test('API song stream: cookie/Bearer original ranges, validators, HEAD and deployed mounts', async () => {
  const t = await setup();
  try {
    const original = await Deno.readFile(t.song.path);
    for (const credential of [t.cookie, t.bearer]) {
      await t.register(credential);
      const r = await t.f.get(t.route(), credential);
      assertEquals(r.status, 200);
      assertEquals(new Uint8Array(await r.arrayBuffer()), original);
      const etag = r.headers.get('etag')!;
      assert(etag);
      const head = await t.f.request(t.route(), {
        method: 'HEAD',
        headers: { Cookie: t.cookie },
      });
      assertEquals(head.status, 200);
      assertEquals(head.headers.get('etag'), etag);
      assertEquals((await head.arrayBuffer()).byteLength, 0);
      for (const start of [0, 32, 0]) {
        const range = await t.f.get(t.route(), credential, {
          Range: `bytes=${start}-${start + 31}`,
        });
        assertEquals(range.status, 206);
        assertEquals(
          range.headers.get('content-range'),
          `bytes ${start}-${start + 31}/${original.length}`,
        );
        assertEquals(
          new Uint8Array(await range.arrayBuffer()),
          original.slice(start, start + 32),
        );
      }
      const dateRange = await t.f.get(t.route(), credential, {
        Range: 'bytes=0-31',
        'If-Range': r.headers.get('last-modified')!,
      });
      assertEquals(dateRange.status, 206);
      assertEquals(
        new Uint8Array(await dateRange.arrayBuffer()),
        original.slice(0, 32),
      );
      // std emits weak file-stat ETags; they cannot authorize If-Range.
      assert(etag.startsWith('W/'));
      for (
        const validator of [
          etag,
          '"stale"',
          'invalid',
          'Wed, 01 Jan 2020 00:00:00 GMT',
        ]
      ) {
        const stale = await t.f.get(t.route(), credential, {
          Range: 'bytes=0-31',
          'If-Range': validator,
        });
        assertEquals(stale.status, 200);
        assertEquals(new Uint8Array(await stale.arrayBuffer()), original);
      }
      const notModified = await t.f.get(t.route(), credential, {
        'If-None-Match': etag,
      });
      assertEquals(notModified.status, 304);
      assertEquals((await notModified.arrayBuffer()).byteLength, 0);
      const unsatisfiable = await t.f.get(t.route(), credential, {
        Range: `bytes=${original.length + 1}-`,
      });
      assertEquals(unsatisfiable.status, 416);
      await unsatisfiable.body?.cancel();
    }
    assertEquals(t.counts().started, 0);
    for (const prefix of ['', '/music']) {
      await t.f.state.set(
        'server.baseUrl',
        prefix ? `${t.f.origin}${prefix}` : '',
      );
      for (const forced of ['', '/_melofon']) {
        const r = await t.f.get(`${prefix}${forced}${t.route()}`, t.bearer);
        assertEquals(r.status, 200);
        assertEquals(new Uint8Array(await r.arrayBuffer()), original);
      }
    }
  } finally {
    await t.close();
  }
});

Deno.test('API song stream: per-session negotiation, exact encoded facts and explicit override precedence', async () => {
  const t = await setup();
  try {
    const limited = {
      ...direct,
      codecProfiles: [{
        type: 'AudioCodec',
        name: 'mp3',
        limitations: [
          {
            name: 'audioChannels',
            comparison: 'Equals',
            values: ['1'],
            required: true,
          },
          {
            name: 'audioSamplerate',
            comparison: 'Equals',
            values: ['22050'],
            required: true,
          },
          {
            name: 'audioBitrate',
            comparison: 'Equals',
            values: ['64000'],
            required: true,
          },
        ],
      }],
    };
    await t.register(t.cookie, limited);
    const exact = await t.f.get(t.route(t.video!.id), t.cookie);
    assertEquals(exact.status, 200);
    const path = `${t.dir}/received.mp3`;
    await Deno.writeFile(path, new Uint8Array(await exact.arrayBuffer()));
    assertEquals((await t.media.probe(path)).hasVideo, false);
    const facts = (await t.media.describeAudio(path))!;
    assertEquals([
      facts.codec,
      facts.audioChannels,
      facts.audioSamplerate,
      facts.audioBitrate,
    ], ['mp3', 1, 22050, 64000]);
    const pcm = await t.media.decodePcm(path);
    assert(pcm);
    let bytes = 0;
    for await (const chunk of pcm) bytes += chunk.length;
    assert(bytes > 0);
    const fallback = await t.f.get(t.route(t.video!.id), t.bearer);
    await Deno.writeFile(path, new Uint8Array(await fallback.arrayBuffer()));
    assertEquals((await t.media.describeAudio(path))!.audioSamplerate, 44100);
    await t.register(t.cookie, {
      ...direct,
      maxAudioBitrate: 32000,
      maxTranscodingAudioBitrate: 32000,
    });
    const override = await t.f.get(
      t.route(t.video!.id, '?format=mp3&maxBitRate=64'),
      t.cookie,
    );
    await Deno.writeFile(path, new Uint8Array(await override.arrayBuffer()));
    assertEquals((await t.media.describeAudio(path))!.audioBitrate, 64000);
    const aac = await t.f.get(
      t.route(t.song.id, '?format=aac&maxBitRate=64'),
      t.cookie,
    );
    await Deno.writeFile(path, new Uint8Array(await aac.arrayBuffer()));
    assertEquals((await t.media.probe(path)).audioCodec, 'aac');
    await t.register(t.cookie);
    const cap = await t.f.get(t.route(t.song.id, '?maxBitRate=64'), t.cookie);
    await Deno.writeFile(path, new Uint8Array(await cap.arrayBuffer()));
    assertEquals((await t.media.describeAudio(path))!.audioBitrate, 64000);
    const before = t.counts().started;
    const head = await t.f.request(t.route(t.song.id, '?format=mp3'), {
      method: 'HEAD',
      headers: { Authorization: `Bearer ${t.bearer}` },
    });
    assertEquals(head.status, 200);
    assertEquals(head.headers.get('accept-ranges'), 'none');
    assertEquals(head.headers.get('etag'), null);
    assertEquals(head.headers.get('content-length'), '0');
    assertEquals((await head.arrayBuffer()).byteLength, 0);
    assertEquals(t.counts().started, before);
  } finally {
    await t.close();
  }
});

Deno.test('API song stream: decoded offset landmark, transcode range semantics and EOF', async () => {
  const t = await setup(6);
  try {
    for (const credential of [t.cookie, t.bearer]) {
      const r = await t.f.get(
        t.route(t.song.id, '?offset=2&format=mp3'),
        credential,
        { Range: 'bytes=10-20' },
      );
      assertEquals(r.status, 200);
      assertEquals(r.headers.get('accept-ranges'), 'none');
      assertEquals(r.headers.get('etag'), null);
      assertEquals(r.headers.get('content-length'), null);
      assertEquals(r.headers.get('x-content-duration'), '6');
      await decoded(t, r, 'mp3', 2);
    }
    const before = t.counts().started;
    for (const offset of [6, 7]) {
      const r = await t.f.get(
        t.route(t.song.id, `?offset=${offset}`),
        t.cookie,
      );
      assertEquals(r.status, 200);
      assertEquals(r.headers.get('content-length'), '0');
      assertEquals((await r.arrayBuffer()).byteLength, 0);
    }
    assertEquals(t.counts().started, before);
    await t.register(t.cookie);
    const original = await t.f.get(t.route(t.song.id, '?offset=7'), t.cookie);
    assertEquals(
      new Uint8Array(await original.arrayBuffer()),
      await Deno.readFile(t.song.path),
    );
  } finally {
    await t.close();
  }
});

Deno.test('API song stream: native errors reject invalid/auth/unsupported requests before encoding', async () => {
  const t = await setup();
  try {
    await error(await t.f.get(t.route()), 401, 'unauthenticated');
    await error(await t.f.get(t.route('unknown'), t.cookie), 404, 'not_found');
    for (
      const query of [
        '?format=raw',
        '?format=MP3',
        '?format=',
        '?offset=-1',
        '?offset=1.5',
        '?offset=Infinity',
        '?offset=9007199254740992',
        '?maxBitRate=0',
        '?maxBitRate=NaN',
        '?maxBitRate=',
        '?offset=1&offset=2',
        '?abilities={}',
        '?unknown=1',
      ]
    ) {
      await error(
        await t.f.get(t.route(t.song.id, query), t.cookie),
        400,
        'invalid_field',
      );
    }
    await t.register(t.cookie, {
      name: 'Unsupported',
      platform: 'HTTP',
      transcodingProfiles: [{
        container: 'unknown',
        audioCodec: 'unknown',
        protocol: 'http',
      }],
    });
    await error(await t.f.get(t.route(), t.cookie), 422, 'incompatible_media');
    // Explicit format replaces an incompatible declaration, not its persistence.
    const explicit = await t.f.get(t.route(t.song.id, '?format=mp3'), t.cookie);
    assertEquals(explicit.status, 200);
    await explicit.arrayBuffer();
    await error(await t.f.get(t.route(), t.cookie), 422, 'incompatible_media');
    await waitFor(() => t.counts().active === 0);
    const before = t.counts().started;
    t.noEncoders();
    await error(await t.f.get(t.route(), t.bearer), 422, 'incompatible_media');
    await error(
      await t.f.get(t.route(t.song.id, '?format=aac'), t.cookie),
      422,
      'incompatible_media',
    );
    assertEquals(t.counts().started, before);
    const login = await t.f.auth.sessions.authenticate(t.bearer);
    await t.f.auth.sessions.revoke(t.f.admin.id, login!.sessionId);
    await error(await t.f.get(t.route(), t.bearer), 401, 'unauthenticated');
    await error(
      await t.f.get(t.route(), t.cookie, { Authorization: 'Bearer invalid' }),
      401,
      'unauthenticated',
    );
  } finally {
    await t.close();
  }
});

Deno.test('API song stream: read/HEAD/range/EOF/abort preserve playback, listens and household events', async () => {
  const t = await setup(120);
  let ws: WebSocket | undefined;
  try {
    const frames: { type: string; events?: Record<string, string[]> }[] = [];
    ws = new WebSocket(t.f.origin.replace('http:', 'ws:') + '/api/v1/events', {
      headers: { Origin: t.f.origin, Cookie: t.cookie },
    });
    ws.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
    await waitFor(() => frames.some((frame) => frame.type === 'hello'));
    for (const reported of [false, true]) {
      if (reported) {
        const report = await t.f.json('/api/v1/me/playback', 'POST', {
          songId: t.song.id,
          run: 1,
          sequence: 0,
          state: 'paused',
          positionMs: 1000,
        }, t.cookie);
        assertEquals(report.status, 200);
        await report.body?.cancel();
        await waitFor(() => frames.some((frame) => frame.events?.nowPlaying));
      }
      const before =
        (await (await t.f.get('/api/v1/now-playing', t.cookie)).json())
          .nowPlaying;
      frames.length = 0;
      await t.register(t.cookie);
      const range = await t.f.get(t.route(), t.cookie, { Range: 'bytes=0-31' });
      assertEquals(range.status, 206);
      await range.arrayBuffer();
      const eof = await t.f.get(
        t.route(t.song.id, '?format=mp3&offset=120'),
        t.cookie,
      );
      await eof.arrayBuffer();
      const head = await t.f.request(t.route(t.song.id, '?format=mp3'), {
        method: 'HEAD',
        headers: { Cookie: t.cookie },
      });
      await head.arrayBuffer();
      const controller = new AbortController();
      const response = await fetch(
        t.f.origin + t.route(t.song.id, '?format=opus'),
        {
          headers: { Authorization: `Bearer ${t.bearer}` },
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(5000),
          ]),
        },
      );
      const reader = response.body!.getReader();
      assert(!(await reader.read()).done);
      controller.abort();
      await reader.cancel().catch(() => {});
      await waitFor(() => t.counts().active === 0);
      // Barrier drains queued real socket frames after all media operations.
      const marker = String(reported);
      t.f.notify.emit(['library'], { library: [marker] }, 'all');
      await waitFor(() =>
        frames.some((frame) => frame.events?.library?.includes(marker))
      );
      assertEquals(
        frames.flatMap((frame) => Object.keys(frame.events ?? {})).filter((
          name,
        ) => name !== 'library'),
        [],
      );
      assertEquals(
        (await (await t.f.get('/api/v1/now-playing', t.bearer)).json())
          .nowPlaying,
        before,
      );
      assertEquals(
        (await createListens(t.f.store).facts('admin', { songs: [t.song.id] }))
          .songs[t.song.id].playCount,
        0,
      );
    }
  } finally {
    if (ws) {
      ws.close();
      await waitFor(() => ws!.readyState === WebSocket.CLOSED);
    }
    await t.close();
  }
});
