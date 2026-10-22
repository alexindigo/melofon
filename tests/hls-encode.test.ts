import { assert, assertEquals, assertMatch } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { Buffer } from 'node:buffer';
import { AV_CODEC_ID_AAC, AV_CODEC_ID_H264, Decoder, Demuxer } from 'node-av';
import { openStore } from '../src/store/index.ts';
import { seedFirstUser } from '../src/users.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createMedia } from '../src/media.ts';
import { createUserService } from '../src/user.ts';
import { createState } from '../src/state.ts';
import { loadLayers } from '../src/layers.ts';
import { facade } from '../src/facade.ts';
import { videoFixture } from './helpers/video-fixture.ts';

const CLIP =
  'tests/fixtures/library/Fixture Artist/Fixture Album/03 - Clip.mp4';
const SONG =
  'tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3';

Deno.test('HLS HTTP consumers receive encoded rungs, selected audio, actual timing and protected bounded cache', async (t) => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-hls-encode-' });
  await Deno.mkdir(`${dir}/music`);
  const codec = await videoFixture(`${dir}/music/hevc.mkv`);
  assert(['hevc', 'mpeg4'].includes(codec));
  await videoFixture(`${dir}/music/keyframes.mkv`, 320, 180, 2, 25, 'h264');
  await Deno.copyFile(CLIP, `${dir}/music/copy.mp4`);
  await Deno.copyFile(SONG, `${dir}/music/song.mp3`);
  const store = await openStore(`${dir}/db`);
  const cfg = {
    listen: undefined,
    dataDir: dir,
    user: 'admin',
    password: 'test',
    secret: 'hls-secret',
    version: 'test',
  };
  await seedFirstUser(store, cfg);
  const state = createState(store), media = createMedia(undefined, state);
  await state.set('media.hls.segmentSeconds', '1');
  await state.set('media.hls.preset', 'ultrafast');
  const libraries = createLibraries(store);
  await libraries.add('Video', `${dir}/music`);
  await scanLibrary(store);
  const library = createLibrary(store);
  const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
  const app = facade(
    core,
    await loadLayers({
      app: {
        cfg,
        state,
        media,
        library,
        libraries,
        user: createUserService(store, cfg),
      },
    }),
  );
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    app,
  );
  const origin = `http://127.0.0.1:${server.addr.port}`;
  const auth = 'u=admin&p=test&v=1.16.1&c=hls-test';
  const videos = await library.videos();
  const id = videos.find((v) => v.path.endsWith('hevc.mkv'))!.id;
  const copyId = videos.find((v) => v.path.endsWith('copy.mp4'))!.id;
  const request = (query: string, post = false) =>
    post
      ? fetch(`${origin}/rest/hls.m3u8`, {
        method: 'POST',
        body: new URLSearchParams(`${query}&${auth}`),
      })
      : fetch(`${origin}/rest/hls.m3u8?${query}&${auth}`);
  const complete = async (query: string) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const response = await request(query);
      assertEquals(response.status, 200);
      assertEquals(
        response.headers.get('content-type'),
        'application/vnd.apple.mpegurl',
      );
      const text = await response.text();
      if (text.includes('#EXT-X-ENDLIST')) return text;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('HLS did not finish');
  };
  const paths = async () => {
    const names = [];
    for await (const entry of Deno.readDir(`${dir}/hls`)) {
      if (entry.isDirectory) names.push(entry.name);
    }
    return names.sort();
  };
  async function consume(
    text: string,
    width: number,
    height: number,
    channels: number,
    minimumSegments = 2,
  ) {
    let duration = 0, videoBytes = 0, decodedFrames = 0;
    const urls = text.split('\n').filter((line) =>
      line.startsWith('/rest/hls/')
    );
    assert(urls.length >= minimumSegments);
    for (const url of urls) {
      const response = await fetch(`${origin}${url}`);
      assertEquals(response.status, 200);
      assertEquals(response.headers.get('content-type'), 'video/MP2T');
      const bytes = new Uint8Array(await response.arrayBuffer());
      assertEquals(bytes[0], 0x47);
      await using input = await Demuxer.open(Buffer.from(bytes));
      const video = input.video()!, audio = input.audio()!;
      assertEquals(video.codecpar.codecId, AV_CODEC_ID_H264);
      assertEquals(audio.codecpar.codecId, AV_CODEC_ID_AAC);
      assertEquals([video.codecpar.width, video.codecpar.height], [
        width,
        height,
      ]);
      assertEquals(audio.codecpar.channelLayout.nbChannels, channels);
      // Decoder consumption proves playable frames, beyond codec labels/TS sync.
      using decoder = await Decoder.create(video);
      for await (const packet of input.packets()) {
        if (!packet) continue;
        try {
          if (packet.streamIndex !== video.index) continue;
          videoBytes += packet.data?.length ?? 0;
          for (const frame of await decoder.decodeAll(packet)) {
            decodedFrames++;
            frame.free();
          }
        } finally {
          packet.free();
        }
      }
      for (const frame of await decoder.decodeAll(null)) {
        decodedFrames++;
        frame.free();
      }
      duration += parseFloat(
        new URL(`${origin}${url}`).searchParams.get('duration')!,
      );
    }
    assert(Math.abs(duration - 2) <= 0.12, `muxed duration ${duration}`);
    assertEquals(decodedFrames, 50);
    return { duration, bitrate: videoBytes * 8 / duration };
  }
  try {
    await t.step(
      'HEVC yields H.264/AAC; concurrent requests share one output; rungs are real',
      async () => {
        const query = `id=${id}&bitRate=100@160x90`;
        const responses = await Promise.all([
          request(query),
          request(query),
          request(query, true),
        ]);
        const initial = await Promise.all(responses.map((r) => r.text()));
        assert(initial.every((text) => text.startsWith('#EXTM3U')));
        assert(
          initial.some((text) =>
            text.includes('#EXT-X-PLAYLIST-TYPE:EVENT') &&
            !text.includes('#EXT-X-ENDLIST')
          ),
          'first segments publish before encode completion',
        );
        const low = await complete(query);
        assertEquals((await paths()).length, 1);
        const lowStats = await consume(low, 160, 90, 1);
        const high = await complete(`id=${id}&bitRate=400@320x180`);
        const highStats = await consume(high, 320, 180, 1);
        assert(
          highStats.bitrate > lowStats.bitrate * 2,
          JSON.stringify({ lowStats, highStats }),
        );
        assert(
          lowStats.bitrate >= 80000 && lowStats.bitrate < 160000,
          String(lowStats.bitrate),
        );
        assert(
          highStats.bitrate >= 300000 && highStats.bitrate < 600000,
          String(highStats.bitrate),
        );
        const variant = await (await request(
          `id=${id}&bitRate=100@160x90&bitRate=400@320x180&audioTrack=2`,
        )).text();
        const lines = variant.split('\n');
        assert(
          lines.some((l) =>
            /^#EXT-X-STREAM-INF:.*BANDWIDTH=\d+,RESOLUTION=160x90$/.test(l)
          ),
        );
        assert(
          lines.some((l) =>
            /^#EXT-X-STREAM-INF:.*BANDWIDTH=\d+,RESOLUTION=320x180$/.test(l)
          ),
        );
        for (
          const url of lines.filter((l) => l.startsWith('/rest/hls.m3u8?'))
        ) {
          assertEquals(
            new URL(`${origin}${url}`).searchParams.get('audioTrack'),
            '2',
          );
        }
        await complete(`id=${id}&bitRate=100@160x90&audioTrack=2`);
        await complete(`id=${id}&bitRate=400@320x180&audioTrack=2`);
      },
    );
    await t.step(
      'v1 audio IDs select second stereo stream and bitrate-only preserves aspect',
      async () => {
        const info = await (await fetch(
          `${origin}/rest/getVideoInfo?id=${id}&${auth}&f=json`,
        )).json();
        assertEquals(
          info['subsonic-response'].videoInfo.audioTrack.map((
            a: { id: string },
          ) => a.id),
          ['1', '2'],
        );
        const text = await complete(`id=${id}&bitRate=100@160x90&audioTrack=2`);
        await consume(text, 160, 90, 2);
        await state.set('media.hls.ladder', '100@160x90');
        const aspect = await complete(`id=${id}&bitRate=100`);
        await consume(aspect, 160, 90, 1);
        await state.set(
          'media.hls.ladder',
          '500@426x240,1000@640x360,2000@854x480,4000@1280x720,8000@1920x1080',
        );
        // Compatible source remains remuxable, with its real native durations.
        const copied = await complete(`id=${copyId}`);
        assert(copied.includes('#EXT-X-ENDLIST'));
        for (
          const url of copied.split('\n').filter((l) =>
            l.startsWith('/rest/hls/')
          )
        ) {
          const response = await fetch(`${origin}${url}`);
          assertEquals(response.status, 200);
          await response.arrayBuffer();
        }
      },
    );
    await t.step(
      'seconds setting controls native segment duration across source keyframes',
      async () => {
        const keyframes = videos.find((v) =>
          v.path.endsWith('keyframes.mkv')
        )!.id;
        await state.set('media.hls.segmentSeconds', '3');
        const text = await complete(`id=${keyframes}`);
        assertEquals(
          text.split('\n').filter((l) => l.startsWith('#EXTINF:')).length,
          1,
        );
        await consume(text, 320, 180, 1, 1);
        await state.set('media.hls.segmentSeconds', '1');
      },
    );
    await t.step(
      'cache persists, invalidates settings, evicts oldest and pins open reads',
      async () => {
        await state.set('media.hlsCacheMegabytes', '2048');
        const query = `id=${id}&bitRate=100@160x90`;
        const text = await complete(query);
        const before = await paths();
        await complete(query);
        assertEquals(await paths(), before);
        // Another media instance reuses completed persisted output, not dev state.
        const reopened = createMedia(undefined, state);
        const lease = await reopened.hls(
          `${dir}/music/hevc.mkv`,
          `${dir}/hls`,
          { kbps: 100, width: 160, height: 90 },
        );
        assert(lease?.complete);
        await lease?.release();
        assertEquals(await paths(), before);
        // An actual finite budget preserves the most recently used output.
        await state.set('media.hlsCacheMegabytes', '0');
        const clear = await media.hls(`${dir}/music/copy.mp4`, `${dir}/hls`);
        assert(clear);
        await clear.release();
        assertEquals(await paths(), []);
        await state.set('media.hlsCacheMegabytes', '2048');
        await complete(query);
        const first = (await paths())[0];
        await complete(`id=${id}&bitRate=400@320x180`);
        const second = (await paths()).find((path) => path !== first)!;
        await new Promise((r) => setTimeout(r, 5));
        await complete(query); // first is now the newest
        async function size(name: string) {
          let total = 0;
          for await (const file of Deno.readDir(`${dir}/hls/${name}`)) {
            total += (await Deno.stat(`${dir}/hls/${name}/${file.name}`)).size;
          }
          return total;
        }
        const budget = Math.max(await size(first), await size(second)) + 1;
        await state.set(
          'media.hlsCacheMegabytes',
          String(budget / 1024 / 1024),
        );
        await complete(query);
        assertEquals(await paths(), [first], 'oldest output evicted first');
        await state.set('media.hlsCacheMegabytes', '2048');
        // Keep the cache lease open until consumer EOF/cancel. Use the production
        // facade Response directly so network buffering cannot drain it for us.
        const url = text.split('\n').find((l) => l.startsWith('/rest/hls/'))!;
        const held = await app(new Request(`${origin}${url}`));
        assertEquals(held.status, 200);
        await state.set('media.hlsCacheMegabytes', '0');
        const other = await media.hls(`${dir}/music/copy.mp4`, `${dir}/hls`);
        assert(other);
        await other.release();
        assertEquals(
          (await paths()).length,
          1,
          'only served output is pinned above zero budget',
        );
        const bytes = new Uint8Array(await held.arrayBuffer());
        assertEquals(bytes[0], 0x47);
        assertEquals(
          await paths(),
          [],
          'EOF releases final output for eviction',
        );
        // Streaming cancellation also releases, including after caller release.
        const view = await media.hls(`${dir}/music/copy.mp4`, `${dir}/hls`);
        assert(view);
        const stream = await view.segment(0);
        assert(stream);
        await view.release();
        assertEquals((await paths()).length, 1);
        await stream.cancel();
        assertEquals(await paths(), []);
        await state.set('media.hlsCacheMegabytes', '2048');
      },
    );
    await t.step(
      'not-video/unknown IDs, bad requests and native preparation errors',
      async () => {
        const songs = await library.search3('', {
          artistCount: 0,
          artistOffset: 0,
          albumCount: 0,
          albumOffset: 0,
          songCount: 100,
          songOffset: 0,
        });
        const song = songs.songs.find((s) => !s.isVideo)!;
        for (const target of ['unknown', song.id]) {
          for (const op of ['hls.m3u8', 'hls/segment.ts']) {
            const response = await fetch(
              `${origin}/rest/${op}?id=${target}&segmentIndex=0&${auth}&f=json`,
            );
            assertEquals(
              (await response.json())['subsonic-response'].error.code,
              70,
            );
          }
        }
        for (
          const suffix of [
            'bitRate=bad',
            'bitRate=0',
            'bitRate=100@0x0',
            'bitRate=100@161x90',
            'audioTrack=1.5',
          ]
        ) {
          const response = await request(`id=${id}&${suffix}&f=json`);
          assertEquals(
            (await response.json())['subsonic-response'].error.code,
            10,
          );
        }
        await Deno.writeTextFile(`${dir}/music/hevc.mkv`, 'broken source');
        const response = await request(`id=${id}&bitRate=123&f=json`);
        assertMatch(response.headers.get('content-type')!, /^text\/xml/);
        assertMatch(await response.text(), /status="failed".*error code="0"/s);
      },
    );
  } finally {
    await server.shutdown();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
