// tests/track-end.test.ts — end-of-item semantics (plan airplay-silence):
// progress reaching item length ENDS the item — repeat off stops past the
// last (current null on stop), single replays, all wraps, consume drops the
// finished item — and the playback core emits player (+queue on consume).
// advanceEnded is driven directly here; main.ts drives it on an interval.
import { assert, assertEquals } from '@std/assert';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createNotify } from '../src/notify.ts';
import { openStore } from '../src/store/index.ts';
import { createLibrary, type SongRow } from '../src/library.ts';
import { createPlayer } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';
import { queueSong } from '../src/queue-source.ts';

let songN = 0;
function song(durationMs: number | null = 1): SongRow {
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

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-te-' });
  const store = await openStore(dir);
  const db = store;
  const events: string[][] = [];
  const notify = createNotify();
  notify.subscribe((types) => events.push(types));
  const player = createPlayer();
  const library = createLibrary(store);
  const playback = createPlayback({
    player,
    nowPlaying: createNowPlaying(store),
    library,
    cfg: {},
    notify,
  });
  return {
    player,
    playback,
    events,
    close: async () => {
      await db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

/** Wall-clock progress needs no wait with 1 ms items — the tick is a call. */
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.test('repeat off: advances through the queue, stops past the last (current null)', async () => {
  const { player, playback, events, close } = await setup();
  try {
    const a = song();
    const b = song();
    playback.queueAdd([a, b], { play: true });
    assertEquals(queueSong(player.status().current)?.id, a.id);

    await tick();
    playback.advanceEnded();
    assertEquals(queueSong(player.status().current)?.id, b.id);
    assertEquals(player.status().state, 'play');

    await tick();
    playback.advanceEnded();
    const status = player.status();
    assertEquals(status.state, 'stop');
    assertEquals(status.current, null);
    assertEquals(status.itemProgressMs, 0);
    assertEquals(status.itemLengthMs, 0);

    // Emissions: queueAdd (queue+player), advance (player), stop (player).
    assertEquals(events.length, 3);
    assertEquals(events[1], ['player', 'nowPlaying']);
    assertEquals(events[2], ['player', 'nowPlaying']);
  } finally {
    await close();
  }
});

Deno.test('repeat single replays the same item forever', async () => {
  const { player, playback, close } = await setup();
  try {
    const a = song();
    playback.queueAdd([a], { play: true });
    playback.setRepeat('single');
    await tick();
    playback.advanceEnded();
    const status = player.status();
    assertEquals(status.state, 'play');
    assertEquals(queueSong(status.current)?.id, a.id);
    // The clock reset: progress is near zero again, not at the length.
    assert(status.itemProgressMs < 50);
    // And it never advances out of the item.
    await tick();
    playback.advanceEnded();
    assertEquals(queueSong(player.status().current)?.id, a.id);
  } finally {
    await close();
  }
});

Deno.test('repeat all wraps to the head past the last item', async () => {
  const { player, playback, close } = await setup();
  try {
    const a = song();
    const b = song();
    playback.queueAdd([a, b], { play: true });
    playback.setRepeat('all');
    await tick();
    playback.advanceEnded();
    assertEquals(queueSong(player.status().current)?.id, b.id);
    await tick();
    playback.advanceEnded();
    assertEquals(queueSong(player.status().current)?.id, a.id);
    assertEquals(player.status().state, 'play');
  } finally {
    await close();
  }
});

Deno.test('consume drops the finished item; queue+player emit; empty queue stops', async () => {
  const { player, playback, events, close } = await setup();
  try {
    const a = song();
    const b = song();
    playback.queueAdd([a, b], { play: true });
    playback.setConsume(true);
    const versionBefore = player.queue().version;

    await tick();
    playback.advanceEnded();
    const queue = player.queue();
    assertEquals(queue.items.length, 1);
    assertEquals(queueSong(queue.items[0])?.id, b.id);
    assert(queue.version > versionBefore);
    assertEquals(queueSong(player.status().current)?.id, b.id);
    assertEquals(events[events.length - 1], ['queue', 'player', 'nowPlaying']);

    await tick();
    playback.advanceEnded();
    assertEquals(player.queue().items.length, 0);
    const status = player.status();
    assertEquals(status.state, 'stop');
    assertEquals(status.current, null);
  } finally {
    await close();
  }
});

Deno.test('no transition while paused, stopped, or length unknown', async () => {
  const { player, playback, close } = await setup();
  try {
    const a = song();
    playback.queueAdd([a], { play: true });
    playback.pause();
    await tick();
    playback.advanceEnded();
    assertEquals(player.status().state, 'pause');
    assertEquals(queueSong(player.status().current)?.id, a.id);

    playback.play();
    playback.stop();
    playback.advanceEnded();
    assertEquals(player.status().state, 'pause');

    // Unknown length never ends.
    const b = song(null);
    playback.queueAdd([b], { play: true });
    await tick();
    playback.advanceEnded();
    assertEquals(player.status().state, 'play');
    assertEquals(queueSong(player.status().current)?.id, b.id);
  } finally {
    await close();
  }
});
