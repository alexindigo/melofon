import { assert, assertEquals } from '@std/assert';
import { Demuxer, Dictionary, Muxer } from 'node-av';
import { apiFixture, error } from './helpers/api.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createMedia } from '../src/media.ts';
import { scanLibrary } from '../src/scan.ts';

const clip =
  'tests/fixtures/library/Fixture Artist/Fixture Album/03 - Clip.mp4';
const song =
  'tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3';
const srt =
  '1\n00:00:00,125 --> 00:00:01,625\nSidecar <i>Hello</i>\nsecond line\n\n';
const vtt =
  'WEBVTT\n\ncue-id\n00:00.250 --> 00:01.750 align:start\nVTT text\n\n';

// Remux real demuxed text packets; no subtitle encoder or CLI is needed.
async function captionFixture(root: string) {
  await Deno.mkdir(`${root}/music`);
  await Deno.writeTextFile(
    `${root}/embedded.srt`,
    srt.replace('Sidecar <i>Hello</i>', 'Embedded text'),
  );
  await Deno.writeTextFile(`${root}/embedded.vtt`, vtt);
  await using input = await Demuxer.open(clip);
  await using sub = await Demuxer.open(`${root}/embedded.srt`);
  await using web = await Demuxer.open(`${root}/embedded.vtt`);
  await using output = await Muxer.open(`${root}/music/clip.mkv`, {
    format: 'matroska',
    configure(ctx) {
      for (const stream of ctx.streams) stream.codecpar.codecTag = 0;
      for (
        const [i, title] of [[2, 'Embedded SRT'], [3, 'Embedded VTT']] as const
      ) {
        using tags = Dictionary.fromObject({ title, language: 'eng' });
        ctx.streams[i].metadata = tags;
      }
    },
  });
  const vi = output.addStream(input.video()!),
    ai = output.addStream(input.audio()!);
  const si = output.addStream(sub.streams[0]),
    wi = output.addStream(web.streams[0]);
  for (
    const [source, index] of [[input, undefined], [sub, si], [web, wi]] as const
  ) {
    for await (const packet of source.packets()) {
      if (!packet) continue;
      try {
        await output.writePacket(
          packet,
          index ?? (packet.streamIndex === input.video()!.index ? vi : ai),
        );
      } finally {
        packet.free();
      }
    }
  }
  await output.close();
  await Deno.writeTextFile(`${root}/music/clip.en.srt`, srt);
  await Deno.writeTextFile(`${root}/music/clip.fr.vtt`, vtt);
  await Deno.writeTextFile(
    `${root}/music/unrelated.srt`,
    'not a caption for clip',
  );
  await Deno.copyFile(clip, `${root}/music/bare.mp4`);
  await Deno.copyFile(song, `${root}/music/audio.mp3`);
}

async function setup() {
  const root = await Deno.makeTempDir({ prefix: 'melofon-api-captions-' });
  const f = await apiFixture({
    services: async (f) => {
      await captionFixture(root);
      await createLibraries(f.store).add('Music', `${root}/music`);
      await scanLibrary(f.store);
      const media = createMedia(undefined, f.state);
      return { library: createLibrary(f.store, undefined, { media }), media };
    },
  });
  await f.auth.users.create(f.admin.id, {
    username: 'listener',
    password: 'password-listener',
    role: 'user',
  });
  const library = createLibrary(f.store);
  const songs = await library.listSongs({ offset: 0, size: 100 });
  const id = songs.find((s) => s.path.endsWith('/clip.mkv'))!.id;
  const bare = songs.find((s) => s.path.endsWith('/bare.mp4'))!.id;
  const audio = songs.find((s) => !s.isVideo)!.id;
  const cookie =
    (await f.login('cookie', 'listener', 'password-listener')).credential;
  const bearer =
    (await f.login('bearer', 'listener', 'password-listener')).credential;
  return {
    f,
    root,
    id,
    bare,
    audio,
    cookie,
    bearer,
    async close() {
      await f.close();
      await Deno.remove(root, { recursive: true });
    },
  };
}

