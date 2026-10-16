// tests/player-persistence.test.ts — restart transparency (plan
// restart-transparency): the queue, player state, and position survive a
// restart (drain, reopen, restore); auto-resume plays only inside the
// freshness window with the environment still matching, else pauses at the
// saved place; missing tracks drop and the current index remaps; the 1 Hz
// tick keeps position_ms current while playing and stops when paused.
import { assert, assertEquals } from '@std/assert';
import { openStore } from '../src/store/index.ts';
import { createLibrary, type SongRow } from '../src/library.ts';
import { createLogger, type Log } from '../src/logging.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createPersistence } from '../src/persistence.ts';
import {
  createOutputs,
  createPlayer,
  planRestore,
  shouldAutoResume,
} from '../src/player.ts';
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
    firstSeenMs: null,
    isVideo: false,
    suffix: 'mp3',
    contentType: 'audio/mpeg',
  };
}

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-persist-' });
  const store = await openStore(dir);
  const db = store.legacy;
  const persistence = createPersistence(store);
  const player = createPlayer();
  const playback = createPlayback({
    player,
    nowPlaying: createNowPlaying(store),
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
  const store = await openStore(dir);
  const db = store.legacy;
  const persistence = createPersistence(store);
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
      log: {
        event: (event, facts) => {
          if (event === 'restore_missing') {
            warns.push((facts as { track: string }).track);
          }
        },
      },
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

Deno.test('output selection and volume survive a restart', async () => {
  const { dir, persistence, close } = await setup();
  const outputs = createOutputs({ persistence });
  outputs.register({
    id: '111',
    name: 'arbat',
    type: 'AirPlay',
    selected: false,
    volume: 100,
    host: '192.168.1.50',
    port: 7000,
  });
  outputs.register({
    id: '222',
    name: 'kitchen',
    type: 'AirPlay',
    selected: false,
    volume: 100,
  });
  outputs.update('111', { selected: true, volume: 42 });
  outputs.toggle('222');
  await persistence.drain();
  await close(true); // keep the dir — the "restart" reopens it

  const restarted = await reopen(dir);
  try {
    const rows = await restarted.persistence.loadOutputs();
    assertEquals(rows.length, 2);
    const arbat = rows.find((r) => r.id === '111')!;
    assertEquals(arbat, {
      id: '111',
      host: '192.168.1.50',
      port: 7000,
      name: 'arbat',
      type: 'AirPlay',
      selected: true,
      volume: 42,
      connectionStrategy: 'melofon',
    });
    const kitchen = rows.find((r) => r.id === '222')!;
    assertEquals(kitchen.selected, true, 'the toggle persisted');
    assertEquals(kitchen.host, undefined, 'no host on a hand-added row');

    // The write-through cache serves discovery's saved-state lookups.
    assertEquals(restarted.persistence.savedOutput('111')?.volume, 42);
    assertEquals(restarted.persistence.savedOutput('999'), undefined);

    // The boot path: re-register the persisted remotes, saved state intact.
    const outputs2 = createOutputs();
    for (const row of rows) {
      if (row.host === undefined) continue;
      outputs2.register({
        id: row.id,
        name: row.name,
        type: row.type,
        selected: row.selected,
        volume: row.volume,
        host: row.host,
        ...(row.port === undefined ? {} : { port: row.port }),
      });
    }
    const restored = outputs2.get('111')!;
    assertEquals(restored.selected, true);
    assertEquals(restored.volume, 42);
    assertEquals(restored.host, '192.168.1.50');
    assertEquals(outputs2.list().length, 1, 'hostless rows stay out');
  } finally {
    await restarted.close();
  }
});

Deno.test('output model identity survives a restart; legacy rows read unknown', async () => {
  const { dir, db, persistence, close } = await setup();
  // Simulate a pre-change database: output_state without the model column,
  // one legacy row written under it. The migration (run at every openDb)
  // re-adds the column idempotently.
  await db.conn.run('ALTER TABLE output_state DROP COLUMN model');
  await db.conn.run(
    'INSERT INTO output_state (id, host, port, name, type, selected, volume) ' +
      "VALUES ('legacy', '10.4.10.200', 7000, 'old-atv', 'AirPlay', false, 100)",
  );
  await db.conn.run(
    'ALTER TABLE output_state ADD COLUMN IF NOT EXISTS model VARCHAR',
  );

  const outputs = createOutputs({ persistence });
  outputs.register({
    id: '111',
    name: 'arbat',
    type: 'AirPlay',
    selected: true,
    volume: 42,
    host: '10.4.10.106',
    port: 7000,
    model: 'AppleTV3,1',
  });
  await persistence.drain();
  await close(true); // keep the dir — the "restart" reopens it

  const restarted = await reopen(dir);
  try {
    const rows = await restarted.persistence.loadOutputs();
    const arbat = rows.find((r) => r.id === '111')!;
    assertEquals(arbat.model, 'AppleTV3,1', 'the model survives the reopen');
    assertEquals(arbat.selected, true);
    assertEquals(arbat.volume, 42);
    const legacy = rows.find((r) => r.id === 'legacy')!;
    assert(!('model' in legacy), 'a legacy row reads as unknown model');
    assertEquals(legacy.name, 'old-atv', 'legacy data intact');

    // The write-through cache carries model for discovery's saved lookups.
    assertEquals(
      restarted.persistence.savedOutput('111')?.model,
      'AppleTV3,1',
    );
    assertEquals(restarted.persistence.savedOutput('legacy')?.model, undefined);

    // The boot restore path re-registers the row with its identity intact.
    const outputs2 = createOutputs();
    outputs2.register({
      id: arbat.id,
      name: arbat.name,
      type: arbat.type,
      selected: arbat.selected,
      volume: arbat.volume,
      host: arbat.host,
      ...(arbat.port === undefined ? {} : { port: arbat.port }),
      ...(arbat.model === undefined ? {} : { model: arbat.model }),
    });
    assertEquals(outputs2.get('111')!.model, 'AppleTV3,1');
  } finally {
    await restarted.close();
  }
});

Deno.test('unregister keeps the persisted row (last-seen state)', async () => {
  const { persistence, close } = await setup();
  try {
    const outputs = createOutputs({ persistence });
    outputs.register({
      id: '111',
      name: 'arbat',
      type: 'AirPlay',
      selected: false,
      volume: 100,
      host: '192.168.1.50',
      port: 7000,
    });
    outputs.update('111', { selected: true, volume: 42 });
    assertEquals(outputs.unregister('111'), true, 'mDNS down unregisters');
    await persistence.drain();

    const rows = await persistence.loadOutputs();
    assertEquals(rows.length, 1, 'the row survives the unregister');
    assertEquals(rows[0].selected, true, 'last-seen user state');
    assertEquals(rows[0].volume, 42);
  } finally {
    await close();
  }
});

Deno.test('a failed save is drained and counted once; a broken logger is harmless', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-persist-' });
  const store = await openStore(dir);
  const db = store.legacy;
  const logger = createLogger({
    sinks: {
      stdout: () => {
        throw new Error('sink unavailable');
      },
      stderr: () => {
        throw new Error('sink unavailable');
      },
    },
  });
  const events: string[] = [];
  const log: Log = {
    event(id, facts) {
      events.push(id);
      logger.event(id, facts);
    },
  };
  try {
    const persistence = createPersistence(store, log);
    db.close();
    persistence.saveQueue(['a', 'b']);
    await persistence.drain();
    assertEquals(events.filter((id) => id === 'persistence_failed').length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
