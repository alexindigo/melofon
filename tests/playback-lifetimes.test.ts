import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from '@std/assert';
import { createOutputs, createPlayer } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';
import { createPlaybackReports } from '../src/playback-reports.ts';
import { createSpeakers } from '../src/speakers.ts';
import type { NowPlaying } from '../src/nowplaying.ts';
import type { QueueMedia } from '../src/queue-source.ts';
import type { SongRow } from '../src/library.ts';

const media: QueueMedia = {
  reference: { kind: 'station', id: 'station' },
  facts: {
    kind: 'web',
    url: 'http://melofon.home/radio',
    title: 'Radio',
    artistName: null,
    durationMs: null,
    mode: 'unknown',
    seekable: false,
    streamTitle: null,
    streamUrl: null,
  },
};
function emptyReports(): NowPlaying {
  return {
    set: () => Promise.resolve(),
    report: () => Promise.resolve(),
    reportSession: () => Promise.resolve(false),
    clearByStreamId: () => Promise.resolve(false),
    list: () => Promise.resolve([]),
    expire: () => Promise.resolve(false),
  };
}
async function turns() {
  for (let n = 0; n < 20; n++) await Promise.resolve();
}

for (const phase of ['resolve', 'prepare', 'allocate', 'target'] as const) {
  Deno.test(`playback close joins superseded and queued work held in ${phase}`, async () => {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let cleaned = 0, writes = 0;
    const hold = async () => {
      entered.resolve();
      try {
        await gate.promise;
      } finally {
        cleaned++;
      }
    };
    const player = createPlayer();
    // Seed the real engine without the service's deliberately held intake.
    player.queueAddSources([media]);
    const playback = createPlayback({
      player,
      nowPlaying: emptyReports(),
      cfg: {},
      library: { getSong: () => Promise.resolve(null) },
      resolveQueueReference: async () => {
        if (phase === 'resolve') await hold();
        return media;
      },
      prepareQueueMedia: async (item) => {
        if (phase === 'prepare') await hold();
        return item;
      },
      reserveQueueIds: async () => {
        if (phase === 'allocate') await hold();
        return 10;
      },
      targets: {
        hasPlaybackTarget: () => true,
        async preparePlayback() {
          if (phase === 'target') await hold();
        },
      },
      persistence: {
        saveQueue() {
          writes++;
        },
        saveState() {
          writes++;
        },
      } as unknown as Parameters<typeof createPlayback>[0]['persistence'],
    });
    const start = phase === 'target'
      ? playback.play()
      : playback.queueAddReferences([{ kind: 'station', id: 'station' }]);
    const result = Promise.allSettled([start]);
    await entered.promise;
    // Supersede the visible pending slot; close must still find its old work.
    playback.pause();
    const queued = phase === 'target'
      ? Promise.resolve()
      : playback.queueAddReferences([{ kind: 'station', id: 'station' }]);
    const queuedResult = Promise.allSettled([queued]);
    const before = playback.queueView();
    const writesBefore = writes;
    let closed = false;
    const closing = playback.close();
    void closing.then(() => closed = true);
    await turns();
    const early = closed;
    gate.resolve();
    try {
      await closing;
      assertEquals(early, false, 'abort is not settlement');
      assertStrictEquals(playback.close(), closing, 'concurrent close receipt');
      assertEquals((await result)[0].status, 'rejected');
      if (phase !== 'target') {
        assertEquals((await queuedResult)[0].status, 'rejected');
      }
      assertEquals(cleaned, 1);
      assertEquals(playback.queueView(), before);
      assertEquals(writes, writesBefore, 'no late save/publication');
      await turns();
      assertEquals(cleaned, 1, 'no cleanup remains after close');
    } finally {
      gate.resolve();
      await Promise.all([result, queuedResult, playback.close()]);
    }
  });
}

for (
  const outcome of ['winner', 'winner-cancel', 'cancel', 'timeout'] as const
) {
  Deno.test(`speaker preflight joins losing peer cleanup after ${outcome}`, async () => {
    const outputs = createOutputs();
    for (const id of ['ready', 'slow']) {
      outputs.register({
        id,
        name: id,
        type: 'AirPlay',
        host: '192.0.2.1',
        selected: true,
        volume: 50,
      });
    }
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const winner = Promise.withResolvers<boolean>();
    let cleaned = false;
    const speakers = createSpeakers({
      outputs,
      adapterView: () => ({
        preparation: { state: 'unresolved', targetRevision: 1 },
      }),
      state: {
        declare() {},
        getTyped: () => Promise.resolve(outcome === 'timeout' ? 0.01 : 5),
      } as unknown as Parameters<typeof createSpeakers>[0]['state'],
      async prepare(id, signal) {
        if (id === 'ready') return await winner.promise;
        signal.addEventListener('abort', () => aborted.resolve(), {
          once: true,
        });
        entered.resolve();
        await aborted.promise;
        await cleanup.promise;
        cleaned = true;
        return false;
      },
    });
    const controller = new AbortController();
    const work = speakers.preparePlayback(controller.signal);
    const result = Promise.allSettled([work]);
    let finished = false;
    void result.then(() => finished = true);
    await entered.promise;
    if (outcome === 'winner' || outcome === 'winner-cancel') {
      winner.resolve(
        true,
      );
    } else if (outcome === 'cancel') controller.abort();
    await aborted.promise;
    if (outcome === 'winner-cancel') controller.abort();
    await turns();
    const early = finished;
    cleanup.resolve();
    winner.resolve(false);
    await result;
    assertEquals(early, false, 'preflight must join every admitted peer');
    assert(cleaned);
    assertEquals(
      (await result)[0].status,
      outcome === 'winner' ? 'fulfilled' : 'rejected',
    );
  });
}

