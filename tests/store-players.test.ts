import { assertEquals, assertRejects } from '@std/assert';
import { openStore, type Store } from '../src/store/index.ts';
import { createPlayersStore } from '../src/store/players.ts';
import { rawSql } from '../src/store/testing.ts';
import { domainFixture } from './helpers/store.ts';
import { songQueue, stopped } from './helpers/queue.ts';

const home = {
  id: 1,
  name: 'Home',
  volume: 50,
  isDefault: true,
  commandedAtMs: null,
};
const speaker = {
  id: 'speaker',
  name: 'Room',
  type: 'AirPlay',
  selected: true,
  volume: 37,
  connectionStrategy: 'owntone',
};
const free = { ...speaker, id: 'free', selected: false, volume: 80 };

/** Recreate the released storage shape via the sole raw fixture seam. */
async function legacy(store: Store, prePart1: boolean, empty = false) {
  const q = rawSql(store);
  await store.speakers.saveAdopted(
    { ...speaker, receiverIdentity: 'receiver' },
    [{ kind: 'password', ciphertext: 'opaque-encrypted' }],
  );
  await store.speakers.saveAdopted(free);
  await store.speakers.saveIgnored('ignored');
  await q.run(
    "INSERT INTO play_queues (user_id, current_index, position_ms, changed_at, track_ids, changed_by) VALUES ('saved-user', 1, 7654, TIMESTAMPTZ '2020-01-02 03:04:05.678+00', ['dup', 'dup'], 'Phone')",
  );
  await q.run("DELETE FROM migrations WHERE id = 'players-001'");
  if (prePart1) {
    await q.run(
      "DELETE FROM migrations WHERE id IN ('server-queue-001', 'speakers-001')",
    );
  }
  for (
    const table of [
      'players',
      'server_queue',
      'server_queue_state',
      'server_queue_allocator',
      'player_state',
    ]
  ) {
    await q.run(`DROP TABLE ${table}`);
  }
  if (!prePart1) {
    await q.run(
      'CREATE TABLE server_queue_state (id INTEGER PRIMARY KEY CHECK (id = 1), next_id BIGINT NOT NULL, version BIGINT NOT NULL)',
    );
  }
  await q.run(
    `CREATE TABLE server_queue (${
      prePart1
        ? 'pos INTEGER PRIMARY KEY, song_id VARCHAR NOT NULL'
        : 'pos INTEGER PRIMARY KEY, entry_id BIGINT UNIQUE NOT NULL, reference_kind VARCHAR NOT NULL, reference_value VARCHAR NOT NULL'
    })`,
  );
  if (!empty) {
    await q.run(
      prePart1
        ? "INSERT INTO server_queue VALUES (2, 'dup'), (0, 'dup'), (1, 'middle')"
        : "INSERT INTO server_queue VALUES (2, 12, 'url', 'http://melofon.home/live?x=1#keep'), (0, 4, 'song', 'dup'), (1, 9, 'station', 'station-1')",
    );
  }
  if (!prePart1) {
    await q.run('INSERT INTO server_queue_state VALUES (1, 81, 29)');
  }
  await q.run(
    `CREATE TABLE player_state (id INTEGER PRIMARY KEY CHECK (id = 1), state VARCHAR NOT NULL,
    current_index INTEGER, position_ms BIGINT, repeat VARCHAR, shuffle BOOLEAN, consume BOOLEAN, updated_at TIMESTAMPTZ)`,
  );
  await q.run(
    "INSERT INTO player_state VALUES (1, 'play', 1, 4321, 'single', true, true, TIMESTAMPTZ '2020-01-02 03:04:05.678+00')",
  );
  await q.run(
    'ALTER TABLE output_state ADD COLUMN selected BOOLEAN DEFAULT false',
  );
  await q.run(
    'UPDATE output_state SET selected = coalesce(player_id = 1, false)',
  );
  await q.run('ALTER TABLE output_state ALTER COLUMN selected SET NOT NULL');
  await q.run('ALTER TABLE output_state DROP COLUMN player_id');
  await q.run('ALTER TABLE output_state DROP COLUMN linked');
  if (prePart1) await q.run('ALTER TABLE output_state DROP COLUMN adopted');
}

