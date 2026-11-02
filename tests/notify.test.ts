// tests/notify.test.ts — app.notify hub semantics and the player/outputs
// emit map (OwnTone event names). No HTTP: the hub is in-process pub/sub;
// the WS transport is the hat's (tests/owntone-ws.test.ts).
import { assertEquals, assertRejects, assertStrictEquals } from '@std/assert';
import {
  createNotify,
  type Notify,
  type NotifyAudience,
} from '../src/notify.ts';
import { createOutputs, createPlayer } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';
import type { SongRow } from '../src/library.ts';

function recorder(): { notify: Notify; events: string[][] } {
  const events: string[][] = [];
  const notify = createNotify();
  notify.subscribe((types) => events.push(types));
  return { notify, events };
}

let songN = 0;
function song(): SongRow {
  songN++;
  return {
    id: `hash-${songN}`,
    path: `/music/song-${songN}.mp3`,
    fileName: `song-${songN}`,
    libraryId: null,
    libraryPath: null,
    title: `Song ${songN}`,
    albumId: null,
    albumName: null,
    albumFolderName: null,
    artistId: null,
    artistName: 'Artist',
    track: songN,
    disc: 1,
    durationMs: 180_000,
    size: 1,
    genre: null,
    year: null,
    firstSeenMs: null,
    isVideo: false,
    suffix: 'mp3',
    contentType: 'audio/mpeg',
  };
}

const SPEAKER = {
  id: '0',
  name: 'test speaker',
  type: 'AirPlay',
  selected: true,
  volume: 100,
};

Deno.test('hub: subscribe/emit, unsubscribe, unknown names dropped', () => {
  const notify = createNotify();
  const a: string[][] = [];
  const b: string[][] = [];
  const unsubA = notify.subscribe((types) => a.push(types));
  notify.subscribe((types) => b.push(types));

  notify.emit(['player', 'queue'], undefined, 'all');
  assertEquals(a, [['player', 'queue']]);
  assertEquals(b, [['player', 'queue']]);

  unsubA();
  notify.emit(['volume'], undefined, 'all');
  assertEquals(a.length, 1);
  assertEquals(b, [['player', 'queue'], ['volume']]);

  // Unknown names are dropped at emit; nothing known → no call at all.
  notify.emit(['bogus', 'queue'], undefined, 'all');
  assertEquals(b, [['player', 'queue'], ['volume'], ['queue']]);
  notify.emit(['nonsense'], undefined, 'all');
  assertEquals(b.length, 3);
});

Deno.test('hub: a throwing listener breaks neither the emitter nor others', () => {
  const notify = createNotify();
  const seen: string[][] = [];
  notify.subscribe(() => {
    throw new Error('closing socket');
  });
  notify.subscribe((types) => seen.push(types));
  notify.emit(['player'], undefined, 'all');
  assertEquals(seen, [['player']]);
});

Deno.test('hub: audiences and keys reach subscribers unchanged after a listener throws', () => {
  const notify = createNotify();
  const keys = { player: ['changed-id'] };
  const audiences: NotifyAudience[] = ['all', 'admins', { userId: 'alice' }];
  const seen: {
    keys: Record<string, string[]> | undefined;
    audience: NotifyAudience;
  }[] = [];
  notify.subscribe(() => {
    throw new Error('broken listener');
  });
  notify.subscribe((_names, keys, audience) => seen.push({ keys, audience }));
  for (const audience of audiences) notify.emit(['player'], keys, audience);
  assertEquals(seen.length, audiences.length);
  for (const [index, event] of seen.entries()) {
    assertStrictEquals(event.keys, keys);
    assertStrictEquals(event.audience, audiences[index]);
  }
  notify.emit(['queue'], undefined, 'all');
  assertEquals(seen.at(-1), { keys: undefined, audience: 'all' });
});

Deno.test('playback commands emit: engine → player/options/volume/queue', () => {
  const { notify, events } = recorder();
  const player = createPlayer();
  const playback = createPlayback({
    player,
    nowPlaying: {
      set: () => Promise.resolve(),
      report: () => Promise.resolve(),
      clearByStreamId: () => Promise.resolve(true),
      list: () => Promise.resolve([]),
      expire: () => Promise.resolve(false),
      reportSession: () => Promise.resolve(false),
    },
    library: {} as never, // views under test here don't touch the library
    cfg: {},
    notify,
  });

  playback.play(); // empty queue: engine no-op, but the command fired
  playback.queueAdd([song(), song()]);
  assertEquals(events, [['player'], ['queue']]);

  events.length = 0;
  playback.play();
  playback.pause();
  playback.toggle();
  playback.toggle();
  playback.next();
  playback.previous();
  playback.stop();
  assertEquals(events, [
    ['player', 'nowPlaying'],
    ['player', 'nowPlaying'],
    ['player', 'nowPlaying'],
    ['player', 'nowPlaying'],
    ['player', 'nowPlaying'],
    ['player', 'nowPlaying'],
    ['player', 'nowPlaying'],
  ]);

  events.length = 0;
  playback.setShuffle(true);
  playback.setRepeat('all');
  playback.setConsume(true);
  assertEquals(events, [['options'], ['options'], ['options']]);

  events.length = 0;
  playback.setVolume({ volume: 70 });
  playback.setVolume({ step: -5 });
  playback.setVolume({}); // neither knob: no-op, no emit
  assertEquals(events, [['volume'], ['volume']]);

  events.length = 0;
  playback.seek({ positionMs: 1000 });
  assertEquals(events, [['player', 'nowPlaying']]);

  // queueClear stops the engine too — both reads changed.
  events.length = 0;
  playback.queueClear();
  assertEquals(events, [['queue', 'player', 'nowPlaying']]);
});