Deno.test('household close joins a held song lookup and fences every report entry', async () => {
  const gate = Promise.withResolvers<SongRow | null>();
  let writes = 0, lookups = 0;
  const reports = createPlaybackReports({
    nowPlaying: {
      ...emptyReports(),
      report: () => {
        writes++;
        return Promise.resolve();
      },
    },
    library: {
      getSong: () => {
        lookups++;
        return gate.promise;
      },
    },
    serverRows: () => [],
  });
  const report = {
    username: 'admin',
    client: 'phone',
    trackId: 'song',
    streamId: 'stream',
    state: 'playing' as const,
    positionMs: 0,
    source: 'melofon' as const,
    playbackRate: 1,
    ignoreScrobble: true,
  };
  const work = reports.reportPlayback(report);
  const result = Promise.allSettled([work]);
  const closing = reports.close();
  let closed = false;
  void closing.then(() => closed = true);
  await turns();
  const early = closed;
  gate.resolve({ durationMs: 1000 } as SongRow);
  await closing;
  assertEquals(early, false);
  assertStrictEquals(reports.close(), closing);
  assertEquals((await result)[0].status, 'rejected');
  for (
    const call of [
      () => reports.reportPlaying(report),
      () => reports.reportStopped({ streamId: 'stream' }),
      () => reports.reportPlayback(report),
      () =>
        reports.reportSessionPlayback({
          userId: 'admin',
          sessionId: 'session',
          trackId: 'song',
          run: 1,
          sequence: 0,
          state: 'playing',
          positionMs: 0,
          playbackRate: 1,
          ignoreScrobble: true,
        }),
      () => reports.nowPlayingView(),
      () =>
        reports.startReportExpiry(
          {} as Parameters<typeof reports.startReportExpiry>[0],
        ),
    ]
  ) await assertRejects(call, Error, 'closed');
  assertEquals(writes, 0);
  assertEquals(lookups, 1);
});

for (
  const phase of [
    'copy-allocation',
    'copy-publication',
    'volume-publication',
  ] as const
) {
  Deno.test(`playback close joins held ${phase} and refuses its late mutation`, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let publications = 0;
    const publish = async (change: () => void) => {
      entered.resolve();
      await release.promise;
      change();
      publications++;
    };
    const playback = createPlayback({
      player: createPlayer(),
      nowPlaying: emptyReports(),
      cfg: {},
      library: { getSong: () => Promise.resolve(null) },
      reserveQueueIds: async () => {
        if (phase === 'copy-allocation') {
          entered.resolve();
          await release.promise;
        }
        return 100;
      },
      persistence: {
        saveQueue() {},
        saveState() {},
        changeVolume: publish,
      } as unknown as Parameters<typeof createPlayback>[0]['persistence'],
    });
    const work = phase === 'volume-publication'
      ? playback.setVolume({ volume: 25 })
      : playback.queueImport(
        {
          items: [media],
          currentIndex: null,
          positionMs: 0,
          repeat: 'off',
          consume: false,
        },
        { mode: 'add' },
        undefined,
        phase === 'copy-publication' ? publish : (change) => {
          change();
          publications++;
          return Promise.resolve();
        },
      );
    const result = Promise.allSettled([work]);
    await entered.promise;
    const before = playback.playerView();
    const close = playback.close();
    let closed = false;
    void close.then(() => closed = true);
    await turns();
    const early = closed;
    release.resolve();
    await close;
    assertEquals(early, false);
    assertEquals((await result)[0].status, 'rejected');
    assertEquals(publications, 0);
    assertEquals(playback.queueView().items, []);
    assertEquals(playback.playerView(), before);
  });
}

for (
  const phase of [
    'session-lookup',
    'set',
    'clear',
    'list',
    'expiry-settings',
  ] as const
) {
  Deno.test(`household close joins admitted ${phase} without touching dependencies after return`, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let finished = 0, writes = 0;
    const hold = async () => {
      entered.resolve();
      await release.promise;
      finished++;
    };
    const nowPlaying = {
      ...emptyReports(),
      async set() {
        await hold();
      },
      async clearByStreamId() {
        await hold();
        return false;
      },
      async list() {
        await hold();
        return [];
      },
      reportSession() {
        writes++;
        return Promise.resolve(false);
      },
    };
    const reports = createPlaybackReports({
      nowPlaying,
      serverRows: () => [],
      library: {
        getSong: async () => {
          await hold();
          return { durationMs: 1000 } as SongRow;
        },
      },
    });
    const work = phase === 'session-lookup'
      ? reports.reportSessionPlayback({
        userId: 'admin',
        sessionId: 'session',
        trackId: 'song',
        run: 1,
        sequence: 0,
        state: 'playing',
        positionMs: 0,
        playbackRate: 1,
        ignoreScrobble: true,
      })
      : phase === 'set'
      ? reports.reportPlaying({
        username: 'admin',
        client: 'phone',
        trackId: 'song',
        streamId: 'stream',
      })
      : phase === 'clear'
      ? reports.reportStopped({ streamId: 'stream' })
      : phase === 'list'
      ? reports.nowPlayingView()
      : reports.startReportExpiry(
        {
          declare() {},
          getTyped: async () => {
            await hold();
            return 1;
          },
        } as unknown as Parameters<typeof reports.startReportExpiry>[0],
      );
    const result = Promise.allSettled([work]);
    await entered.promise;
    const close = reports.close();
    let closed = false;
    void close.then(() => closed = true);
    await turns();
    const early = closed;
    release.resolve();
    await close;
    await result;
    assertEquals(early, false);
    assertEquals(finished, 1);
    assertEquals(writes, 0);
    await turns();
    assertEquals(finished, 1);
  });
}
