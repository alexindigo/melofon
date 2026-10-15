// tests/notify.test.ts — app.notify hub semantics and the player/outputs
// emit map (OwnTone event names). No HTTP: the hub is in-process pub/sub;
// the WS transport is the hat's (tests/owntone-ws.test.ts).
import { assertEquals } from '@std/assert';
import { createNotify, type Notify } from '../src/notify.ts';
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
    libraryId: null,
    libraryPath: null,
    title: `Song ${songN}`,
    albumId: null,
    albumName: null,
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

  notify.emit(['player', 'queue']);
  assertEquals(a, [['player', 'queue']]);
  assertEquals(b, [['player', 'queue']]);

  unsubA();
  notify.emit(['volume']);
  assertEquals(a.length, 1);
  assertEquals(b, [['player', 'queue'], ['volume']]);

  // Unknown names are dropped at emit; nothing known → no call at all.
  notify.emit(['bogus', 'queue']);
  assertEquals(b, [['player', 'queue'], ['volume'], ['queue']]);
  notify.emit(['nonsense']);
  assertEquals(b.length, 3);
});

Deno.test('hub: a throwing listener breaks neither the emitter nor others', () => {
  const notify = createNotify();
  const seen: string[][] = [];
  notify.subscribe(() => {
    throw new Error('closing socket');
  });
  notify.subscribe((types) => seen.push(types));
  notify.emit(['player']);
  assertEquals(seen, [['player']]);
});

Deno.test('playback commands emit: engine → player/options/volume/queue', () => {
  const { notify, events } = recorder();
  const player = createPlayer();
  const playback = createPlayback({
    player,
    nowPlaying: {
      set: () => Promise.resolve(),
      clearByStreamId: () => Promise.resolve(true),
      list: () => Promise.resolve([]),
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
    ['player'],
    ['player'],
    ['player'],
    ['player'],
    ['player'],
    ['player'],
    ['player'],
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
  assertEquals(events, [['player']]);

  // queueClear stops the engine too — both reads changed.
  events.length = 0;
  playback.queueClear();
  assertEquals(events, [['queue', 'player']]);
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
