// tests/player.test.ts — app.player / app.outputs engine semantics, no HTTP:
// empty-queue play stays stopped, state transitions, wall-clock progress,
// seek clamping, volume clamping, queue versioning, dummy fifo output CRUD.
import { assert, assertEquals } from '@std/assert';
import { createOutputs, createPlayer } from '../src/player.ts';
import type { SongRow } from '../src/library.ts';

let songN = 0;
function song(durationMs = 180_000): SongRow {
  songN++;
  return {
    id: `hash-${songN}`,
    path: `/music/song-${songN}.mp3`,
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
    durationMs,
    size: 1,
    genre: null,
    year: null,
    firstSeenMs: null,
    isVideo: false,
    suffix: 'mp3',
    contentType: 'audio/mpeg',
  };
}

Deno.test('initial state: stopped, empty queue, no outputs', () => {
  const player = createPlayer();
  const status = player.status();
  assertEquals(status.state, 'stop');
  assertEquals(status.repeat, 'off');
  assertEquals(status.consume, false);
  assertEquals(status.shuffle, false);
  assertEquals(status.current, null);
  assertEquals(status.itemLengthMs, 0);
  assertEquals(status.itemProgressMs, 0);
  assertEquals(player.queue(), { version: 0, items: [] });

  // No dummy sink: the outputs list is empty until a boot registers.
  const outputs = createOutputs();
  assertEquals(outputs.list(), []);
  assertEquals(outputs.get('0'), null);
  assertEquals(outputs.setEnabled([]), true); // no unknown ids on an empty list
  assertEquals(outputs.setEnabled(['0']), false);
});

Deno.test('play on an empty queue is a no-op (state stays stop)', () => {
  const player = createPlayer();
  player.play();
  assertEquals(player.status().state, 'stop');
  player.toggle();
  assertEquals(player.status().state, 'stop');
});

Deno.test('queue add appends with monotonic ids and bumps the version', () => {
  const player = createPlayer();
  const added = player.queueAdd([song(), song()]);
  assertEquals(added.map((e) => e.id), [1, 2]);
  assertEquals(player.queue().version, 1);
  const more = player.queueAdd([song()]);
  assertEquals(more.map((e) => e.id), [3]);
  assertEquals(player.queue().version, 2);
  assertEquals(player.queue().items.length, 3);
});

Deno.test('play/pause/toggle/stop transitions; stop clears current', () => {
  const player = createPlayer();
  player.queueAdd([song(1000), song(2000)]);

  // Stopped from the start: no current, no length (no queue-head fallback).
  let status = player.status();
  assertEquals(status.state, 'stop');
  assertEquals(status.current, null);
  assertEquals(status.itemLengthMs, 0);
  assertEquals(status.itemProgressMs, 0);

  player.play();
  status = player.status();
  assertEquals(status.state, 'play');
  assertEquals(status.current?.id, 1);

  player.pause();
  assertEquals(player.status().state, 'pause');
  const frozen = player.status().itemProgressMs;

  player.toggle();
  assertEquals(player.status().state, 'play');
  player.toggle();
  assertEquals(player.status().state, 'pause');
  assertEquals(player.status().itemProgressMs, frozen);

  player.stop();
  status = player.status();
  assertEquals(status.state, 'stop');
  assertEquals(status.current, null);
  assertEquals(status.itemProgressMs, 0);

  // Play after stop restarts the queue head.
  player.play();
  assertEquals(player.status().current?.id, 1);
});

Deno.test('progress is wall-clock while playing and clamped at the length', async () => {
  const player = createPlayer();
  player.queueAdd([song(50)]);
  player.play();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const status = player.status();
  assert(
    status.itemProgressMs > 0,
    `progress advanced: ${status.itemProgressMs}`,
  );
  assertEquals(status.itemProgressMs, 50); // clamped at the item length
});

