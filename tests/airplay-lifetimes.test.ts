import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from '@std/assert';
import { createOutputs, createPlayer } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';
import { createNotify } from '../src/notify.ts';
import { createAirplayBoot } from '../src/boots/airplay.ts';
import { createAirplayDevices } from '../src/boots/airplay-device.ts';
import { recordingStream } from './helpers/airplay-devices.ts';
import type { HelperEventFn } from '../src/boots/airplay-profile.ts';
import type { Media } from '../src/media.ts';
import type { State } from '../src/state.ts';
import type { NowPlaying } from '../src/nowplaying.ts';

const phases = [
  'prepare',
  'credentials',
  'start',
  'resume',
  'pair-settings',
  'pair-prepare',
  'pair-start',
  'pair-pin-send',
  'pin-settings',
  'pin-send',
  'credential-save',
  'retry',
  'policy',
] as const;
for (const phase of phases) {
  Deno.test(`AirPlay close joins ${phase} and its cleanup without reviving a session`, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const closingTransport = Promise.withResolvers<void>();
    const releaseTransport = Promise.withResolvers<void>();
    let holding = false,
      resumeHolding = false,
      cleaned = 0,
      transportClosed = 0,
      starts = 0,
      pcm = 0;
    let event: HelperEventFn = () => {};
    let signal: AbortSignal | undefined;
    const hold = async () => {
      entered.resolve();
      try {
        await release.promise;
      } finally {
        cleaned++;
      }
    };
    const notify = createNotify();
    const outputs = createOutputs({ notify });
    const nowPlaying: NowPlaying = {
      set: () => Promise.resolve(),
      report: () => Promise.resolve(),
      reportSession: () => Promise.resolve(false),
      clearByStreamId: () => Promise.resolve(false),
      list: () => Promise.resolve([]),
      expire: () => Promise.resolve(false),
    };
    const playback = createPlayback({
      player: createPlayer(),
      outputs,
      nowPlaying,
      notify,
      cfg: {},
      library: { getSong: () => Promise.resolve(null) },
      targets: {
        hasPlaybackTarget: () => true,
        async preparePlayback(s) {
          if (resumeHolding) {
            signal = s;
            await hold();
          }
        },
      },
    });
    const deviceDeps = {
      outputs,
      resolver: {
        async resolve(host, port, s) {
          if (holding && ['prepare', 'pair-prepare', 'retry'].includes(phase)) {
            signal = s;
            await hold();
          }
          return {
            name: '001122334455@Receiver._raop._tcp.local',
            host: 'receiver.local',
            address: host,
            port: port ?? 7000,
            ttlMs: 60000,
            txt: { tp: 'UDP', sr: '44100', ss: '16', ch: '2', sf: '200' },
          };
        },
        close() {},
      },
      credentials: {
        async session() {
          if (holding && phase === 'credentials') await hold();
          return {
            password: null,
            pairingKey: null,
            isCurrent: () => true,
            acceptPairing: () => Promise.resolve(),
          };
        },
      },
      spawn(onEvent) {
        event = onEvent;
        return {
          transport: {
            async send(command) {
              if (
                holding &&
                (phase === 'pin-send' || phase === 'pair-pin-send') &&
                command.cmd === 'pin'
              ) await hold();
            },
            async close() {
              closingTransport.resolve();
              if (phase === 'start' || phase === 'pair-start') {
                await releaseTransport.promise;
              }
              transportClosed++;
            },
            pcm() {
              pcm++;
              return Promise.resolve();
            },
            cancelPcm() {},
            ownsSharedFeed: () => false,
          },
          async start() {
            starts++;
            if (holding && (phase === 'start' || phase === 'pair-start')) {
              await hold();
            } else onEvent('state', 'password');
          },
        };
      },
    } satisfies Parameters<typeof createAirplayDevices>[0];
    const devices = createAirplayDevices({
      ...deviceDeps,
      stream: recordingStream(deviceDeps.spawn),
    });
    const state = {
      declare() {},
      onChange: () => () => {},
      async get() {
        if (phase === 'policy') await hold();
        return 'off';
      },
      async getTyped() {
        if (
          holding && (phase === 'pair-settings' || phase === 'pin-settings')
        ) await hold();
        return 120;
      },
    } as unknown as State;
    const boot = createAirplayBoot({
      outputs,
      playback,
      notify,
      devices,
      state,
      ...(phase === 'policy' ? {} : { retryBackoffMs: [] }),
      media: {} as Media,
    });
    let work: Promise<unknown> = Promise.resolve();
    try {
      devices.register({
        id: 's',
        name: 'Receiver',
        type: 'AirPlay',
        host: '192.0.2.10',
        selected: !phase.startsWith('pair') && phase !== 'retry',
        volume: 50,
      });
      holding = true;
      if (phase === 'pair-pin-send') {
        await boot.pair('s');
        work = boot.submitPin('s', '1234');
      } else if (phase.startsWith('pair')) work = boot.pair('s');
      else if (phase === 'retry') work = boot.retry('s');
      else if (phase !== 'policy') {
        await playback.queueAddSources([{
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
        if (
          ['resume', 'pin-settings', 'pin-send', 'credential-save'].includes(
            phase,
          )
        ) {
          // Wait for the real admission/activation pipeline's password challenge.
          const deadline = performance.now() + 10000;
          while (playback.playerView().state !== 'pause') {
            assert(performance.now() < deadline);
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
          if (phase === 'resume') {
            resumeHolding = true;
            event('state', 'connected');
          } else if (phase === 'credential-save') {
            work = boot.changeCredentials('s', hold);
          } else work = boot.submitPin('s', '1234');
        }
      }
      const result = Promise.allSettled([work]);
      await entered.promise;
      const startsBefore = starts;
      const command = playback.lastCommand();
      const close = boot.close();
      let closed = false;
      void close.then(() => closed = true);
      if (phase === 'start' || phase === 'pair-start') {
        await closingTransport.promise;
        // Releasing the already published transport is not settlement of its
        // still-held start continuation. Close must join both independently.
        releaseTransport.resolve();
      }
      for (let n = 0; n < 30; n++) await Promise.resolve();
      const early = closed;
      release.resolve();
      await close;
      await result;
      assertEquals(early, false, `${phase} escaped its owner`);
      assertStrictEquals(boot.close(), close, 'shared close receipt');
      assertEquals(cleaned, 1);
      if (signal) assert(signal.aborted);
      assertEquals(starts, startsBefore, 'no late transport start');
      assertEquals(playback.lastCommand(), command, 'no late resume');
      assertEquals(pcm, 0);
      if (starts) assertEquals(transportClosed, 1);
      if (phase.startsWith('pair')) {
        assertEquals(
          devices.describe('s').session?.pairing?.state,
          'cancelled',
        );
      }
      await assertRejects(() => boot.pair('s'), Error, 'closed');
      await assertRejects(() => boot.retry('s'), Error, 'closed');
      await assertRejects(() => boot.submitPin('s', '1234'), Error, 'closed');
      await assertRejects(
        () =>
          boot.changeCredentials('s', () => {
            throw new Error('must not save');
          }),
        Error,
        'closed',
      );
      event('state', 'connected');
      for (let n = 0; n < 20; n++) await Promise.resolve();
      assertEquals(pcm, 0);
      assertEquals(cleaned, 1);
    } finally {
      release.resolve();
      releaseTransport.resolve();
      await Promise.allSettled([work, boot.close()]);
      devices.close();
      await playback.close();
    }
  });
}
