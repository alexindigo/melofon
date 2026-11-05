import { assert, assertEquals } from '@std/assert';
import { createPlayer, type PlayerPersistence } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';
import { createNotify } from '../src/notify.ts';
import type { Library, SongRow } from '../src/library.ts';
import type { NowPlaying } from '../src/nowplaying.ts';
import { catalogMedia, type QueueMedia } from '../src/queue-source.ts';
import { createOutputs } from '../src/player.ts';
import { createAirplayBoot } from '../src/boots/airplay.ts';
import type { HelperEventFn } from '../src/boots/airplay.ts';
import type { Media } from '../src/media.ts';
import {
  createTestAirplayDevices,
  recordingSpawn,
} from './helpers/airplay-devices.ts';

function web(
  mode: 'live' | 'finite' | 'unknown' = 'finite',
  durationMs: number | null = 1000,
): QueueMedia {
  return {
    reference: { kind: 'url', url: 'http://melofon.home/audio' },
    facts: {
      kind: 'web',
      url: 'http://melofon.home/audio',
      title: 'Audio',
      artistName: null,
      durationMs,
      mode,
      seekable: mode === 'finite',
      streamTitle: null,
      streamUrl: null,
    },
  };
}
const song = (id = 'song', durationMs: number | null = 1000) =>
  catalogMedia({ id, path: '/audio', durationMs } as SongRow);

function fixture(options: {
  resolveQueueReference?: Parameters<
    typeof createPlayback
  >[0]['resolveQueueReference'];
  targets?: Parameters<typeof createPlayback>[0]['targets'];
} = {}) {
  let time = 0;
  const player = createPlayer({ now: () => time, monotonicNow: () => time });
  const events: string[][] = [];
  const states: unknown[] = [];
  const notify = createNotify();
  notify.subscribe((types) => events.push(types));
  const playback = createPlayback({
    player,
    notify,
    cfg: {},
    library: {} as Library,
    nowPlaying: {} as NowPlaying,
    persistence: {
      saveState: (state) => states.push(state),
      saveQueue: (queue, state) => states.push({ queue, state }),
    } satisfies PlayerPersistence,
    ...options,
  });
  const open = () => {
    const view = playback.playerView();
    const token = playback.openSource(view.current!.id, view.generation);
    assert(token);
    return token;
  };
  return {
    playback,
    player,
    events,
    states,
    open,
    at: (value: number) => time = value,
  };
}

Deno.test('broadcast facts follow the private source lease across reopen, discontinuities and terminal callbacks', async () => {
  const f = fixture();
  try {
    await f.playback.queueAddSources([web('live', null), web('live', null)], {
      play: true,
    });
    let token = f.open();
    const initial = f.playback.queueView();
    const command = f.playback.lastCommand();
    assert(
      f.playback.reportSourceMetadata(token, {
        streamTitle: ' raw - title ',
        streamUrl: 'image',
      }),
    );
    assertEquals(
      f.playback.lastCommand(),
      command,
      'observations are not user commands',
    );
    assertEquals(f.playback.queueView().version, initial.version + 1);
    assertEquals(
      initial.items[0].facts,
      web('live', null).facts,
      'old view remains a snapshot',
    );
    assertEquals(f.events.at(-1), ['queue', 'nowPlaying']);
    const writes = f.states.length, events = f.events.length;
    assertEquals(
      f.playback.reportSourceMetadata(token, { streamTitle: ' raw - title ' }),
      false,
    );
    assertEquals(
      f.playback.reportSourceMetadata({ ...token }, { streamTitle: 'forged' }),
      false,
    );
    assertEquals(f.states.length, writes);
    assertEquals(f.events.length, events);
    for (
      const action of ['reopen', 'pause', 'stop', 'next', 'clear'] as const
    ) {
      f.playback.cancelSource(token);
      const cleared = f.playback.queueView();
      const old = cleared.items[0].facts;
      assert(old.kind === 'web');
      assertEquals(old.streamTitle, null);
      assertEquals(old.streamUrl, null);
      assertEquals(
        f.playback.reportSourceMetadata(token, { streamTitle: 'stale' }),
        false,
      );
      if (action === 'clear') {
        f.playback.queueClear();
        break;
      }
      if (action !== 'reopen') {
        const current = f.open();
        assert(
          f.playback.reportSourceMetadata(current, {
            streamTitle: 'before transition',
          }),
        );
        await f.playback[action]();
        assert(current.signal.aborted);
        assertEquals(
          f.playback.reportSourceMetadata(current, { streamTitle: 'late' }),
          false,
        );
        assert(
          f.playback.queueView().items.every((item) =>
            item.facts.kind === 'web' && item.facts.streamTitle === null
          ),
        );
        await f.playback.play();
      }
      token = f.open();
      assert(f.playback.reportSourceMetadata(token, { streamTitle: '' }));
    }
    await f.playback.queueAddSources([web()], { play: true });
    const beforeSeek = f.open();
    assert(
      f.playback.reportSourceMetadata(beforeSeek, {
        streamTitle: 'before seek',
      }),
    );
    await f.playback.seek({ positionMs: 0 });
    assertEquals(
      f.playback.reportSourceMetadata(beforeSeek, { streamTitle: 'late seek' }),
      false,
    );
    const beforeReplay = f.open();
    assert(
      f.playback.reportSourceMetadata(beforeReplay, {
        streamTitle: 'before replay',
      }),
    );
    await f.playback.previous();
    assertEquals(
      f.playback.reportSourceMetadata(beforeReplay, {
        streamTitle: 'late replay',
      }),
      false,
    );
    const finite = f.open();
    assert(f.playback.reportSourceOutcome(finite, 'eof'));
    assertEquals(
      f.playback.reportSourceMetadata(finite, { streamTitle: 'after EOF' }),
      false,
    );
    await f.playback.close();
    assertEquals(
      f.playback.reportSourceMetadata(finite, { streamTitle: 'after close' }),
      false,
    );
  } finally {
    await f.playback.close();
  }
});

