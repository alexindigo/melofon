import { assert, assertEquals } from '@std/assert';
import { createOutputs, createPlayer } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';
import { createNotify } from '../src/notify.ts';
import { createAirplayBoot } from '../src/boots/airplay.ts';
import { createAirplayDevices } from '../src/boots/airplay-device.ts';
import type { HelperEventFn } from '../src/boots/airplay-profile.ts';
import type { Media } from '../src/media.ts';
import type { NowPlaying } from '../src/nowplaying.ts';

async function until(predicate: () => boolean) {
  const deadline = performance.now() + 10000;
  while (!predicate()) {
    assert(performance.now() < deadline, 'command consumer timed out');
    await new Promise((done) => setTimeout(done, 1));
  }
}
for (const mode of ['append', 'explicit-off'] as const) {
  Deno.test(`AirPlay captured resume preserves ${mode} semantics through PCM delivery`, async () => {
    const notify = createNotify(), outputs = createOutputs({ notify });
    const releases = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    const signals: AbortSignal[] = [];
    let holding = false, bytes = 0;
    const playback = createPlayback({
      player: createPlayer(),
      outputs,
      notify,
      cfg: {},
      library: { getSong: () => Promise.resolve(null) },
      nowPlaying: {} as NowPlaying,
      targets: {
        hasPlaybackTarget: () => true,
        async preparePlayback(signal) {
          if (!holding) return;
          const index = signals.push(signal) - 1;
          await releases[index].promise;
        },
      },
    });
    const events: HelperEventFn[] = [];
    const devices = createAirplayDevices({
      outputs,
      resolver: {
        resolve: (host, port) =>
          Promise.resolve({
            name: '001122334455@Receiver._raop._tcp.local',
            host: 'receiver.local',
            address: host,
            port: port ?? 7000,
            ttlMs: 60000,
            txt: { tp: 'UDP', sr: '44100', ss: '16', ch: '2', sf: '200' },
          }),
        close() {},
      },
      spawn(event) {
        events.push(event);
        return {
          transport: {
            send: () => Promise.resolve(),
            close: () => Promise.resolve(),
            pcm(chunk) {
              bytes += chunk.length;
              return Promise.resolve();
            },
            cancelPcm() {},
            ownsSharedFeed: () => false,
          },
          start() {
            return Promise.resolve();
          },
        };
      },
    });
    const boot = createAirplayBoot({
      outputs,
      playback,
      notify,
      devices,
      retryBackoffMs: [],
      media: {} as Media,
      sources: {
        open: (_entry, { signal }) =>
          Promise.resolve({
            async *[Symbol.asyncIterator]() {
              yield new Uint8Array(64).fill(7);
              await new Promise<void>((done) => {
                signal.addEventListener('abort', () => done(), { once: true });
                if (signal.aborted) done();
              });
            },
          }),
      },
    });
    let newer: Promise<unknown> | undefined;
    try {
      devices.register({
        id: 's',
        name: 'Receiver',
        type: 'AirPlay',
        host: '192.0.2.10',
        selected: true,
        volume: 50,
      });
      const [entry] = await playback.queueAddSources([{
        reference: { kind: 'station', id: 'radio' },
        facts: {
          kind: 'web',
          url: 'http://melofon.home/radio',
          title: 'Radio',
          artistName: null,
          durationMs: null,
          mode: 'live',
          seekable: false,
          streamTitle: null,
          streamUrl: null,
        },
      }]);
      await playback.play();
      await until(() => events.length === 1);
      // Driver events arrive after start settles, not reentrantly inside it.
      await new Promise((done) => setTimeout(done, 0));
      events[0]('state', 'password');
      await until(() => playback.playerView().state === 'pause');
      holding = true;
      events[0]('state', 'connected');
      await until(() => signals.length === 1);
      if (mode === 'append') {
        await playback.queueImport(
          playback.queueCopyView(),
          { mode: 'add' },
          undefined,
          (change) => {
            change();
            return Promise.resolve();
          },
        );
        assertEquals(signals[0].aborted, false);
      } else {
        outputs.update('s', { selected: false });
        assert(
          signals[0].aborted,
          'explicit off must revoke the captured resume',
        );
        outputs.update('s', { selected: true });
        newer = Promise.resolve(playback.play());
        await until(() => signals.length === 2);
      }
      releases[0].resolve();
      if (mode === 'explicit-off') {
        for (let n = 0; n < 40; n++) await Promise.resolve();
        assertEquals(
          signals[1].aborted,
          false,
          'old resume cleanup cannot cancel its successor',
        );
        releases[1].resolve();
        await newer;
        await until(() => events.length === 2);
        events[1]('state', 'connected');
      }
      await until(() => playback.playerView().state === 'play' && bytes > 0);
      assertEquals(playback.playerView().current?.id, entry.id);
    } finally {
      releases.forEach((release) => release.resolve());
      await Promise.allSettled([newer, boot.close()]);
      devices.close();
      await playback.close();
    }
  });
}
