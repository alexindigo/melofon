import { assert, assertEquals } from '@std/assert';
import { Buffer } from 'node:buffer';
import { AV_CODEC_ID_AAC, AV_CODEC_ID_H264, Decoder, Demuxer } from 'node-av';
import { pathfinder } from '@pathfinder/pathfinder';
import { apiFixture, error } from './helpers/api.ts';
import { authFixture } from './helpers/authentication.ts';
import { restored } from './helpers/prepared.ts';
import { videoFixture } from './helpers/video-fixture.ts';
import { createLibraries } from '../src/libraries.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibrary } from '../src/library.ts';
import { createMedia } from '../src/media.ts';
import { findHats, loadHat } from '../src/layers.ts';
import { facade } from '../src/facade.ts';
import { createPublicAddress } from '../src/public-address.ts';

function uris(text: string) {
  return text.split('\n').filter((line) =>
    line.length && !line.startsWith('#')
  );
}

async function setup() {
  const dir = await restored('api-hls', async (dir) => {
    const f = await authFixture(undefined, dir);
    try {
      await createLibraries(f.store).add(
        'Music',
        await Deno.realPath('tests/fixtures/library'),
      );
      await scanLibrary(f.store);
      await f.auth.users.create(f.admin.id, {
        username: 'listener',
        password: 'password-listener',
        role: 'user',
      });
    } finally {
      await f.close();
    }
  }, 'melofon-api-hls-');
  let media!: ReturnType<typeof createMedia>;
  let calls = 0, views = 0;
  const f = await apiFixture({
    storeDir: dir,
    services: (f) => {
      media = createMedia(undefined, f.state);
      const hls = media.hls.bind(media);
      const renditions = media.hlsRenditions.bind(media);
      const observe = (view: Awaited<ReturnType<typeof hls>>) => {
        if (!view) return null;
        views++;
        let released = false;
        return {
          ...view,
          async release() {
            await view.release();
            if (!released) {
              views--;
              released = true;
            }
          },
        };
      };
      media.hls = async (...args) => {
        calls++;
        return observe(await hls(...args));
      };
      media.hlsRenditions = async (...args) => {
        calls++;
        return (await renditions(...args))?.map((view) => observe(view)!) ??
          null;
      };
      return Promise.resolve({ library: createLibrary(f.store), media });
    },
  });
  await f.state.set('media.hls.segmentSeconds', '1');
  await f.state.set('media.hls.preset', 'ultrafast');
  assert(
    (await Deno.resolveDns('melofon.home', 'A')).every((ip) =>
      !ip.startsWith('127.')
    ),
  );
  const library = createLibrary(f.store);
  const songs = await library.listSongs({ size: 100, offset: 0 });
  const video = songs.find((song) => song.isVideo)!;
  const song = songs.find((song) => !song.isVideo)!;
  const cookie =
    (await f.login('cookie', 'listener', 'password-listener')).credential;
  const bearer =
    (await f.login('bearer', 'listener', 'password-listener')).credential;
  const route = (id = video.id) => `/api/v1/videos/${id}/hls.m3u8`;
  const read = (url: URL, credential: string) =>
    f.get(url.pathname + url.search, credential);
  async function playlist(url: URL, credential: string) {
    const response = await read(url, credential);
    assertEquals(response.status, 200, await response.clone().text());
    assertEquals(
      response.headers.get('content-type'),
      'application/vnd.apple.mpegurl',
    );
    assertEquals(response.headers.get('cache-control'), 'no-store');
    return response.text();
  }
  async function complete(url: URL, credential: string, initial?: string) {
    let text = initial ?? await playlist(url, credential);
    const first = uris(text);
    const deadline = Date.now() + 10000;
    while (!text.includes('#EXT-X-ENDLIST')) {
      assert(Date.now() < deadline, 'HLS completed within deadline');
      assert(text.includes('#EXT-X-PLAYLIST-TYPE:EVENT'));
      await new Promise((resolve) => setTimeout(resolve, 10));
      text = await playlist(url, credential);
    }
    assert(text.includes('#EXT-X-PLAYLIST-TYPE:VOD'));
    assertEquals(
      uris(text).slice(0, first.length),
      first,
      'EVENT prefix retained',
    );
    return text;
  }
  function resolve(uri: string, parent: URL) {
    assert(!uri.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(uri));
    const child = new URL(uri, parent);
    assertEquals(child.origin, parent.origin);
    assert(
      child.pathname.startsWith(
        parent.pathname.slice(0, parent.pathname.lastIndexOf('/') + 1),
      ),
    );
    assert(
      [...child.searchParams.keys()].every((key) =>
        ['bitRate', 'size', 'audioTrack'].includes(key)
      ),
    );
    assert(!uri.includes(cookie) && !uri.includes(bearer));
    return child;
  }
  return {
    f,
    dir,
    library,
    media,
    video,
    song,
    cookie,
    bearer,
    route,
    read,
    playlist,
    complete,
    resolve,
    counts: () => ({ calls, views }),
    async close() {
      assertEquals(views, 0);
      await f.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

/** Decode the exact HTTP segment bytes, not an independently opened source. */
async function consume(
  t: Awaited<ReturnType<typeof setup>>,
  parent: URL,
  text: string,
  credential: string,
  dimensions: number[],
  decode: boolean,
) {
  const durations = text.split('\n').filter((line) =>
    line.startsWith('#EXTINF:')
  ).map((line) => Number(line.slice(8).replace(',', '')));
  const links = uris(text);
  assertEquals(links.length, durations.length);
  assert(links.length > 0);
  assert(
    text.includes(`#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...durations))}`),
  );
  let videoFrames = 0, audioSamples = 0, bandwidth = 0;
  const timestamps: number[] = [];
  for (const [index, uri] of links.entries()) {
    const url = t.resolve(uri, parent);
    assertEquals(
      url.pathname,
      parent.pathname.replace('hls.m3u8', `hls/segments/${index}.ts`),
    );
    const response = await t.read(url, credential);
    assertEquals(response.status, 200);
    assertEquals(response.headers.get('content-type'), 'video/MP2T');
    const bytes = new Uint8Array(await response.arrayBuffer());
    bandwidth = Math.max(
      bandwidth,
      Math.ceil(bytes.length * 8 / durations[index]),
    );
    if (!decode) continue;
    await using input = await Demuxer.open(Buffer.from(bytes));
    const video = input.video()!, audio = input.audio()!;
    assertEquals(video.codecpar.codecId, AV_CODEC_ID_H264);
    assertEquals(audio.codecpar.codecId, AV_CODEC_ID_AAC);
    assertEquals([video.codecpar.width, video.codecpar.height], dimensions);
    using vd = await Decoder.create(video);
    using ad = await Decoder.create(audio);
    const frames = (
      decoded: Awaited<ReturnType<Decoder['decodeAll']>>,
      isVideo: boolean,
    ) => {
      for (const frame of decoded) {
        if (isVideo) {
          videoFrames++;
          timestamps.push(
            Number(frame.pts) * frame.timeBase.num / frame.timeBase.den,
          );
        } else audioSamples += frame.nbSamples;
        frame.free();
      }
    };
    for await (const packet of input.packets()) {
      if (!packet) continue;
      try {
        if (packet.streamIndex === video.index) {
          frames(await vd.decodeAll(packet), true);
        }
        if (packet.streamIndex === audio.index) {
          frames(await ad.decodeAll(packet), false);
        }
      } finally {
        packet.free();
      }
    }
    frames(await vd.decodeAll(null), true);
    frames(await ad.decodeAll(null), false);
  }
  const duration = durations.reduce((a, b) => a + b, 0);
  assert(Math.abs(duration - 2) < 0.12, `actual duration ${duration}`);
  if (decode) {
    assertEquals(videoFrames, 50);
    assert(
      audioSamples >= 48000 * 1.9 && audioSamples <= 48000 * 2.2,
      String(audioSamples),
    );
    assert(
      Math.abs(timestamps.at(-1)! - timestamps[0] - 1.96) < 0.05,
      JSON.stringify(timestamps),
    );
  }
  return bandwidth;
}

Deno.test('API HLS: authenticated relative mount chains, real rungs, EVENT reload and decoded H.264/AAC timing', async () => {
  const t = await setup();
  const music = await Deno.makeTempDir();
  try {
    await videoFixture(`${music}/encode.mkv`);
    await createLibraries(t.f.store).add('Synthetic', music);
    await scanLibrary(t.f.store);
    const video = (await t.library.videos()).find((song) =>
      song.path.endsWith('encode.mkv')
    )!;
    let sawEvent = false;
    for (const prefix of ['', '/music']) {
      await t.f.state.set(
        'server.baseUrl',
        prefix ? `${t.f.origin}${prefix}` : '',
      );
      for (const forced of ['', '/_melofon']) {
        for (const credential of [t.cookie, t.bearer]) {
          const url = new URL(
            `${prefix}${forced}${t.route(video.id)}?bitRate=100@160x90`,
            t.f.origin,
          );
          const initial = await t.playlist(url, credential);
          sawEvent ||= initial.includes('#EXT-X-PLAYLIST-TYPE:EVENT');
          const single = await t.complete(url, credential, initial);
          await consume(
            t,
            url,
            single,
            credential,
            [160, 90],
            prefix === '' && forced === '',
          );
          url.search = '?bitRate=100@160x90&bitRate=400@320x180';
          let master = await t.playlist(url, credential);
          const variants = uris(master).map((uri) => t.resolve(uri, url));
          assertEquals(variants.length, 2);
          assert(!master.includes('#EXT-X-ENDLIST'));
          const bandwidths = [];
          for (const [index, variant] of variants.entries()) {
            assertEquals(variant.pathname, url.pathname);
            assertEquals(variant.searchParams.getAll('bitRate'), [
              index ? '400@320x180' : '100@160x90',
            ]);
            const text = await t.complete(variant, credential);
            bandwidths.push(
              await consume(
                t,
                variant,
                text,
                credential,
                index ? [320, 180] : [160, 90],
                prefix === '' && forced === '' && credential === t.cookie,
              ),
            );
          }
          master = await t.playlist(url, credential);
          assertEquals(
            master.split('\n').filter((line) =>
              line.startsWith('#EXT-X-STREAM-INF:')
            ),
            bandwidths.map((bandwidth, index) =>
              `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${
                index ? '320x180' : '160x90'
              }`
            ),
          );
        }
      }
    }
    assert(sawEvent, 'first native output publishes EVENT before VOD');
    assert(t.f.peers.every((peer) => peer !== '127.0.0.1' && peer !== '::1'));
  } finally {
    await t.close();
    await Deno.remove(music, { recursive: true });
  }
});

Deno.test('API HLS: every child authenticates, revocation and native validation precede media work', async () => {
  const t = await setup();
  try {
    for (const prefix of ['', '/music']) {
      await t.f.state.set(
        'server.baseUrl',
        prefix ? `${t.f.origin}${prefix}` : '',
      );
      for (const forced of ['', '/_melofon']) {
        const playlist = new URL(
          `${prefix}${forced}${t.route()}?bitRate=100@160x120&bitRate=200@160x120`,
          t.f.origin,
        );
        const master = await t.playlist(playlist, t.cookie);
        const variant = t.resolve(uris(master)[0], playlist);
        const text = await t.complete(variant, t.cookie);
        const segment = t.resolve(uris(text)[0], variant);
        for (const url of [playlist, variant, segment]) {
          await error(
            await t.f.get(url.pathname + url.search),
            401,
            'unauthenticated',
          );
          await error(
            await t.f.get(url.pathname + url.search, t.cookie, {
              Authorization: 'Bearer invalid',
            }),
            401,
            'unauthenticated',
          );
          const fresh = await t.f.login(
            'bearer',
            'listener',
            'password-listener',
          );
          await t.playlist(playlist, fresh.credential);
          const auth = await t.f.auth.sessions.authenticate(fresh.credential);
          await t.f.auth.sessions.revoke(auth!.user.id, auth!.sessionId);
          await error(
            await t.read(url, fresh.credential),
            401,
            'unauthenticated',
          );
        }
      }
    }
    await t.f.state.set('server.baseUrl', '');
    const track =
      (await t.library.getVideoSnapshot(t.video.id)).detail!.details!.audio[0]
        .index;
    const sized = new URL(
      `${t.route()}?size=160x120&audioTrack=${track}`,
      t.f.origin,
    );
    const sizedText = await t.complete(sized, t.cookie);
    const sizedSegment = t.resolve(uris(sizedText)[0], sized);
    assertEquals(sizedSegment.searchParams.get('size'), '160x120');
    assertEquals(sizedSegment.searchParams.get('audioTrack'), String(track));
    const sizedResponse = await t.read(sizedSegment, t.bearer);
    assertEquals(sizedResponse.status, 200);
    await sizedResponse.arrayBuffer();
    const before = t.counts().calls;
    for (const id of [t.song.id, 'missing']) {
      await error(await t.f.get(t.route(id), t.cookie), 404, 'not_found');
      await error(
        await t.f.get(
          t.route(id).replace('hls.m3u8', 'hls/segments/0.ts'),
          t.cookie,
        ),
        404,
        'not_found',
      );
    }
    for (
      const query of [
        'bitRate=',
        'bitRate=0',
        'bitRate=-1',
        'bitRate=1.2',
        'bitRate=9007199254740992',
        'bitRate=100@161x90',
        'size=1x2',
        'size=4x9007199254740992',
        'size=bad',
        'bitRate=100@160x90&size=160x90',
        'size=2x2&size=4x4',
        'audioTrack=-1',
        'audioTrack=0',
        'audioTrack=999',
        'audioTrack=1&audioTrack=2',
        'token=secret',
        'u=listener',
        'offset=1',
      ]
    ) {
      await error(
        await t.f.get(`${t.route()}?${query}`, t.cookie),
        400,
        'invalid_field',
      );
    }
    const segmentPath = t.route().replace('hls.m3u8', 'hls/segments/');
    for (const index of ['-1', '1.5', 'x', '9007199254740992']) {
      await error(
        await t.f.get(`${segmentPath}${index}.ts`, t.cookie),
        400,
        'invalid_field',
      );
    }
    await error(
      await t.f.get(`${segmentPath}0.ts?bitRate=100&bitRate=200`, t.cookie),
      400,
      'invalid_field',
    );
    assertEquals(t.counts().calls, before);
    await error(
      await t.f.get(`${segmentPath}999.ts`, t.bearer),
      404,
      'not_found',
    );
    // Missing source is a generic native preparation failure, never a path leak.
    const path = t.video.path;
    // Use an owned scanned file to exercise the real failure instead of a mock.
    const owned = await Deno.makeTempDir();
    try {
      await Deno.copyFile(path, `${owned}/lost.mp4`);
      await createLibraries(t.f.store).add('Lost', owned);
      await scanLibrary(t.f.store);
      const video = (await t.library.videos()).find((song) =>
        song.path.endsWith('/lost.mp4')
      )!;
      assert((await t.library.getVideoSnapshot(video.id)).detail);
      await Deno.remove(`${owned}/lost.mp4`);
      const failure = await error(
        await t.f.get(t.route(video.id), t.cookie),
        500,
        'internal_error',
      );
      assert(!JSON.stringify(failure).includes(owned));
    } finally {
      await Deno.remove(owned, { recursive: true });
    }
  } finally {
    await t.close();
  }
});

Deno.test('API HLS: shared bounded cache releases playlist views and segment EOF/cancel leases', async () => {
  const t = await setup();
  try {
    const url = new URL(t.route(), t.f.origin);
    const text = await t.complete(url, t.cookie);
    const segment = t.resolve(uris(text)[0], url);
    const paths = async () => {
      const names = [];
      for await (const entry of Deno.readDir(`${t.dir}/hls`)) {
        if (entry.isDirectory) names.push(entry.name);
      }
      return names.sort();
    };
    const original = await paths();
    await t.complete(url, t.bearer);
    assertEquals(await paths(), original, 'shared output across sessions');
    const received = await t.read(segment, t.bearer);
    await received.arrayBuffer();
    assertEquals(t.counts().views, 0);
    // Deno's HTTP buffer can eagerly drain tiny segments. Hold the actual
    // facade response here so EOF/cancel, rather than network speed, owns lease.
    const bag = {
      ...t.f.auth,
      cfg: t.f.cfg,
      state: t.f.state,
      library: t.library,
      media: t.media,
      publicAddress: createPublicAddress(t.f.state),
    };
    const found = (await findHats({ app: bag })).find((hat) =>
      hat.name === 'melofon'
    )!;
    const app = facade(
      await pathfinder({ roots: ['core/'], app: { ...bag, store: t.f.store } }),
      [await loadHat(found, bag)],
    );
    for (const cancel of [false, true]) {
      await t.f.state.set('media.hlsCacheMegabytes', '2048');
      await t.complete(url, t.cookie);
      const held = await app(
        new Request(segment, { headers: { Cookie: t.cookie } }),
      );
      assertEquals(held.status, 200);
      assertEquals(t.counts().views, 0, 'route already released its view');
      await t.f.state.set('media.hlsCacheMegabytes', '0');
      const other = await t.media.hls(t.video.path, `${t.dir}/hls`, {
        width: 158,
        height: 118,
      });
      assert(other);
      // Await VOD before pruning to avoid leaving the background encoder alive.
      await other.release();
      let last = other;
      while (!last.complete) {
        const next = await t.media.hls(t.video.path, `${t.dir}/hls`, {
          width: 158,
          height: 118,
        });
        assert(next);
        last = next;
        await next.release();
      }
      assertEquals(
        (await paths()).length,
        1,
        'only read lease pins original above budget',
      );
      if (cancel) await held.body!.cancel();
      else assert((await held.arrayBuffer()).byteLength > 0);
      assertEquals(await paths(), [], 'last read release permits eviction');
    }
  } finally {
    await t.close();
  }
});

Deno.test('API HLS: discovered stream indices select distinct decoded audio through master and segment links', async () => {
  const t = await setup();
  const music = await Deno.makeTempDir();
  try {
    await videoFixture(`${music}/choices.mkv`, 320, 180, 2, 25, 'h264');
    await createLibraries(t.f.store).add('Choices', music);
    await scanLibrary(t.f.store);
    const video = (await t.library.videos()).find((song) =>
      song.path.endsWith('choices.mkv')
    )!;
    await t.f.state.set('server.baseUrl', `${t.f.origin}/music`);
    const discovery = new URL(
      `/music/_melofon/api/v1/videos/${video.id}/playback`,
      t.f.origin,
    );
    const response = await t.read(discovery, t.cookie);
    assertEquals(response.status, 200);
    const playback = await response.json();
    assertEquals(
      playback.audioTracks.map((track: { index: number }) => track.index),
      [1, 2],
    );
    assertEquals(
      playback.audioTracks.map((track: { channels: number }) => track.channels),
      [1, 2],
    );
    for (const [ordinal, track] of playback.audioTracks.entries()) {
      for (const encode of [false, true]) {
        const parent = new URL(playback.hls, discovery);
        parent.searchParams.set('audioTrack', String(track.index));
        if (encode) {
          parent.searchParams.append('bitRate', '100@160x90');
          parent.searchParams.append('bitRate', '200@320x180');
        }
        const initial = await t.playlist(parent, t.cookie);
        const variant = encode ? t.resolve(uris(initial)[0], parent) : parent;
        assertEquals(
          variant.searchParams.get('audioTrack'),
          String(track.index),
        );
        const text = await t.complete(
          variant,
          t.bearer,
          encode ? undefined : initial,
        );
        let samples = 0;
        for (const uri of uris(text)) {
          const segment = t.resolve(uri, variant);
          assertEquals(
            segment.searchParams.get('audioTrack'),
            String(track.index),
          );
          const received = await t.read(segment, t.bearer);
          assertEquals(received.status, 200);
          await using input = await Demuxer.open(
            Buffer.from(await received.arrayBuffer()),
          );
          const audio = input.audio()!;
          assertEquals(audio.codecpar.codecId, AV_CODEC_ID_AAC);
          assertEquals(audio.codecpar.channelLayout.nbChannels, ordinal + 1);
          using decoder = await Decoder.create(audio);
          const consume = (
            frames: Awaited<ReturnType<Decoder['decodeAll']>>,
          ) => {
            for (const frame of frames) {
              assertEquals(frame.channelLayout.nbChannels, ordinal + 1);
              samples += frame.nbSamples;
              frame.free();
            }
          };
          for await (const packet of input.packets()) {
            if (!packet) continue;
            try {
              if (packet.streamIndex === audio.index) {
                consume(await decoder.decodeAll(packet));
              }
            } finally {
              packet.free();
            }
          }
          consume(await decoder.decodeAll(null));
        }
        assert(
          samples >= 48000 * 1.9 && samples <= 48000 * 2.2,
          String(samples),
        );
      }
    }
  } finally {
    await t.close();
    await Deno.remove(music, { recursive: true });
  }
});
