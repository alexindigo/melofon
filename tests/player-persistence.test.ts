// tests/player-persistence.test.ts — restart transparency (plan
// restart-transparency): the queue, player state, and position survive a
// restart (drain, reopen, restore); auto-resume plays only inside the
// freshness window with the environment still matching, else pauses at the
// saved place; missing tracks drop and the current index remaps; the 1 Hz
// tick keeps position_ms current while playing and stops when paused.
import { assert, assertEquals } from '@std/assert';
import { openDb } from '../src/db.ts';
import { createLibrary, type SongRow } from '../src/library.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createPersistence } from '../src/persistence.ts';
import { createPlayer, planRestore, shouldAutoResume } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';

let songN = 0;
function song(durationMs: number | null = 180_000): SongRow {
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
    durationMs,
    size: 1,
    genre: null,
    year: null,
    isVideo: false,
    suffix: 'mp3',
    contentType: 'audio/mpeg',
  };
}

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-persist-' });
  const db = await openDb(dir);
  const persistence = createPersistence(db);
  const player = createPlayer();
  const playback = createPlayback({
    player,
    nowPlaying: createNowPlaying(db),
    library: createLibrary(db),
    cfg: {},
    persistence,
  });
  return {
    dir,
    db,
    persistence,
    player,
    playback,
    close: async (keep = false) => {
      playback.close();
      db.close();
      if (!keep) await Deno.remove(dir, { recursive: true });
    },
  };
}

