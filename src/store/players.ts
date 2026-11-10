import { atomic, type Engine, esc, type Queries } from './engine.ts';
import {
  deletePlayerPlayback,
  type PlayerSnapshot,
  requirePlayer,
  reservePlayerQueueIds,
  savePlayerQueue,
  savePlayerState,
} from './playback.ts';
import {
  migrateSpeakerMembership,
  saveSpeakerMembership,
  saveSpeakerVolume,
  type SpeakerMembership,
} from './speakers.ts';
import type { QueueSnapshot } from '../queue-source.ts';

export interface StoredPlayer {
  id: number;
  name: string;
  volume: number;
  isDefault: boolean;
  commandedAtMs: number | null;
}

export interface PlayerSave {
  playerId: number;
  queue?: QueueSnapshot;
  state?: PlayerSnapshot;
  volume?: number;
  commandedAtMs?: number;
}

async function hasColumn(
  q: Queries,
  table: string,
  column: string,
): Promise<boolean> {
  return (await q.all(`SELECT column_name FROM information_schema.columns
    WHERE table_name = ${esc(table)} AND column_name = ${esc(column)}`))
    .length > 0;
}

/** Runs after the typed-queue/adoption migrations, in one ledger transaction.
 * Copy timestamps verbatim: an upgrade must not make a stale play state fresh. */
export async function migratePlayers(q: Queries): Promise<void> {
  const selected = await hasColumn(q, 'output_state', 'selected');
  await q.run(`INSERT INTO players (id, name, name_key, volume, is_default)
    SELECT 1, 'Home', 'home', coalesce(max(volume), 50), true FROM output_state
    WHERE ${selected ? 'selected' : 'player_id = 1'} ON CONFLICT DO NOTHING`);
  if (!(await hasColumn(q, 'server_queue', 'player_id'))) {
    await q.run(`CREATE TABLE server_queue_players (
      player_id INTEGER NOT NULL, pos INTEGER NOT NULL, entry_id BIGINT UNIQUE NOT NULL,
      reference_kind VARCHAR NOT NULL CHECK (reference_kind IN ('song', 'station', 'url')),
      reference_value VARCHAR NOT NULL, PRIMARY KEY (player_id, pos))`);
    await q.run(
      'INSERT INTO server_queue_players SELECT 1, * FROM server_queue',
    );
    await q.run('DROP TABLE server_queue');
    await q.run('ALTER TABLE server_queue_players RENAME TO server_queue');
  }
  if (!(await hasColumn(q, 'server_queue_state', 'player_id'))) {
    await q.run(
      `INSERT INTO server_queue_allocator SELECT 1, next_id FROM server_queue_state
      WHERE id = 1 ON CONFLICT DO NOTHING`,
    );
    await q.run(
      'CREATE TABLE server_queue_state_players (player_id INTEGER PRIMARY KEY, version BIGINT NOT NULL)',
    );
    await q.run(
      'INSERT INTO server_queue_state_players SELECT id, version FROM server_queue_state',
    );
    await q.run('DROP TABLE server_queue_state');
    await q.run(
      'ALTER TABLE server_queue_state_players RENAME TO server_queue_state',
    );
  }
  await q.run(
    'INSERT INTO server_queue_state VALUES (1, 0) ON CONFLICT DO NOTHING',
  );
  await q.run(
    'INSERT INTO server_queue_allocator VALUES (1, 1) ON CONFLICT DO NOTHING',
  );
  if (!(await hasColumn(q, 'player_state', 'player_id'))) {
    await q.run(`CREATE TABLE player_state_players (
      player_id INTEGER PRIMARY KEY, state VARCHAR NOT NULL, current_index INTEGER,
      position_ms BIGINT, repeat VARCHAR, shuffle BOOLEAN, consume BOOLEAN, updated_at TIMESTAMPTZ)`);
    await q.run('INSERT INTO player_state_players SELECT * FROM player_state');
    await q.run('DROP TABLE player_state');
    await q.run('ALTER TABLE player_state_players RENAME TO player_state');
  }
  if (selected) {
    await migrateSpeakerMembership(q);
  }
}

function volumeValue(volume: number): number {
  if (!Number.isInteger(volume) || volume < 0 || volume > 100) {
    throw new Error('Invalid player volume');
  }
  return volume;
}