Deno.test('API video captions: one safe discovery projection and relative authenticated sidecar/embedded VTT/SRT resources', async () => {
  const t = await setup();
  try {
    assert(
      (await Deno.resolveDns('melofon.home', 'A')).every((ip) =>
        !ip.startsWith('127.')
      ),
    );
    for (const prefix of ['', '/music']) {
      await t.f.state.set(
        'server.baseUrl',
        prefix ? `${t.f.origin}${prefix}` : '',
      );
      for (const forced of ['', '/_melofon']) {
        for (const credential of [t.cookie, t.bearer]) {
          const base = `${prefix}${forced}/api/v1/videos/${t.id}`;
          const parent = new URL(`${base}/playback`, t.f.origin);
          const response = await t.f.get(parent.pathname, credential);
          assertEquals(response.status, 200);
          assertEquals(response.headers.get('cache-control'), 'no-store');
          const playback = await response.json();
          const detailResponse = await t.f.get(base, credential);
          const detail = (await detailResponse.json()).video.details;
          assertEquals(playback.audioTracks, detail.audio);
          assertEquals(
            playback.captions.map((
              { href: _href, ...caption }: { href: string },
            ) => caption),
            detail.captions,
          );
          assertEquals(playback.captions.length, 4);
          assertEquals(
            new URL(playback.hls, parent).pathname,
            `${base}/hls.m3u8`,
          );
          const serialized = JSON.stringify(playback);
          assert(
            !serialized.includes(t.root) && !serialized.includes('file') &&
              !serialized.includes(credential),
          );
          for (const caption of playback.captions) {
            assert(!caption.href.startsWith('/'));
            const url = new URL(caption.href, parent);
            assertEquals(url.pathname, `${base}/captions`);
            assertEquals([...url.searchParams.keys()].sort(), [
              'format',
              'key',
            ]);
            assertEquals(url.searchParams.get('key'), caption.key);
            const isSrt = caption.name === 'en' ||
              caption.name === 'Embedded SRT';
            const text = caption.name === 'en'
              ? 'Sidecar <i>Hello</i>\nsecond line'
              : caption.name === 'Embedded SRT'
              ? 'Embedded text\nsecond line'
              : 'VTT text';
            for (const format of ['vtt', 'srt'] as const) {
              url.searchParams.set('format', format);
              const resource = await t.f.get(
                url.pathname + url.search,
                credential,
              );
              assertEquals(resource.status, 200);
              assertEquals(resource.headers.get('cache-control'), 'no-store');
              assertEquals(
                resource.headers.get('content-type'),
                format === 'vtt'
                  ? 'text/vtt; charset=utf-8'
                  : 'application/x-subrip; charset=utf-8',
              );
              const body = await resource.text();
              // Same-format sidecars remain byte-identical; conversions and embedded
              // extraction normalize cue ids/settings but keep exact time and text.
              const original = caption.name === 'en' && format === 'srt'
                ? srt
                : caption.name === 'fr' && format === 'vtt'
                ? vtt
                : undefined;
              const times = isSrt
                ? ['00:00:00.125', '00:00:01.625']
                : ['00:00:00.250', '00:00:01.750'];
              const cue = `${format === 'vtt' ? 'WEBVTT\n\n' : '1\n'}${
                times.map((time) =>
                  format === 'srt' ? time.replace('.', ',') : time
                ).join(' --> ')
              }\n${text}\n\n`;
              assertEquals(body, original ?? cue);
            }
            url.searchParams.delete('format');
            const defaultVtt = await t.f.get(
              url.pathname + url.search,
              credential,
            );
            assertEquals(
              defaultVtt.headers.get('content-type'),
              'text/vtt; charset=utf-8',
            );
            assert((await defaultVtt.text()).startsWith('WEBVTT\n\n'));
          }
        }
      }
    }
    assert(t.f.peers.every((peer) => peer !== '127.0.0.1' && peer !== '::1'));
  } finally {
    await t.close();
  }
});

Deno.test('API video captions: strict exact-key lookup, video scoping, native errors and revocation without path disclosure', async () => {
  const t = await setup();
  try {
    const base = `/api/v1/videos/${t.id}`;
    const discovery = await t.f.get(`${base}/playback`, t.cookie);
    const playback = await discovery.json();
    const caption = playback.captions.find((c: { name: string }) =>
      c.name === 'en'
    );
    const resource = new URL(caption.href, `${t.f.origin}${base}/playback`);
    for (
      const path of [`${base}/playback`, resource.pathname + resource.search]
    ) {
      await error(await t.f.get(path), 401, 'unauthenticated');
      await error(
        await t.f.get(path, t.cookie, { Authorization: 'Bearer invalid' }),
        401,
        'unauthenticated',
      );
      const login = await t.f.login('bearer', 'listener', 'password-listener');
      const auth = (await t.f.auth.sessions.authenticate(login.credential))!;
      await t.f.auth.sessions.revoke(auth.user.id, auth.sessionId);
      await error(
        await t.f.get(path, login.credential),
        401,
        'unauthenticated',
      );
    }
    const bare = await t.f.get(`/api/v1/videos/${t.bare}/playback`, t.bearer);
    assertEquals((await bare.json()).captions, []);
    for (const id of [t.audio, 'missing']) {
      await error(
        await t.f.get(`/api/v1/videos/${id}/playback`, t.cookie),
        404,
        'not_found',
      );
    }
    for (const id of [t.audio, t.bare, 'missing']) {
      await error(
        await t.f.get(
          `/api/v1/videos/${id}/captions${resource.search}`,
          t.bearer,
        ),
        404,
        'not_found',
      );
    }
    for (
      const query of [
        '',
        'key=',
        'key=x&format=ass',
        'key=x&format=',
        'key=x&key=y',
        'key=x&format=srt&format=vtt',
        'key=x&path=secret',
        'key=x&stream=2',
      ]
    ) {
      const body = await error(
        await t.f.get(`${base}/captions?${query}`, t.cookie),
        400,
        'invalid_field',
      );
      assert(!JSON.stringify(body).includes(t.root));
    }
    for (
      const key of [
        '../embedded.srt',
        t.root + '/embedded.srt',
        'sidecar:../embedded.srt',
        'sidecar:unrelated.srt',
        'stream:0',
        'stream:1',
        'stream:999',
        'sidecar:clip.en.srt%00',
        'sidecar:clip.en.srt/..',
      ]
    ) {
      const body = await error(
        await t.f.get(
          `${base}/captions?${new URLSearchParams({ key })}`,
          t.bearer,
        ),
        404,
        'not_found',
      );
      assert(
        !JSON.stringify(body).includes(t.root) &&
          !JSON.stringify(body).includes(key),
      );
    }
    await error(
      await t.f.get(`${base}/playback?path=x`, t.cookie),
      400,
      'invalid_field',
    );
    await Deno.remove(`${t.root}/music/clip.en.srt`);
    await error(
      await t.f.get(resource.pathname + resource.search, t.cookie),
      404,
      'not_found',
    );
  } finally {
    await t.close();
  }
});