/** Reopen the same data dir: a fresh db handle + store, like a restart. */
async function reopen(dir: string) {
  const db = await openDb(dir);
  const persistence = createPersistence(db);
  return {
    db,
    persistence,
    close: async () => {
      db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('shouldAutoResume: fresh play resumes, anything else pauses', () => {
  const base = {
    savedState: 'play' as const,
    updatedAtMs: 10_000,
    nowMs: 12_000,
    maxAgeMs: 5_000,
    currentTrackPresent: true,
    selectedOutputPresent: true,
  };
  assertEquals(shouldAutoResume(base), true, 'fresh play resumes');
  assertEquals(
    shouldAutoResume({ ...base, nowMs: 16_001 }),
    false,
    'older than the window pauses',
  );
  assertEquals(
    shouldAutoResume({ ...base, nowMs: 4_999 }),
    false,
    'wall clock jumped (updated_at in the future) pauses',
  );
  assertEquals(
    shouldAutoResume({ ...base, currentTrackPresent: false }),
    false,
    'current track gone pauses',
  );
  assertEquals(
    shouldAutoResume({ ...base, selectedOutputPresent: false }),
    false,
    'no saved-selected output pauses',
  );
  assertEquals(
    shouldAutoResume({ ...base, savedState: 'pause' }),
    false,
    'a paused save stays paused',
  );
  assertEquals(
    shouldAutoResume({ ...base, savedState: 'stop' }),
    false,
    'a stopped save stays stopped',
  );
});

Deno.test('queue, state, and position survive a restart', async () => {
  const { dir, persistence, playback, close } = await setup();
  const songs = [song(), song(), song()];
  playback.queueAdd(songs, { play: true, playbackFromPosition: 1 });
  playback.seek({ positionMs: 4000 });
  playback.setRepeat('all');
  playback.setShuffle(true);
  await persistence.drain();
  await close(true); // keep the dir — the "restart" reopens it

  const restarted = await reopen(dir);
  try {
    assertEquals(
      await restarted.persistence.loadQueue(),
      songs.map((s) => s.id),
      'queue ids in order',
    );
    const saved = await restarted.persistence.loadPlayerState();
    assert(saved !== null, 'state row persisted');
    assertEquals(saved.state, 'play');
    assertEquals(saved.currentIndex, 1);
    assert(saved.positionMs >= 4000, `position saved: ${saved.positionMs}`);
    assertEquals(saved.repeat, 'all');
    assertEquals(saved.shuffle, true);
    assertEquals(saved.consume, false);
    assert(
      Date.now() - saved.updatedAtMs < 10_000,
      `updated_at is fresh: ${saved.updatedAtMs}`,
    );

    // The boot path: rehydrate, decide (fresh + environment matches), load.
    const snapshot = await planRestore({
      queueIds: await restarted.persistence.loadQueue(),
      saved,
      getSong: (id) => Promise.resolve(songs.find((s) => s.id === id) ?? null),
      nowMs: Date.now(),
      maxAgeMs: 300_000,
      selectedOutputPresent: true,
    });
    assert(snapshot !== null);
    assertEquals(snapshot.state, 'play', 'fresh save resumes play');
    assertEquals(snapshot.currentIndex, 1);
    assert(snapshot.positionMs >= 4000);

    const player2 = createPlayer();
    player2.restore(snapshot);
    const status = player2.status();
    assertEquals(status.state, 'play');
    assertEquals(status.current?.song.id, songs[1].id);
    assert(status.itemProgressMs >= 4000);
    assertEquals(status.repeat, 'all');
    assertEquals(status.shuffle, true);
    assertEquals(
      player2.queue().items.map((e) => e.song.id),
      songs.map((s) => s.id),
    );
  } finally {
    await restarted.close();
  }
});

Deno.test('a stale save restores paused at the saved place', async () => {
  const { dir, persistence, playback, close } = await setup();
  const songs = [song(), song()];
  playback.queueAdd(songs, { play: true });
  playback.seek({ positionMs: 5000 });
  await persistence.drain();
  await close(true);

  const restarted = await reopen(dir);
  try {
    const saved = await restarted.persistence.loadPlayerState();
    assert(saved !== null);
    const snapshot = await planRestore({
      queueIds: await restarted.persistence.loadQueue(),
      saved,
      getSong: (id) => Promise.resolve(songs.find((s) => s.id === id) ?? null),
      // Past the 300 s freshness window: the save is stale.
      nowMs: saved.updatedAtMs + 301_000,
      maxAgeMs: 300_000,
      selectedOutputPresent: true,
    });
    assert(snapshot !== null);
    assertEquals(snapshot.state, 'pause', 'stale save pauses, never plays');
    assert(snapshot.positionMs >= 5000, 'the place is kept');

    const player2 = createPlayer();
    player2.restore(snapshot);
    const status = player2.status();
    assertEquals(status.state, 'pause');
    const frozen = status.itemProgressMs;
    assert(frozen >= 5000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assertEquals(player2.status().itemProgressMs, frozen, 'paused stays put');
  } finally {
    await restarted.close();
  }
});

Deno.test('missing tracks drop with a warn and the current index remaps', async () => {
  const songs = [song(), song(), song(), song()];
  const [a, b, c, d] = songs;
  const saved = {
    state: 'play' as const,
    currentIndex: 2, // song c
    positionMs: 7000,
    repeat: 'off' as const,
    shuffle: false,
    consume: false,
    updatedAtMs: Date.now(),
  };
  const warns: string[] = [];
  const restoreWith = (present: SongRow[]) =>
    planRestore({
      queueIds: songs.map((s) => s.id),
      saved,
      getSong: (id) =>
        Promise.resolve(present.find((s) => s.id === id) ?? null),
      nowMs: Date.now(),
      maxAgeMs: 300_000,
      selectedOutputPresent: true,
      warn: (msg) => warns.push(msg),
    });

  // b dropped: c shifts from index 2 to 1, position preserved, still plays.
  const shifted = await restoreWith([a, c, d]);
  assert(shifted !== null);
  assertEquals(shifted.queue.map((s) => s.id), [a.id, c.id, d.id]);
  assertEquals(shifted.currentIndex, 1);
  assertEquals(shifted.positionMs, 7000);
  assertEquals(shifted.state, 'play');
  assertEquals(warns.length, 1);
  assert(warns[0].includes(b.id), `warn names the dropped track: ${warns}`);

  // The current track itself dropped: the entry that shifted into its
  // place is current, position 0, and play never auto-resumes.
  const currentGone = await restoreWith([a, c, d].filter((s) => s !== c));
  assert(currentGone !== null);
  assertEquals(currentGone.queue.map((s) => s.id), [a.id, d.id]);
  assertEquals(currentGone.currentIndex, 1, 'd lands where c was');
  assertEquals(currentGone.positionMs, 0, 'a different song has no place');
  assertEquals(currentGone.state, 'pause');

  // Nothing persisted at all: nothing to restore.
  const nothing = await planRestore({
    queueIds: [],
    saved: null,
    getSong: () => Promise.resolve(null),
    nowMs: Date.now(),
    maxAgeMs: 300_000,
    selectedOutputPresent: false,
  });
  assertEquals(nothing, null);
});

Deno.test('queue mutations rewrite server_queue (insert order, clear)', async () => {
  const { persistence, playback, close } = await setup();
  try {
    const [a, b, c] = [song(), song(), song()];
    playback.queueAdd([a, b]);
    playback.queueAdd([c], { position: 0 });
    await persistence.drain();
    assertEquals(await persistence.loadQueue(), [c.id, a.id, b.id]);

    playback.queueClear();
    await persistence.drain();
    assertEquals(await persistence.loadQueue(), []);
    const saved = await persistence.loadPlayerState();
    assert(saved !== null);
    assertEquals(saved.state, 'stop', 'the clear also stopped the engine');
    assertEquals(saved.currentIndex, null);
  } finally {
    await close();
  }
});

Deno.test('the 1 Hz tick keeps position_ms current while playing only', async () => {
  const { persistence, playback, close } = await setup();
  try {
    playback.queueAdd([song(180_000)], { play: true });
    await persistence.drain();
    const first = await persistence.loadPlayerState();
    assert(first !== null);
    assert(first.positionMs < 1000, `starts near zero: ${first.positionMs}`);

    // One tick lands within ~1 s of play and carries the live position.
    await new Promise((resolve) => setTimeout(resolve, 1300));
    await persistence.drain();
    const ticked = await persistence.loadPlayerState();
    assert(ticked !== null);
    assert(
      ticked.positionMs >= 800,
      `the tick persisted ~1 s of play: ${ticked.positionMs}`,
    );
    assert(ticked.updatedAtMs > first.updatedAtMs, 'updated_at bumped');

    // Paused: the tick is off, the saved position freezes.
    playback.pause();
    await persistence.drain();
    const paused = await persistence.loadPlayerState();
    assert(paused !== null);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await persistence.drain();
    const still = await persistence.loadPlayerState();
    assert(still !== null);
    assertEquals(still.positionMs, paused.positionMs, 'no tick while paused');
  } finally {
    await close();
  }
});