for (const prePart1 of [false, true]) {
  Deno.test(`players upgrade composes from ${prePart1 ? 'pre-part-1' : 'v0.2.0'} and preserves every saved playback fact`, async () => {
    const dir = await Deno.makeTempDir({ prefix: 'melofon-players-upgrade-' });
    let store = await openStore(dir);
    try {
      await legacy(store, prePart1);
      const userQueue = await rawSql(store).all('SELECT * FROM play_queues');
      await store.close();
      store = await openStore(dir);
      const queue = prePart1 ? songQueue(['dup', 'middle', 'dup']) : {
        items: [
          { id: 4, reference: { kind: 'song', id: 'dup' } },
          { id: 9, reference: { kind: 'station', id: 'station-1' } },
          {
            id: 12,
            reference: {
              kind: 'url',
              url: 'http://melofon.home/live?x=1#keep',
            },
          },
        ],
        nextId: 81,
        version: 29,
      };
      const state = {
        state: 'play' as const,
        currentIndex: 1,
        positionMs: 4321,
        repeat: 'single' as const,
        shuffle: true,
        consume: true,
        updatedAtMs: Date.parse('2020-01-02T03:04:05.678Z'),
      };
      for (let open = 0; open < 2; open++) {
        assertEquals(await store.players.list(), [{ ...home, volume: 37 }]);
        assertEquals(await store.playback.loadQueue(1), queue);
        assertEquals(await store.playback.loadPlayerState(1), state);
        assertEquals(await store.speakers.loadAdopted(), [free, {
          ...speaker,
          receiverIdentity: 'receiver',
        }]);
        assertEquals(await store.speakers.loadMemberships(), [{
          speakerId: 'free',
          playerId: null,
          linked: true,
        }, { speakerId: 'speaker', playerId: 1, linked: true }]);
        assertEquals(
          await store.speakers.loadCredential('speaker', 'password'),
          'opaque-encrypted',
        );
        assertEquals(await store.speakers.loadIgnored(), ['ignored']);
        assertEquals(
          await rawSql(store).all('SELECT * FROM play_queues'),
          userQueue,
        );
        await store.close();
        store = await openStore(dir);
      }
    } finally {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test('players fresh install has only Home, empty queue, no state or speakers and volume 50', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-players-fresh-' });
  const store = await openStore(dir);
  try {
    assertEquals(await store.players.list(), [home]);
    assertEquals(await store.playback.loadQueue(1), songQueue([]));
    assertEquals(await store.playback.loadPlayerState(1), null);
    assertEquals(await store.speakers.loadMemberships(), []);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('players empty legacy queue keeps its counter and revision exactly', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-players-empty-' });
  let store = await openStore(dir);
  try {
    await legacy(store, false, true);
    await rawSql(store).run('UPDATE output_state SET selected = false');
    await store.close();
    store = await openStore(dir);
    assertEquals(await store.playback.loadQueue(1), {
      items: [],
      nextId: 81,
      version: 29,
    });
    assertEquals(await store.players.list(), [home]);
    assertEquals(
      (await store.speakers.loadMemberships()).map((row) => row.playerId),
      [null, null],
    );
    assertEquals(await store.players.reserveQueueIds(2), 81);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('players save independent queues, modes, volume and exclusive linked membership across reopen', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-players-save-' });
  let store = await openStore(dir);
  try {
    const other = await store.players.create('Kitchen', 62);
    await store.speakers.saveAdopted(speaker);
    const first = songQueue(['a']);
    const second = {
      items: [{
        id: 7,
        reference: { kind: 'url' as const, url: 'http://melofon.home/audio' },
      }],
      nextId: 11,
      version: 8,
    };
    await store.players.saveChanges({
      players: [
        {
          playerId: 1,
          queue: first,
          state: {
            ...stopped,
            state: 'pause',
            currentIndex: 0,
            positionMs: 123,
          },
          volume: 20,
        },
        {
          playerId: other.id,
          queue: second,
          state: { ...stopped, repeat: 'all', shuffle: true },
          commandedAtMs: 123456,
        },
      ],
      memberships: [{
        speakerId: speaker.id,
        playerId: other.id,
        linked: false,
      }],
      speakerVolumes: [{ speakerId: speaker.id, volume: 73 }],
    });
    const saved = await store.playback.loadPlayerState(1);
    await store.close();
    store = await openStore(dir);
    assertEquals(await store.players.list(), [{ ...home, volume: 20 }, {
      ...other,
      commandedAtMs: 123456,
    }]);
    assertEquals(await store.playback.loadQueue(1), { ...first, nextId: 11 });
    assertEquals(await store.playback.loadQueue(other.id), second);
    assertEquals(await store.playback.loadPlayerState(1), saved);
    assertEquals(
      (await store.playback.loadPlayerState(other.id))?.repeat,
      'all',
    );
    assertEquals(await store.speakers.loadMemberships(), [{
      speakerId: speaker.id,
      playerId: other.id,
      linked: false,
    }]);
    assertEquals((await store.speakers.loadAdopted())[0].volume, 73);
    assertEquals(
      (await store.speakers.loadAdopted())[0].selected,
      false,
      'player 1 projection cannot claim Kitchen membership',
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('players multi-player changes roll back queues, state, allocator, membership and volumes together', async () => {
  const t = await domainFixture(createPlayersStore);
  try {
    const other = await t.domain.create('Kitchen');
    await t.run(
      "INSERT INTO output_state (id, player_id, volume) VALUES ('speaker', 1, 37)",
    );
    const changes = {
      players: [
        { playerId: 1, queue: songQueue(['a']), state: stopped, volume: 10 },
        {
          playerId: other.id,
          queue: {
            ...songQueue(['b']),
            items: [{ id: 5, reference: { kind: 'song' as const, id: 'b' } }],
            nextId: 6,
          },
        },
      ],
      memberships: [{
        speakerId: 'speaker',
        playerId: other.id,
        linked: false,
      }],
      speakerVolumes: [{ speakerId: 'speaker', volume: 63 }],
    };
    t.failCommit();
    await assertRejects(
      () => t.domain.saveChanges(changes),
      Error,
      'injected commit failure',
    );
    assertEquals(await t.all('SELECT * FROM server_queue'), []);
    assertEquals(await t.all('SELECT * FROM player_state'), []);
    assertEquals(await t.all('SELECT next_id FROM server_queue_allocator'), [{
      next_id: 1,
    }]);
    assertEquals(
      await t.all('SELECT player_id, linked, volume FROM output_state'),
      [{ player_id: 1, linked: true, volume: 37 }],
    );
    assertEquals(await t.domain.list(), [home, other]);
    await t.domain.saveChanges(changes);
    assertEquals(
      await t.all('SELECT player_id, linked, volume FROM output_state'),
      [{ player_id: other.id, linked: false, volume: 63 }],
    );
  } finally {
    await t.close();
  }
});

Deno.test('players names are case-insensitive and default/delete changes leave no orphaned ownership', async () => {
  const t = await domainFixture(createPlayersStore);
  try {
    await assertRejects(() => t.domain.delete(1), Error, 'last player');
    const other = await t.domain.create('Kitchen');
    await assertRejects(() => t.domain.create('kItChEn'), Error, 'Constraint');
    await assertRejects(
      () => t.domain.rename(other.id, 'HOME'),
      Error,
      'Constraint',
    );
    await assertRejects(() => t.domain.delete(1), Error, 'default player');
    await t.domain.rename(other.id, 'Study');
    await t.domain.setDefault(other.id);
    await t.run(
      "INSERT INTO output_state (id, player_id, volume) VALUES ('speaker', 1, 37)",
    );
    await t.domain.saveChanges({
      players: [{ playerId: 1, queue: songQueue(['a']), state: stopped }],
    });
    t.failCommit();
    await assertRejects(
      () => t.domain.delete(1),
      Error,
      'injected commit failure',
    );
    assertEquals((await t.domain.list()).length, 2);
    await t.domain.delete(1);
    assertEquals(await t.domain.list(), [{
      ...other,
      name: 'Study',
      isDefault: true,
    }]);
    assertEquals(await t.all('SELECT * FROM server_queue'), []);
    assertEquals(await t.all('SELECT * FROM player_state'), []);
    assertEquals(await t.all('SELECT player_id, linked FROM output_state'), [{
      player_id: null,
      linked: true,
    }]);
    assertEquals(await t.all('SELECT next_id FROM server_queue_allocator'), [{
      next_id: 2,
    }]);
  } finally {
    await t.close();
  }
});

Deno.test('players reserve disjoint global ids, reject cross-player duplicates and invalid ownership atomically', async () => {
  const t = await domainFixture(createPlayersStore);
  try {
    const other = await t.domain.create('Kitchen');
    assertEquals(
      await Promise.all([
        t.domain.reserveQueueIds(2),
        t.domain.reserveQueueIds(3),
      ]),
      [1, 3],
    );
    await t.domain.saveChanges({
      players: [{ playerId: 1, queue: songQueue(['a']) }],
    });
    await assertRejects(
      () =>
        t.domain.saveChanges({
          players: [{ playerId: other.id, queue: songQueue(['b']) }],
        }),
      Error,
      'Constraint',
    );
    await assertRejects(
      () =>
        t.domain.saveChanges({ players: [{ playerId: 999, state: stopped }] }),
      Error,
      'Player not found',
    );
    await assertRejects(
      () =>
        t.domain.saveChanges({
          memberships: [{ speakerId: 'missing', playerId: 1, linked: true }],
        }),
      Error,
      'Speaker not found',
    );
    assertEquals(await t.all('SELECT next_id FROM server_queue_allocator'), [{
      next_id: 6,
    }]);
    assertEquals(await t.all('SELECT player_id, entry_id FROM server_queue'), [{
      player_id: 1,
      entry_id: 1,
    }]);
  } finally {
    await t.close();
  }
});
