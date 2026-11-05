import { assert, assertEquals } from '@std/assert';
import { decodeBase64 } from '@std/encoding/base64';
import { apiFixture } from './helpers/api.ts';
import { chromium } from './helpers/browser.ts';
import { videoFixture } from './helpers/video-fixture.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { scanLibrary } from '../src/scan.ts';
import { createMedia } from '../src/media.ts';
import { createStream } from '../src/stream.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createPlayback, type Playback } from '../src/playback.ts';
import { createPlayer } from '../src/player.ts';

// Default-port HTTP ingress, with no response/link rewriting or credential
// injection. Its log records cookie presence only, never credential values.
async function ingress(origin: string, root: string) {
  const config = `${root}/nginx.conf`;
  await Deno.writeTextFile(
    config,
    `
pid ${root}/nginx.pid;
error_log ${root}/nginx-error.log;
user tester;
worker_processes 1;
events { worker_connections 128; }
http {
  map $http_cookie $cookie_seen { "" 0; default 1; }
  log_format proof '$request_method $request_uri $status cookie=$cookie_seen';
  access_log ${root}/requests.log proof;
  client_body_temp_path ${root}/body;
  proxy_temp_path ${root}/proxy;
  server {
    listen 80;
    server_name melofon.home;
    location ~ ^(/music)?/browser.html$ {
      default_type text/html;
      alias ${await Deno.realPath('tests/fixtures/browser-media.html')};
    }
    location ~ ^(/music)?/browser-switch.m3u8$ {
      default_type application/vnd.apple.mpegurl;
      alias ${root}/browser-switch.m3u8;
    }
    location / {
      proxy_pass ${origin};
      proxy_set_header Host $http_host;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_buffering off;
    }
  }
}
`,
  );
  const args = ['-n', 'nginx', '-p', root, '-c', config];
  const start = await new Deno.Command('sudo', { args }).output();
  assert(start.success, new TextDecoder().decode(start.stderr));
  return async () => {
    const stop = await new Deno.Command('sudo', {
      args: [...args, '-s', 'quit'],
    }).output();
    assert(stop.success, new TextDecoder().decode(stop.stderr));
    const deadline = Date.now() + 5000;
    while (true) {
      try {
        await Deno.stat(`${root}/nginx.pid`);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) break;
        throw error;
      }
      assert(Date.now() < deadline, 'owned nginx stopped');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
}

for (const prefix of ['', '/music']) {
  Deno.test(`API browser media: native Chromium HTTP cookie audio/HLS/captions and household observer at ${prefix || '/'}`, async () => {
    // Per-test media paths are not eligible for prepared DB reuse.
    const root = await Deno.makeTempDir({ prefix: 'melofon-browser-media-' });
    let playback!: Playback;
    const f = await apiFixture({
      services: async (f) => {
        await Deno.mkdir(`${root}/media`);
        await Deno.copyFile(
          'tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3',
          `${root}/media/song.mp3`,
        );
        await videoFixture(`${root}/media/clip.mkv`, 320, 180, 4, 25, 'h264');
        await Deno.writeTextFile(
          `${root}/media/clip.en.vtt`,
          'WEBVTT\n\n00:00.000 --> 00:03.900\nSelected browser caption\n\n',
        );
        await createLibraries(f.store).add('Music', `${root}/media`);
        await scanLibrary(f.store);
        const media = createMedia(undefined, f.state);
        const library = createLibrary(f.store, undefined, { media });
        playback = createPlayback({
          library,
          player: createPlayer(),
          cfg: f.cfg,
          notify: f.notify,
          nowPlaying: createNowPlaying(f.store, { state: f.state }),
          sessions: f.auth.sessions,
        });
        return {
          library,
          media,
          playback,
          stream: createStream(
            media,
            f.cfg,
            undefined,
            undefined,
            f.auth.sessions,
          ),
        };
      },
    });
    let stopIngress: (() => Promise<void>) | undefined;
    let player: Awaited<ReturnType<typeof chromium>> | undefined;
    let observer: Awaited<ReturnType<typeof chromium>> | undefined;
    try {
      const ips = await Deno.resolveDns('melofon.home', 'A');
      assert(ips.length > 0 && ips.every((ip) => !ip.startsWith('127.')));
      await f.state.set('server.baseUrl', `http://melofon.home${prefix}`);
      await f.state.set('media.hls.segmentSeconds', '1');
      for (const username of ['listener', 'observer']) {
        await f.auth.users.create(f.admin.id, {
          username,
          password: `password-${username}`,
          role: 'user',
        });
      }
      const songs = await createLibrary(f.store).listSongs({
        size: 100,
        offset: 0,
      });
      const song = songs.find((s) => !s.isVideo)!;
      const video = songs.find((s) => s.isVideo)!;
      stopIngress = await ingress(f.origin, root);
      player = await chromium();
      observer = await chromium();
      for (const browser of [player, observer]) {
        await browser.send('Page.navigate', {
          url: `http://melofon.home${prefix}/browser.html`,
        });
        await browser.poll(`typeof login === 'function'`);
        assertEquals(await browser.evaluate('isSecureContext'), false);
        assertEquals(
          await browser.evaluate('location.origin'),
          'http://melofon.home',
        );
      }
      const session = await player.evaluate<string>(`login('listener')`);
      await observer.evaluate(`login('observer')`);
      assertEquals(await player.evaluate('document.cookie'), '');
      await observer.evaluate('observe()');
      await observer.poll(`frames.some(f => f.type === 'hello')`);

      // No abilities: the actual <audio src> receives the MP3 fallback.
      await player.evaluate(
        `audio.src = api + '/songs/${song.id}/stream'; audio.play()`,
      );
      await player.poll('audio.currentTime > 0.25 && audio.readyState >= 2');
      await player.evaluate(`audio.pause(); report('${song.id}', 1, 0, audio)`);
      await observer.poll(`frames.some(f => f.events?.nowPlaying)`);
      const row = await observer.evaluate<{
        nowPlaying: {
          username: string;
          client: string;
          song: { id: string };
          positionMs: number;
        }[];
      }>(`json('/now-playing', 'GET')`);
      assertEquals(row.nowPlaying.length, 1);
      assertEquals(row.nowPlaying[0].username, 'listener');
      assertEquals(row.nowPlaying[0].client, 'Chromium');
      assertEquals(row.nowPlaying[0].song.id, song.id);
      assert(row.nowPlaying[0].positionMs >= 250);
      assertEquals(
        await observer.evaluate(
          `frames.find(f => f.events?.nowPlaying).events.nowPlaying`,
        ),
        [],
      );

      // The same jar registers direct MP3 abilities and plays original bytes.
      await player.evaluate(`json('/me/playback-capabilities', 'PUT', {
        name: 'Chromium', platform: 'browser',
        directPlayProfiles: [{containers:['mp3'],audioCodecs:['mp3'],protocols:['http']}]
      })`);
      await player.evaluate(
        `audio.src = api + '/songs/${song.id}/stream?offset=0'; audio.play()`,
      );
      await player.poll('audio.currentTime > 0.25 && audio.readyState >= 2');
      await player.evaluate('audio.pause()');

      assert(
        await player.evaluate(
          `video.canPlayType('application/vnd.apple.mpegurl') !== ''`,
        ),
        'Native HLS required; ask the orchestrator before selecting a library',
      );
      const resources = await player.evaluate<{
        hls: string;
        caption: string;
        renditions: { url: string; playlist: string }[];
      }>(
        `prepareVideo('${video.id}')`,
      );
      await player.evaluate('video.play()');
      await player.poll(
        'video.currentTime > 0.5 && video.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames > 0',
      );
      await player.poll(
        `video.textTracks[0]?.activeCues?.[0]?.text === 'Selected browser caption'`,
      );
      await player.evaluate('video.pause()');
      assert(
        await player.evaluate(
          'video.currentTime > 0.5 && video.videoHeight > 0 && !video.error',
        ),
      );
      // First play the real API master/children above. Then force a switch at
      // segment 1 using only those returned segment URLs and durations: the
      // browser must decode low -> high, regardless of its adaptive heuristic.
      assertEquals(resources.renditions.length, 2);
      const [low, high] = resources.renditions;
      const highSegments = high.playlist.split('\n').filter((line) =>
        line && !line.startsWith('#')
      );
      let segmentIndex = 0;
      const switched = low.playlist.split('\n').map((line) => {
        if (!line || line.startsWith('#')) return line;
        const index = segmentIndex++;
        return index === 0
          ? new URL(line, low.url).href
          : new URL(highSegments[index], high.url).href;
      }).join('\n');
      assertEquals(segmentIndex, highSegments.length);
      await Deno.writeTextFile(`${root}/browser-switch.m3u8`, switched);
      await player.evaluate(
        `video.src = prefix + '/browser-switch.m3u8'; video.play()`,
      );
      await player.poll('video.videoWidth === 160 && video.currentTime > 0');
      await player.poll(
        'video.currentTime > 1.5 && video.videoWidth === 320 && video.videoHeight === 180 && video.getVideoPlaybackQuality().totalVideoFrames > 0',
      );
      await player.poll(
        `video.textTracks[0]?.activeCues?.[0]?.text === 'Selected browser caption'`,
      );
      await player.evaluate('video.pause()');
      await observer.evaluate('frames.length = 0');
      await player.evaluate(`report('${video.id}', 2, 0, video)`);
      await observer.poll(`frames.some(f => f.events?.nowPlaying)`);
      assertEquals(
        await observer.evaluate(
          `json('/now-playing','GET').then(body => body.nowPlaying[0].song.id)`,
        ),
        video.id,
      );
      assertEquals(player.exceptions, []);
      assertEquals(observer.exceptions, []);
      const screenshot = await player.send<{ data: string }>(
        'Page.captureScreenshot',
        { format: 'png' },
      );
      const evidence = `${root}/browser-media-${prefix ? 'music' : 'root'}.png`;
      await Deno.writeFile(evidence, decodeBase64(screenshot.data));

      const log = await Deno.readTextFile(`${root}/requests.log`);
      const lines = log.split('\n');
      for (
        const part of ['/songs/', '/hls.m3u8?', '/hls/segments/', '/captions?']
      ) {
        assert(
          lines.some((line) =>
            line.includes(part) && / (200|206) cookie=1$/.test(line)
          ),
          part,
        );
      }
      assert(
        lines.filter((line) =>
          line.includes('/hls.m3u8?') && line.includes(' 200 cookie=1')
        ).length >= 2,
        'Native HLS followed master and rendition child',
      );
      const segment = lines.find((line) =>
        line.includes('/hls/segments/') && line.includes(' 200 cookie=1')
      )!.split(' ')[1];
      // Revoke through the real session route, then bypass all buffered media.
      await player.evaluate(`json('/me/sessions/${session}', 'DELETE')`);
      for (
        const url of [
          `http://melofon.home${prefix}/api/v1/songs/${song.id}/stream?offset=1`,
          resources.hls,
          resources.caption,
          `http://melofon.home${segment}`,
        ]
      ) {
        assertEquals(
          await player.evaluate(
            `fetch(${
              JSON.stringify(url)
            }, {cache:'no-store'}).then(r => r.status)`,
          ),
          401,
        );
      }
      await player.evaluate(
        `audio.src = api + '/songs/${song.id}/stream?offset=2'; audio.load()`,
      );
      await player.poll('audio.error !== null');
      console.log(JSON.stringify({
        origin: `http://melofon.home${prefix}`,
        secureContext: false,
        nativeHls: true,
        forcedSwitch: '160x90 -> 320x180 at segment 1',
        observerSong: song.id,
        observerVideo: video.id,
        cookieMediaRequests: lines.filter((line) =>
          / (200|206) cookie=1$/.test(line)
        ).length,
        revokedResources: 4,
        screenshot: evidence,
      }));
    } catch (error) {
      if (player) {
        console.log(
          await player.evaluate(`JSON.stringify({
          time:video.currentTime, width:video.videoWidth, height:video.videoHeight,
          quality:video.getVideoPlaybackQuality(), error:video.error?.message,
          ready:video.readyState, paused:video.paused, ended:video.ended
        })`),
        );
      }
      if (stopIngress) {
        console.log(await Deno.readTextFile(`${root}/requests.log`));
      }
      throw error;
    } finally {
      await observer?.close();
      await player?.close();
      await stopIngress?.();
      await playback.close();
      await f.close();
      await Deno.remove(root, { recursive: true });
    }
  });
}