Deno.test('next/previous move and start playback; next past the end stops', () => {
  const player = createPlayer();
  player.queueAdd([song(), song()]);
  player.play();
  player.next();
  assertEquals(player.status().current?.id, 2);
  assertEquals(player.status().state, 'play');
  player.previous();
  assertEquals(player.status().current?.id, 1);
  player.previous(); // at the head: restarts the same item
  assertEquals(player.status().current?.id, 1);
  player.next();
  player.next(); // past the end
  assertEquals(player.status().state, 'stop');
});

Deno.test('seek: absolute and relative, clamped, starts playback; false with no current', () => {
  const player = createPlayer();
  assertEquals(player.seek({ positionMs: 100 }), false); // empty queue

  player.queueAdd([song(10_000)]);
  assertEquals(player.seek({ positionMs: 4000 }), true);
  let status = player.status();
  assertEquals(status.state, 'play');
  assert(status.itemProgressMs >= 4000);

  assertEquals(player.seek({ seekMs: -2000 }), true);
  status = player.status();
  assert(status.itemProgressMs >= 2000 && status.itemProgressMs < 4000);

  player.seek({ positionMs: 999_999 }); // clamped at the length
  assertEquals(player.status().itemProgressMs, 10_000);
  player.seek({ seekMs: -999_999 }); // clamped at 0
  assertEquals(player.status().itemProgressMs, 0);
});

Deno.test('volume: absolute wins over step, clamped 0..100', () => {
  const player = createPlayer();
  assertEquals(player.status().volume, 50);
  player.setVolume({ volume: 80 });
  assertEquals(player.status().volume, 80);
  player.setVolume({ step: 50 });
  assertEquals(player.status().volume, 100);
  player.setVolume({ step: -150 });
  assertEquals(player.status().volume, 0);
  player.setVolume({ volume: 30, step: 99 });
  assertEquals(player.status().volume, 30);
});

Deno.test('modes are stored and reported', () => {
  const player = createPlayer();
  player.setShuffle(true);
  player.setConsume(true);
  player.setRepeat('all');
  const status = player.status();
  assertEquals(status.shuffle, true);
  assertEquals(status.consume, true);
  assertEquals(status.repeat, 'all');
});

Deno.test('queue clear empties, stops, and bumps the version', () => {
  const player = createPlayer();
  player.queueAdd([song(), song()]);
  player.play();
  player.queueClear();
  assertEquals(player.queue().items.length, 0);
  assertEquals(player.queue().version, 2);
  const status = player.status();
  assertEquals(status.state, 'stop');
  assertEquals(status.current, null);
});

Deno.test('outputs: register, get/update/toggle/setEnabled, unregister', () => {
  const outputs = createOutputs();
  outputs.register({
    id: '0',
    name: 'test speaker',
    type: 'AirPlay',
    selected: true,
    volume: 100,
  });
  assertEquals(outputs.get('0')?.type, 'AirPlay');
  assertEquals(outputs.get('nope'), null);

  // Register is last-wins on the id.
  outputs.register({
    id: '0',
    name: 'renamed speaker',
    type: 'AirPlay',
    selected: true,
    volume: 100,
  });
  assertEquals(outputs.list().length, 1);
  assertEquals(outputs.get('0')?.name, 'renamed speaker');

  assertEquals(outputs.update('0', { volume: 42 })?.volume, 42);
  assertEquals(outputs.update('0', { volume: 500 })?.volume, 100);
  assertEquals(outputs.update('nope', { volume: 1 }), null);

  assertEquals(outputs.toggle('0')?.selected, false);
  assertEquals(outputs.toggle('0')?.selected, true);
  assertEquals(outputs.toggle('nope'), null);

  assertEquals(outputs.setEnabled(['nope']), false);
  assertEquals(outputs.get('0')?.selected, true); // unchanged on failure
  assertEquals(outputs.setEnabled([]), true);
  assertEquals(outputs.get('0')?.selected, false);
  assertEquals(outputs.setEnabled(['0']), true);
  assertEquals(outputs.get('0')?.selected, true);

  // Unregister returns to the empty truth.
  assertEquals(outputs.unregister('0'), true);
  assertEquals(outputs.list(), []);
  assertEquals(outputs.unregister('0'), false);
});