/** Owns player records. Transaction primitives retain each table's sole writer. */
export function createPlayersStore(engine: Engine) {
  return {
    list(): Promise<StoredPlayer[]> {
      return engine.exclusive(async (q) => {
        const rows = await q.all<
          {
            id: number;
            name: string;
            volume: number;
            is_default: boolean;
            commanded_at_ms: number | null;
          }
        >(
          'SELECT id, name, volume, is_default, commanded_at_ms FROM players ORDER BY id',
        );
        return rows.map((r) => ({
          id: r.id,
          name: r.name,
          volume: r.volume,
          isDefault: r.is_default,
          commandedAtMs: r.commanded_at_ms,
        }));
      });
    },

    create(name: string, volume = 50): Promise<StoredPlayer> {
      return atomic(engine, async (q) => {
        name = name.trim();
        if (!name) throw new Error('Player name is required');
        volumeValue(volume);
        const [row] = await q.all<{ id: number }>(
          `INSERT INTO players (id, name, name_key, volume, is_default)
          VALUES (nextval('server_player_seq'), ${esc(name)}, ${
            esc(name.toLowerCase())
          }, ${volume}, false) RETURNING id`,
        );
        await q.run(`INSERT INTO server_queue_state VALUES (${row.id}, 0)`);
        return {
          id: row.id,
          name,
          volume,
          isDefault: false,
          commandedAtMs: null,
        };
      });
    },

    rename(playerId: number, name: string): Promise<void> {
      return atomic(engine, async (q) => {
        await requirePlayer(q, playerId);
        name = name.trim();
        if (!name) throw new Error('Player name is required');
        await q.run(
          `UPDATE players SET name = ${esc(name)}, name_key = ${
            esc(name.toLowerCase())
          } WHERE id = ${playerId}`,
        );
      });
    },

    setDefault(playerId: number): Promise<void> {
      return atomic(engine, async (q) => {
        await requirePlayer(q, playerId);
        await q.run(`UPDATE players SET is_default = (id = ${playerId})`);
      });
    },

    delete(playerId: number): Promise<void> {
      return atomic(engine, async (q) => {
        await requirePlayer(q, playerId);
        const [row] = await q.all<{ is_default: boolean; total: number }>(
          `SELECT is_default, (SELECT count(*) FROM players) AS total FROM players WHERE id = ${playerId}`,
        );
        if (row.total === 1) throw new Error('Cannot delete the last player');
        if (row.is_default) throw new Error('Cannot delete the default player');
        const members = await q.all<{ id: string }>(
          `SELECT id FROM output_state WHERE player_id = ${playerId}`,
        );
        for (const member of members) {
          await saveSpeakerMembership(q, {
            speakerId: member.id,
            playerId: null,
            linked: true,
          });
        }
        await deletePlayerPlayback(q, playerId);
        await q.run(`DELETE FROM players WHERE id = ${playerId}`);
      });
    },

    /** Moving speakers, copying queues and linked-volume saves share one commit. */
    saveChanges(changes: {
      players?: PlayerSave[];
      memberships?: SpeakerMembership[];
      speakerVolumes?: { speakerId: string; volume: number }[];
    }): Promise<void> {
      return atomic(engine, async (q) => {
        for (const row of changes.players ?? []) {
          await requirePlayer(q, row.playerId);
          if (row.queue) await savePlayerQueue(q, row.playerId, row.queue);
          if (row.state) await savePlayerState(q, row.playerId, row.state);
          if (row.volume !== undefined) {
            await q.run(
              `UPDATE players SET volume = ${
                volumeValue(row.volume)
              } WHERE id = ${row.playerId}`,
            );
          }
          if (row.commandedAtMs !== undefined) {
            if (
              !Number.isSafeInteger(row.commandedAtMs) || row.commandedAtMs < 0
            ) throw new Error('Invalid command time');
            await q.run(
              `UPDATE players SET commanded_at_ms = ${row.commandedAtMs} WHERE id = ${row.playerId}`,
            );
          }
        }
        for (const row of changes.memberships ?? []) {
          await saveSpeakerMembership(q, row);
        }
        for (const row of changes.speakerVolumes ?? []) {
          await saveSpeakerVolume(q, row.speakerId, row.volume);
        }
      });
    },

    /** Reserve globally unique occurrence ids before synchronous engine insertion. */
    reserveQueueIds(count: number): Promise<number> {
      return atomic(engine, (q) => reservePlayerQueueIds(q, count));
    },
  };
}