Deno.test('source lease starts at the commanded offset despite acquisition delay, and uses progress only after delivery', async () => {
  const f = fixture();
  try {
    await f.playback.queueAddSources([web('finite', 10000)], { play: true });
    f.at(1000);
    const first = f.open();
    assertEquals(first.startMs, 0);
    f.playback.cancelSource(first);
    f.at(1500);
    const beforeDelivery = f.open();
    assertEquals(beforeDelivery.startMs, 0);
    f.playback.sourceAudio(beforeDelivery, 500);
    f.playback.cancelSource(beforeDelivery);
    f.at(2000);
    assertEquals(f.open().startMs, 2000, 'handoff retains current progress');
    await f.playback.seek({ positionMs: 500 });
    f.at(3000);
    assertEquals(
      f.open().startMs,
      500,
      'seek offset excludes later acquisition delay',
    );
    f.playback.pause();
    const frozen = f.playback.playerView().itemProgressMs;
    await f.playback.play();
    f.at(4000);
    assertEquals(
      f.open().startMs,
      frozen,
      'resume excludes speaker preparation delay',
    );
  } finally {
    await f.playback.close();
  }
});

Deno.test('live time advances without a fake length; seek is a no-op and resume opens at live edge', async () => {
  let preparations = 0;
  const f = fixture({
    targets: {
      preparePlayback: () => {
        preparations++;
        return Promise.resolve();
      },
      hasPlaybackTarget: () => true,
    },
  });
  try {
    await f.playback.queueAddSources([web('live', null)], { play: true });
    f.at(5000);
    assertEquals(f.playback.playerView().itemProgressMs, 5000);
    assertEquals(f.playback.playerView().itemLengthMs, 0);
    assertEquals(f.playback.playerView().capabilities, {
      live: true,
      seekable: false,
    });
    const token = f.open();
    const generation = f.playback.playerView().generation;
    assertEquals(await f.playback.seek({ positionMs: 90000 }), true);
    assertEquals(f.playback.playerView().itemProgressMs, 5000);
    assertEquals(f.playback.playerView().generation, generation);
    assertEquals(token.signal.aborted, false);
    assertEquals(preparations, 1);
    await f.playback.advanceEnded();
    assertEquals(f.playback.playerView().state, 'play');
    f.playback.pause();
    assert(token.signal.aborted);
    f.at(7000);
    assertEquals(f.playback.playerView().itemProgressMs, 5000);
    const paused = f.playback.playerView(), events = f.events.length;
    await f.playback.seek({ positionMs: 0 });
    assertEquals(f.playback.playerView(), paused);
    assertEquals(f.events.length, events);
    assertEquals(preparations, 1);
    await f.playback.play();
    assertEquals(f.playback.playerView().itemProgressMs, 0);
    assertEquals(preparations, 2);
    f.playback.stop();
    const stopped = f.playback.playerView();
    await f.playback.seek({ positionMs: 0 });
    assertEquals(f.playback.playerView(), stopped);
    assertEquals(preparations, 2);
  } finally {
    await f.playback.close();
  }
});

