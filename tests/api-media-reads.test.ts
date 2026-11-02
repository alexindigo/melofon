import { assert, assertEquals } from '@std/assert';
import { apiFixture } from './helpers/api.ts';
import { restored } from './helpers/prepared.ts';
import { openStore } from '../src/store/index.ts';
import { seedFirstUser } from '../src/users.ts';
import { createLibraries } from '../src/libraries.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibrary } from '../src/library.ts';
import { createListens } from '../src/listens.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createUserService } from '../src/user.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createPlayer } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';
import { createStream } from '../src/stream.ts';
import { createFileSource } from '../src/file-source.ts';
import { createMedia } from '../src/media.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert(Date.now() < deadline, 'media observer timeout');
    await sleep(10);
  }
}

async function setup() {
  const dir = await restored('api-media-reads', async (dir) => {
    const store = await openStore(dir);
    try {
      await seedFirstUser(store, {
        listen: undefined,
        dataDir: dir,
        user: 'admin',
        password: 'password-admin',
        secret: 'test-secret',
      });
      await createLibraries(store).add(
        'Music',
        await Deno.realPath('tests/fixtures/library'),
      );
      await scanLibrary(store);
    } finally {
      await store.close();
    }
  }, 'melofon-api-media-');
  const f = await apiFixture({
    storeDir: dir,
    allLayers: true,
    services: (f) => {
      const library = createLibrary(f.store);
      const listens = createListens(f.store);
      const media = createMedia();
      const playback = createPlayback({
        library,
        player: createPlayer(),
        cfg: f.cfg,
        notify: f.notify,
        nowPlaying: createNowPlaying(f.store, { state: f.state, listens }),
      });
      return Promise.resolve({
        library,
        listens,
        media,
        playback,
        annotation: createAnnotation(f.store),
        user: createUserService(f.store, f.cfg),
        stream: createStream(
          media,
          f.cfg,
          undefined,
          createFileSource(library),
        ),
      });
    },
  });
  const rest = (op: string, extra: Record<string, string> = {}) =>
    `/rest/${op}?${new URLSearchParams({
      u: 'admin',
      p: 'password-admin',
      c: 'media-reader',
      v: '1.16.1',
      f: 'json',
      ...extra,
    })}`;
  async function call(op: string, extra: Record<string, string> = {}) {
    const response = await f.get(rest(op, extra));
    assertEquals(response.status, 200);
    const body = (await response.json())['subsonic-response'];
    assertEquals(body.status, 'ok');
    return body;
  }
  const songs = (await call('search3', { query: '' })).searchResult3.song as {
    id: string;
    isVideo: boolean;
  }[];
  const song =
    (await createLibrary(f.store).getSong(songs.find((s) => !s.isVideo)!.id))!;
  const video = songs.find((s) => s.isVideo)!;
  const original = await Deno.readFile(song.path);
  const login = await f.login('bearer');
  const ws = new WebSocket(
    f.origin.replace('http:', 'ws:') + '/api/v1/events',
    {
      headers: {
        Authorization: `Bearer ${login.credential}`,
        Origin: f.origin,
      },
    },
  );
  const frames: { type: string; events?: Record<string, string[]> }[] = [];
  ws.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
  await waitFor(() => frames.some((f) => f.type === 'hello'));
  frames.length = 0;
  let marker = 0;
  // A trailing marker drains the real socket after the operation. It is a
  // negative-observation barrier, never evidence of a playback mutation.
  async function barrier() {
    const id = String(++marker);
    f.notify.emit(['library'], { library: [id] }, 'all');
    await waitFor(() =>
      frames.some((frame) => frame.events?.library?.includes(id))
    );
  }
  return {
    f,
    rest,
    call,
    song,
    video,
    original,
    frames,
    barrier,
    async close() {
      ws.close();
      await waitFor(() => ws.readyState === WebSocket.CLOSED);
      await f.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

for (const reported of [false, true]) {
  Deno.test(`media reads: ${reported ? 'preserve explicit playback' : 'do not create playback'} over HTTP and native events`, async () => {
    const t = await setup();
    try {
      const addresses = await Deno.resolveDns('melofon.home', 'A');
      assert(
        addresses.length > 0 && addresses.every((ip) => !ip.startsWith('127.')),
      );
      if (reported) {
        await t.call('reportPlayback', {
          mediaId: t.song.id,
          mediaType: 'song',
          positionMs: '123',
          state: 'paused',
        });
        await t.barrier();
        assert(
          t.frames.some((frame) => frame.events?.player),
          'explicit report reaches native observer',
        );
      }
      const before = (await t.call('getNowPlaying')).nowPlaying.entry;
      assertEquals(before.length, reported ? 1 : 0);
      if (reported) {
        assertEquals(before[0].id, t.song.id);
        assertEquals(before[0].state, 'paused');
        assertEquals(before[0].positionMs, Math.min(123, t.song.durationMs!));
      }
      t.frames.length = 0;
      const unchanged = async () => {
        await t.barrier();
        assertEquals((await t.call('getNowPlaying')).nowPlaying.entry, before);
        const facts = await createListens(t.f.store).facts('admin', {
          songs: [t.song.id, t.video.id],
        });
        assertEquals(facts.songs[t.song.id].playCount, 0);
        assertEquals(facts.songs[t.video.id].playCount, 0);
        assertEquals(
          t.frames.flatMap((frame) => Object.keys(frame.events ?? {})).filter((
            name,
          ) => name !== 'library'),
          [],
        );
        t.frames.length = 0;
      };
      for (const op of ['stream', 'download']) {
        const path = t.rest(op, { id: t.song.id, format: 'raw' });
        const response = await t.f.get(path);
        assertEquals(response.status, 200);
        assertEquals(new Uint8Array(await response.arrayBuffer()), t.original);
        await unchanged();
        const head = await t.f.request(path, { method: 'HEAD' });
        assertEquals(head.status, 200);
        assertEquals((await head.arrayBuffer()).byteLength, 0);
        await unchanged();
        for (const start of [0, 32, 0]) {
          const range = await t.f.get(path, undefined, {
            Range: `bytes=${start}-${start + 31}`,
          });
          assertEquals(range.status, 206);
          assertEquals(
            new Uint8Array(await range.arrayBuffer()),
            t.original.slice(start, start + 32),
          );
          await unchanged();
        }
      }
      for (const direct of [true, false]) {
        const decision = await t.f.request(
          t.rest('getTranscodeDecision', {
            mediaId: t.song.id,
            mediaType: 'song',
          }),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: 'Media reader',
              platform: 'test',
              directPlayProfiles: direct
                ? [{ containers: [], audioCodecs: [], protocols: ['http'] }]
                : [],
              transcodingProfiles: [{
                container: 'mp3',
                audioCodec: 'mp3',
                protocol: 'http',
              }],
            }),
          },
        );
        const d =
          (await decision.json())['subsonic-response'].transcodeDecision;
        assertEquals(d.canDirectPlay, direct);
        assertEquals(d.canTranscode, !direct);
        const path = t.rest('getTranscodeStream', {
          mediaId: t.song.id,
          mediaType: 'song',
          transcodeParams: d.transcodeParams,
        });
        const response = await t.f.get(path);
        assertEquals(response.status, 200);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (direct) assertEquals(bytes, t.original);
        else assert(bytes.length > 0);
        await unchanged();
        if (direct) {
          for (const start of [0, 32, 0]) {
            const range = await t.f.get(path, undefined, {
              Range: `bytes=${start}-${start + 31}`,
            });
            assertEquals(range.status, 206);
            assertEquals(
              new Uint8Array(await range.arrayBuffer()),
              t.original.slice(start, start + 32),
            );
            await unchanged();
          }
        }
        const head = await t.f.request(path, { method: 'HEAD' });
        assertEquals(head.status, 200);
        assertEquals((await head.arrayBuffer()).byteLength, 0);
        await unchanged();
        const controller = new AbortController();
        const cancelled = await fetch(t.f.origin + path, {
          signal: controller.signal,
        });
        assertEquals(cancelled.status, 200);
        await cancelled.body!.cancel();
        controller.abort();
        await unchanged();
      }
      const controller = new AbortController();
      const cancelled = await fetch(
        t.f.origin +
          t.rest('stream', { id: t.song.id, format: 'mp3', maxBitRate: '64' }),
        { signal: controller.signal },
      );
      assertEquals(cancelled.status, 200);
      await cancelled.body!.cancel();
      controller.abort();
      await unchanged();
      const playlist = await t.f.get(t.rest('hls.m3u8', { id: t.video.id }));
      assertEquals(playlist.status, 200);
      const text = await playlist.text();
      assert(text.startsWith('#EXTM3U'));
      for (
        const line of text.split('\n').filter((line) =>
          line && !line.startsWith('#')
        )
      ) {
        const segment = await fetch(new URL(line, playlist.url));
        assertEquals(segment.status, 200);
        assert((await segment.arrayBuffer()).byteLength > 0);
      }
      await unchanged();
      // A real report after all reads is the positive control for this socket
      // and the core report path; no synthetic emit proves that feature.
      await t.call('scrobble', { id: t.song.id, submission: 'false' });
      await t.barrier();
      assert(t.frames.some((frame) => frame.events?.player));
      assertEquals(
        (await t.call('getNowPlaying')).nowPlaying.entry[0].state,
        'playing',
      );
    } finally {
      await t.close();
    }
  });
}
