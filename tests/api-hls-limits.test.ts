import { assert, assertEquals, assertMatch } from '@std/assert';
import { Demuxer } from 'node-av';
import { apiFixture, error } from './helpers/api.ts';
import { videoFixture } from './helpers/video-fixture.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createMedia } from '../src/media.ts';
import { createUserService } from '../src/user.ts';
import { scanLibrary } from '../src/scan.ts';

for (const hat of ['native', 'opensubsonic']) {
  Deno.test(`HLS limits: ${hat} rejects entire ladders and child requests before cache admission`, async () => {
    const root = await Deno.makeTempDir({ prefix: 'melofon-hls-limits-' });
    const f = await apiFixture({
      allLayers: true,
      services: async (f) => {
        await Deno.mkdir(`${root}/music`);
        await videoFixture(`${root}/music/clip.mkv`, 320, 180, 1, 25, 'h264');
        await createLibraries(f.store).add('Video', `${root}/music`);
        await scanLibrary(f.store);
        return {
          library: createLibrary(f.store),
          media: createMedia(undefined, f.state),
          user: createUserService(f.store, f.cfg),
        };
      },
    });
    try {
      await f.auth.users.create(f.admin.id, {
        username: 'listener',
        password: 'password-listener',
        role: 'user',
      });
      const credential =
        (await f.login('bearer', 'listener', 'password-listener')).credential;
      const video = (await createLibrary(f.store).videos())[0];
      const route = (child = false) =>
        hat === 'native'
          ? `/api/v1/videos/${video.id}/${
            child ? 'hls/segments/0.ts' : 'hls.m3u8'
          }`
          : `/rest/${
            child ? 'hls/segment.ts' : 'hls.m3u8'
          }?id=${video.id}&segmentIndex=0&u=listener&p=password-listener&v=1.16.1&c=limits&f=json`;
      const read = (query: string, child = false, post = false) => {
        const path = route(child);
        const full = `${path}${path.includes('?') ? '&' : '?'}${query}`;
        if (!post) {
          return f.get(full, hat === 'native' ? credential : undefined);
        }
        const url = new URL(full, f.origin);
        return f.request(url.pathname, {
          method: 'POST',
          body: url.searchParams,
        });
      };
      for (
        const [name, value] of Object.entries({
          maxRenditions: 8,
          maxDimension: 4096,
          maxKbps: 100000,
        })
      ) {
        const setting = (await f.state.describe()).find((s) =>
          s.key === `media.hls.${name}`
        )!;
        assertEquals(setting.owner, 'core');
        assertEquals(setting.default, value);
      }
      await f.state.set('media.hls.maxRenditions', '2');
      await f.state.set('media.hls.maxDimension', '160');
      await f.state.set('media.hls.maxKbps', '400');
      await f.state.set('media.hls.videoKbps', '400');
      // Values are deliberately small, so the pre-fix reproduction is safe.
      for (
        const query of [
          'bitRate=100&bitRate=200&bitRate=300',
          'bitRate=100@160x90&bitRate=401@320x180',
          'size=322x180',
          'size=160x182',
          'size=320x180',
          'bitRate=100',
          '',
          ...(hat === 'opensubsonic'
            ? ['bitRate=100&maxBitRate=200&maxBitRate=300']
            : []),
        ]
      ) {
        for (const post of hat === 'native' ? [false] : [false, true]) {
          const response = await read(query, false, post);
          if (hat === 'native') await error(response, 400, 'invalid_field');
          else {
            assertEquals(response.status, 200);
            assertMatch(response.headers.get('content-type')!, /^text\/xml/);
            assertMatch(
              await response.text(),
              /status="failed".*error code="0"/s,
            );
          }
        }
        // No earlier valid rung may start work before a later rejection.
        await assertNoCache(f.cfg.dataDir!);
      }
      // Source dimensions apply independently of the configured ceiling.
      await f.state.set('media.hls.maxDimension', '4096');
      for (const query of ['size=322x180', 'size=320x182', 'bitRate=401']) {
        const response = await read(query, true);
        if (hat === 'native') await error(response, 400, 'invalid_field');
        else {
          assertMatch(response.headers.get('content-type')!, /^text\/xml/);
          assertMatch(await response.text(), /error code="0"/);
        }
        await assertNoCache(f.cfg.dataDir!);
      }
      await f.state.set('media.hls.segmentSeconds', '1');
      await f.state.set('media.hls.preset', 'ultrafast');
      await f.state.set('media.hls.maxDimension', '320');
      const accepted = await read('bitRate=100@160x90&bitRate=400@320x180');
      assertEquals(accepted.status, 200);
      const master = await accepted.text();
      assertEquals(
        master.split('\n').filter((l) => l.startsWith('#EXT-X-STREAM-INF:'))
          .length,
        2,
      );
      assert(master.includes('RESOLUTION=160x90'));
      assert(master.includes('RESOLUTION=320x180'));
      // Re-read through VOD to join the background producers before teardown.
      for (const query of ['bitRate=100@160x90', 'bitRate=400@320x180']) {
        let text = '';
        for (let i = 0; i < 200 && !text.includes('#EXT-X-ENDLIST'); i++) {
          const response = await read(query);
          assertEquals(response.status, 200);
          text = await response.text();
          if (!text.includes('#EXT-X-ENDLIST')) {
            await new Promise((r) => setTimeout(r, 10));
          }
        }
        assert(text.includes('#EXT-X-ENDLIST'));
      }
      // Count real source opens only after the native producers have reached VOD.
      const open = Demuxer.open;
      let sourceOpens = 0;
      Demuxer.open = (...args) => {
        if (args[0] === video.path) sourceOpens++;
        return Reflect.apply(open, Demuxer, args) as ReturnType<
          typeof Demuxer.open
        >;
      };
      try {
        for (let i = 0; i < 3; i++) {
          const response = await read('bitRate=100@160x90', true);
          assertEquals(response.status, 200);
          const bytes = new Uint8Array(await response.arrayBuffer());
          assertEquals(bytes[0], 0x47);
        }
        assertEquals(
          sourceOpens,
          0,
          'unchanged segment requests do not reopen the source',
        );
      } finally {
        Demuxer.open = open;
      }
      const outputs = async () => {
        const entries = [];
        for await (const entry of Deno.readDir(`${f.cfg.dataDir}/hls`)) {
          entries.push(entry.name);
        }
        return entries.sort();
      };
      const cached = await outputs();
      assertEquals(cached.length, 2);
      for (
        const [name, value] of Object.entries({
          maxRenditions: '3',
          maxDimension: '640',
          maxKbps: '800',
        })
      ) {
        await f.state.set(`media.hls.${name}`, value);
        // Join VOD even in the pre-fix run, so a failure cannot abandon encodes.
        for (const query of ['bitRate=100@160x90', 'bitRate=400@320x180']) {
          let text = '';
          for (let i = 0; i < 200 && !text.includes('#EXT-X-ENDLIST'); i++) {
            const response = await read(query);
            assertEquals(response.status, 200);
            text = await response.text();
            if (!text.includes('#EXT-X-ENDLIST')) {
              await new Promise((r) => setTimeout(r, 10));
            }
          }
          assert(text.includes('#EXT-X-ENDLIST'));
        }
        assertEquals(
          await outputs(),
          cached,
          `${name} must not invalidate accepted cached renditions`,
        );
      }
      // A lowered live limit must also reject a completed cache hit.
      await f.state.set('media.hls.maxKbps', '399');
      const rejected = await read('bitRate=400@320x180');
      if (hat === 'native') await error(rejected, 400, 'invalid_field');
      else assertMatch(await rejected.text(), /error code="0"/);
    } finally {
      await f.close();
      await Deno.remove(root, { recursive: true });
    }
  });
}

async function assertNoCache(root: string) {
  try {
    const entries = [];
    for await (const entry of Deno.readDir(`${root}/hls`)) {
      entries.push(entry.name);
    }
    assertEquals(entries, [], 'invalid request produced no output');
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}