Deno.test('finite EOF and the clock share one tail barrier and one persisted consume transition', async () => {
  const f = fixture();
  try {
    const added = await f.playback.queueAddSources([web(), song('next')], {
      play: true,
    });
    f.playback.setConsume(true);
    const token = f.open();
    // Decoder acquisition was late; the engine clock alone would lose the tail.
    f.at(900);
    f.playback.sourceAudio(token, 1000);
    f.at(1000);
    await f.playback.advanceEnded();
    assertEquals(f.playback.playerView().current?.id, added[0].id);
    assertEquals(f.playback.reportSourceOutcome(token, 'eof'), true);
    assertEquals(f.playback.reportSourceOutcome(token, 'decode-error'), false);
    f.at(1899);
    await f.playback.advanceEnded();
    assertEquals(f.playback.playerView().current?.id, added[0].id);
    f.at(1900);
    await Promise.all([f.playback.advanceEnded(), f.playback.advanceEnded()]);
    assertEquals(f.playback.playerView().current?.id, added[1].id);
    assertEquals(f.playback.queueView().items.map((e) => e.id), [added[1].id]);
    const writes = f.states.length, events = f.events.length;
    assertEquals(f.playback.reportSourceOutcome(token, 'eof'), false);
    await f.playback.advanceEnded();
    assertEquals(f.states.length, writes);
    assertEquals(f.events.length, events);
    assert(token.signal.aborted);
  } finally {
    await f.playback.close();
  }
});

Deno.test('library EOF preserves the duration clock, including repeat of the same occurrence', async () => {
  const f = fixture();
  try {
    await f.playback.queueAddSources([song()], { play: true });
    f.playback.setRepeat('single');
    const token = f.open(), generation = f.playback.playerView().generation;
    f.playback.sourceAudio(token, 100);
    assert(f.playback.reportSourceOutcome(token, 'eof'));
    f.at(999);
    await f.playback.advanceEnded();
    assertEquals(f.playback.playerView().generation, generation);
    f.at(1000);
    await f.playback.advanceEnded();
    assert(f.playback.playerView().generation > generation);
    const replay = f.open();
    assert(replay.generation > token.generation);
    assertEquals(f.playback.reportSourceOutcome(token, 'eof'), false);
    assertEquals(f.playback.playerView().itemProgressMs, 0);
    assertEquals(f.playback.playerView().state, 'play');
  } finally {
    await f.playback.close();
  }
});

Deno.test('unknown-length finite EOF can end; unknown-length catalog still cannot clock-end', async () => {
  const f = fixture();
  try {
    const added = await f.playback.queueAddSources([
      web('finite', null),
      song('unknown', null),
    ], { play: true });
    const token = f.open();
    f.playback.sourceAudio(token, 200);
    assert(f.playback.reportSourceOutcome(token, 'eof'));
    f.at(200);
    await f.playback.advanceEnded();
    assertEquals(f.playback.playerView().current?.id, added[1].id);
    const catalog = f.open();
    assert(f.playback.reportSourceOutcome(catalog, 'eof'));
    f.at(10000);
    await f.playback.advanceEnded();
    assertEquals(f.playback.playerView().current?.id, added[1].id);
  } finally {
    await f.playback.close();
  }
});

for (
  const command of [
    'seek',
    'replay',
    'pause',
    'stop',
    'clear',
    'next',
    'reopen',
    'close',
  ] as const
) {
  Deno.test(`source authority rejects terminal callbacks after ${command}`, async () => {
    const f = fixture();
    try {
      await f.playback.queueAddSources([song(), song('next')], { play: true });
      const token = f.open();
      if (command === 'seek') await f.playback.seek({ positionMs: 0 });
      else if (command === 'replay') f.player.play(0);
      else if (command === 'clear') f.playback.queueClear();
      else if (command === 'reopen') {
        f.playback.cancelSource(token);
        const replacement = f.open();
        assert(replacement.generation > token.generation);
      } else await f.playback[command]();
      assert(token.signal.aborted);
      const view = f.playback.playerView();
      const states = f.states.length, events = f.events.length;
      assertEquals(f.playback.reportSourceOutcome(token, 'eof'), false);
      assertEquals(
        f.playback.reportSourceOutcome(token, 'transport-error'),
        false,
      );
      f.playback.sourceAudio(token, 100000);
      assertEquals(f.playback.playerView(), view);
      assertEquals(f.states.length, states);
      assertEquals(f.events.length, events);
    } finally {
      await f.playback.close();
    }
  });
}