Deno.test('outputs emit: outputs on every mutation, volume along when per-output volume changes', () => {
  const { notify, events } = recorder();
  const outputs = createOutputs({ notify });

  outputs.register(SPEAKER);
  assertEquals(events, [['outputs']]);

  outputs.update('0', { volume: 42 });
  assertEquals(events, [['outputs'], ['outputs', 'volume']]);

  outputs.update('0', { selected: false });
  outputs.toggle('0');
  outputs.setEnabled(['0']);
  assertEquals(events.slice(2), [['outputs'], ['outputs'], ['outputs']]);

  // Failed mutations emit nothing.
  events.length = 0;
  outputs.update('nope', { volume: 1 });
  outputs.toggle('nope');
  outputs.setEnabled(['nope']);
  outputs.unregister('nope');
  assertEquals(events, []);

  outputs.unregister('0');
  assertEquals(events, [['outputs']]);
});

Deno.test('household invalidations follow selected speaker facts and commander independently; close unsubscribes', () => {
  const { notify } = recorder();
  const outputs = createOutputs({ notify });
  const playback = createPlayback({
    player: createPlayer(),
    outputs,
    nowPlaying: {
      set: () => Promise.resolve(),
      report: () => Promise.resolve(),
      clearByStreamId: () => Promise.resolve(false),
      list: () => Promise.resolve([]),
      expire: () => Promise.resolve(false),
      reportSession: () => Promise.resolve(false),
    },
    library: {} as never,
    cfg: {},
    notify,
  });
  const changes: { keys: unknown; audience: NotifyAudience }[] = [];
  notify.subscribe((types, keys, audience) => {
    if (types.includes('nowPlaying')) changes.push({ keys, audience });
  });
  const check = (action: () => void, count: number) => {
    changes.length = 0;
    action();
    assertEquals(
      changes,
      Array.from({ length: count }, () => ({
        keys: undefined,
        audience: 'all',
      })),
    );
  };
  try {
    check(() => outputs.register(SPEAKER), 0); // No server row while stopped.
    check(() => playback.queueAdd([song()], { play: true }), 1);
    check(() => outputs.update('0', { volume: 42, needsAuthKey: true }), 0);
    check(() => outputs.register({ ...SPEAKER, name: 'Renamed' }), 1);
    check(() => outputs.register({ ...SPEAKER, name: 'Renamed' }), 0);
    check(() => outputs.update('0', { selected: false }), 1);
    check(() => outputs.update('0', { selected: false }), 0);
    check(() => outputs.toggle('0'), 1);
    check(() => outputs.setEnabled([]), 1);
    check(() => outputs.setEnabled(['0']), 1);
    check(() => outputs.unregister('0'), 1);
    check(() => outputs.unregister('0'), 0);
    check(() => outputs.setEnabled(['missing']), 0);
    for (
      const action of [
        () =>
          playback.setVolume({ volume: 42 }, { kind: 'http', user: 'alice' }),
        () => playback.setShuffle(true, { kind: 'http', user: 'bob' }),
        () => playback.setConsume(true, { kind: 'http', user: 'alice' }),
        () => playback.setRepeat('all', { kind: 'http', user: 'bob' }),
        () => playback.queueAdd([], {}, { kind: 'http', user: 'alice' }),
      ]
    ) check(action, 1);
    check(() => playback.setVolume({ volume: 40 }), 0); // Internal retains attribution.
    check(() => playback.setVolume({ volume: 41 }, { kind: 'http' }), 1);
    check(() => playback.playerView(), 0); // Reading/extrapolation emits nothing.
    check(() => playback.stop(), 1);
    check(() => outputs.register(SPEAKER), 0);
    check(() => playback.play(), 1);
    playback.close();
    check(() => outputs.toggle('0'), 0);
  } finally {
    playback.close();
  }
});

Deno.test('playback expiry emits only after success, shares in-flight work and close drains it', async () => {
  const { notify, events } = recorder();
  let calls = 0;
  let release!: (changed: boolean) => void;
  const playback = createPlayback({
    player: createPlayer(),
    library: {} as never,
    cfg: {},
    notify,
    nowPlaying: {
      set: () => Promise.resolve(),
      report: () => Promise.resolve(),
      clearByStreamId: () => Promise.resolve(false),
      list: () => Promise.resolve([]),
      reportSession: () => Promise.resolve(false),
      expire: () => {
        calls++;
        if (calls === 1) {
          return Promise.reject(new Error('injected expiry failure'));
        }
        return new Promise<boolean>((resolve) => {
          release = resolve;
        });
      },
    },
  });
  await assertRejects(() => playback.expireReports(), Error, 'injected');
  assertEquals(events, []);
  const first = playback.expireReports();
  const second = playback.expireReports();
  assertStrictEquals(first, second);
  assertEquals(calls, 2);
  assertEquals(events, []);
  let closed = false;
  const close = playback.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assertEquals(closed, false);
  release(true);
  assertEquals(await first, true);
  await close;
  assertEquals(events, [['nowPlaying']]);
  assertEquals(await playback.expireReports(), false);
  assertEquals(calls, 2, 'no work starts after close');
});

Deno.test('player/outputs without a hub: mutations work, nothing throws', () => {
  const player = createPlayer();
  const outputs = createOutputs();
  player.queueAdd([song()]);
  player.play();
  player.setVolume({ volume: 10 });
  outputs.register(SPEAKER);
  outputs.update('0', { selected: false });
  assertEquals(player.status().state, 'play');
  assertEquals(outputs.get('0')?.selected, false);
});