for (const reason of ['eof', 'transport-error', 'decode-error'] as const) {
  Deno.test(`a live ${reason} is a single source failure, not a natural next`, async () => {
    const f = fixture();
    try {
      const added = await f.playback.queueAddSources([
        web('live', null),
        song(),
      ], { play: true });
      const token = f.open();
      const events = f.events.length, writes = f.states.length;
      assertEquals(
        f.playback.openSource(
          token.entryId,
          f.playback.playerView().generation,
        ),
        null,
        'no second sink authority',
      );
      assert(f.playback.reportSourceOutcome(token, reason));
      assertEquals(f.playback.reportSourceOutcome(token, reason), false);
      await f.playback.advanceEnded();
      assertEquals(f.playback.playerView().state, 'pause');
      assertEquals(f.playback.playerView().current?.id, added[0].id);
      assertEquals(f.events.length, events + 1);
      assertEquals(f.states.length, writes + 1);
    } finally {
      await f.playback.close();
    }
  });
}

Deno.test('clear cancels a source EOF transition parked in next-station resolution', async () => {
  let resolve!: (media: QueueMedia | null) => void;
  const waiting = new Promise<QueueMedia | null>((done) => resolve = done);
  const f = fixture({ resolveQueueReference: () => waiting });
  try {
    await f.playback.queueAddSources([
      web(),
      {
        ...web('live', null),
        reference: { kind: 'station', id: 'station' },
      } as QueueMedia,
    ], { play: true });
    const token = f.open();
    assert(f.playback.reportSourceOutcome(token, 'eof'));
    const transition = f.playback.advanceEnded();
    f.playback.queueClear();
    resolve(web('live', null));
    await transition;
    assertEquals(f.playback.playerView().state, 'stop');
    assertEquals(f.playback.queueView().items, []);
  } finally {
    resolve(null);
    await f.playback.close();
  }
});

Deno.test('two-sink boot fences stale decoder EOF after a same-position seek', async () => {
  let time = 0;
  const notify = createNotify();
  const player = createPlayer({ now: () => time, monotonicNow: () => time });
  const playback = createPlayback({
    player,
    notify,
    cfg: {},
    library: {} as Library,
    nowPlaying: {} as NowPlaying,
  });
  const outputs = createOutputs({ notify });
  const transports: { event: HelperEventFn; writes: number }[] = [];
  const devices = createTestAirplayDevices(
    outputs,
    recordingSpawn((event) => {
      const transport = { event, writes: 0 };
      transports.push(transport);
      return {
        send: () => Promise.resolve(),
        pcm: () => {
          transport.writes++;
          return Promise.resolve();
        },
        ownsSharedFeed: () => false,
        cancelPcm() {},
        close: () => Promise.resolve(),
      };
    }),
  );
  const ends: (() => void)[] = [];
  let finished = 0;
  const boot = createAirplayBoot({
    playback,
    outputs,
    notify,
    devices,
    retryBackoffMs: [],
    media: {
      decodePcm() {
        const end = new Promise<void>((resolve) => ends.push(resolve));
        return Promise.resolve((async function* () {
          try {
            yield new Uint8Array(1764);
            await end;
          } finally {
            finished++;
          }
        })());
      },
    } as unknown as Media,
  });
  const until = async (predicate: () => boolean) => {
    const deadline = performance.now() + 5000;
    while (!predicate()) {
      assert(performance.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };
  try {
    for (const id of ['1', '2']) {
      outputs.register({
        id,
        name: id,
        type: 'AirPlay',
        host: `192.0.2.${id}`,
        selected: true,
        volume: 100,
        connectionStrategy: 'owntone',
      });
    }
    const added = await playback.queueAddSources([song(), song('next')], {
      play: true,
    });
    await until(() => transports.length === 2);
    for (const transport of transports) transport.event('state', 'connected');
    await until(() => transports.reduce((n, t) => n + t.writes, 0) === 1);
    assertEquals(ends.length, 1);
    await playback.seek({ positionMs: 0 });
    await until(() => transports.reduce((n, t) => n + t.writes, 0) === 2);
    assertEquals(
      ends.length,
      2,
      'one new source even though the position did not jump',
    );
    ends[0]();
    await until(() => finished === 1);
    time = 10000;
    await playback.advanceEnded();
    assertEquals(
      playback.playerView().current?.id,
      added[0].id,
      'stale EOF cannot authorize the current pending decoder',
    );
    ends[1]();
    await until(() => finished === 2);
    await playback.advanceEnded();
    assertEquals(playback.playerView().current?.id, added[1].id);
    assertEquals(
      transports.length,
      2,
      'sink sessions are retained across the source transition',
    );
  } finally {
    // Unpark every owned generator, including a next-item pump begun by the tick.
    for (const end of ends) end();
    await boot.close();
    devices.close();
    await playback.close();
  }
});
