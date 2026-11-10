import { atomic, type Engine, esc, type Queries } from './engine.ts';

export interface EncryptedSpeakerCredential {
  kind: 'password' | 'pairing-key';
  ciphertext: string;
}

export interface SpeakerMembership {
  speakerId: string;
  playerId: number | null;
  linked: boolean;
}

/** Internal primitives, called only while holding the caller's transaction. */
export async function saveSpeakerMembership(
  q: Queries,
  row: SpeakerMembership,
): Promise<void> {
  if (row.playerId !== null) {
    if (
      !Number.isSafeInteger(row.playerId) || row.playerId < 1 ||
      !(await q.all(`SELECT id FROM players WHERE id = ${row.playerId}`)).length
    ) throw new Error('Player not found');
  }
  const updated = await q.all(
    `UPDATE output_state SET player_id = ${
      row.playerId ?? 'NULL'
    }, linked = ${row.linked}
    WHERE id = ${esc(row.speakerId)} RETURNING id`,
  );
  if (!updated.length) throw new Error('Speaker not found');
}

export async function saveSpeakerVolume(
  q: Queries,
  id: string,
  volume: number,
): Promise<void> {
  if (!Number.isInteger(volume) || volume < 0 || volume > 100) {
    throw new Error('Invalid speaker volume');
  }
  const rows = await q.all(
    `UPDATE output_state SET volume = ${volume} WHERE id = ${
      esc(id)
    } RETURNING id`,
  );
  if (!rows.length) throw new Error('Speaker not found');
}

async function saveCredential(
  q: Queries,
  id: string,
  record: EncryptedSpeakerCredential,
): Promise<void> {
  await q.run(`INSERT INTO speaker_credentials (speaker_id, kind, ciphertext)
    VALUES (${esc(id)}, ${esc(record.kind)}, ${esc(record.ciphertext)})
    ON CONFLICT (speaker_id, kind) DO UPDATE SET ciphertext = excluded.ciphertext`);
}

/** Saved identity/preferences only, never live protocol or readiness facts. */
export interface OutputSnapshot {
  id: string;
  host?: string;
  port?: number;
  name: string;
  type: string;
  selected: boolean;
  volume: number;
  model?: string;
  receiverIdentity?: string;
  connectionStrategy?: string;
}

export type AdoptedSpeakerSnapshot = OutputSnapshot & {
  connectionStrategy: string;
};

/** Historical intent is unknowable: preserve every pre-upgrade saved row. */
export async function migrateAdoptedSpeakers(q: Queries): Promise<void> {
  await q.run('UPDATE output_state SET adopted = true');
}

/** Define constraints before copying rows: DuckDB cannot add an index-backed
 * constraint to a table with outstanding transactional writes/defaults. */
export async function migrateSpeakerMembership(q: Queries): Promise<void> {
  await q.run(`CREATE TABLE output_state_players (
    id VARCHAR PRIMARY KEY, host VARCHAR, port INTEGER, name VARCHAR, type VARCHAR,
    player_id INTEGER, linked BOOLEAN NOT NULL DEFAULT true, volume INTEGER NOT NULL,
    model VARCHAR, connection_strategy VARCHAR DEFAULT 'melofon', adopted BOOLEAN DEFAULT false,
    receiver_identity VARCHAR)`);
  await q.run(`INSERT INTO output_state_players
    SELECT id, host, port, name, type, CASE WHEN selected THEN 1 ELSE NULL END,
      true, volume, model, connection_strategy, adopted, receiver_identity FROM output_state`);
  await q.run('DROP TABLE output_state');
  await q.run('ALTER TABLE output_state_players RENAME TO output_state');
}

async function save(
  q: Queries,
  row: AdoptedSpeakerSnapshot,
  adopted: boolean,
): Promise<void> {
  if (typeof row.selected !== 'boolean') {
    throw new Error('Constraint: selected must be boolean');
  }
  // Compatibility is deliberately scoped to the still-single-player core.
  if (
    row.selected && !(await q.all('SELECT id FROM players WHERE id = 1')).length
  ) {
    throw new Error('Player not found');
  }
  await q.run(
    `INSERT INTO output_state (id, host, port, name, type, player_id,
       volume, model, connection_strategy, adopted, receiver_identity)
     VALUES (${esc(row.id)},
       ${row.host === undefined ? 'NULL' : esc(row.host)},
       ${row.port === undefined ? 'NULL' : Math.trunc(row.port)},
       ${esc(row.name)}, ${esc(row.type)},
        ${row.selected ? 1 : 'NULL'}, ${Math.trunc(row.volume)},
       ${row.model === undefined ? 'NULL' : esc(row.model)},
       ${esc(row.connectionStrategy)}, ${adopted},
       ${
      row.receiverIdentity === undefined ? 'NULL' : esc(row.receiverIdentity)
    })
     ON CONFLICT (id) DO UPDATE SET
       host = excluded.host,
       port = excluded.port,
       name = excluded.name,
       type = excluded.type,
        linked = CASE WHEN excluded.player_id = 1 AND output_state.player_id IS DISTINCT FROM 1 THEN true ELSE output_state.linked END,
        player_id = CASE WHEN excluded.player_id = 1 THEN 1 WHEN output_state.player_id = 1 THEN NULL ELSE output_state.player_id END,
       volume = excluded.volume,
       model = excluded.model,
       receiver_identity = excluded.receiver_identity,
       connection_strategy = excluded.connection_strategy,
       adopted = output_state.adopted OR excluded.adopted`,
  );
}

async function load(
  q: Queries,
  adoptedOnly: boolean,
): Promise<OutputSnapshot[]> {
  const rows = await q.all<{
    id: string;
    host: string | null;
    port: number | null;
    name: string | null;
    type: string | null;
    selected: boolean;
    volume: number;
    model: string | null;
    receiver_identity: string | null;
    connection_strategy: string | null;
  }>(
    `SELECT id, host, port, name, type, coalesce(player_id = 1, false) AS selected, volume, model,
       connection_strategy, receiver_identity FROM output_state${
      adoptedOnly ? ' WHERE adopted' : ''
    }
     ORDER BY id`,
  );
  return rows.map((row) => ({
    id: row.id,
    ...(row.host === null ? {} : { host: row.host }),
    ...(row.port === null ? {} : { port: Number(row.port) }),
    name: row.name ?? '',
    type: row.type ?? '',
    selected: row.selected,
    volume: Number(row.volume),
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.receiver_identity === null
      ? {}
      : { receiverIdentity: row.receiver_identity }),
    ...(row.connection_strategy === null
      ? {}
      : { connectionStrategy: row.connection_strategy }),
  }));
}

/** Sole writer for speaker configuration and independent ignore identities. */
export function createSpeakersStore(engine: Engine) {
  return {
    loadMemberships(): Promise<SpeakerMembership[]> {
      return engine.exclusive(async (q) => {
        const rows = await q.all<
          { id: string; player_id: number | null; linked: boolean }
        >(
          'SELECT id, player_id, linked FROM output_state ORDER BY id',
        );
        return rows.map((r) => ({
          speakerId: r.id,
          playerId: r.player_id,
          linked: r.linked,
        }));
      });
    },
    saveAdopted(
      row: AdoptedSpeakerSnapshot,
      credentials: EncryptedSpeakerCredential[] = [],
    ): Promise<void> {
      return atomic(engine, async (q) => {
        await q.run(`DELETE FROM speaker_ignores WHERE id = ${esc(row.id)}`);
        await save(q, row, true);
        for (const record of credentials) {
          await saveCredential(q, row.id, record);
        }
      });
    },

    deleteAdopted(id: string): Promise<boolean> {
      return atomic(engine, async (q) => {
        await q.run(
          `DELETE FROM speaker_credentials WHERE speaker_id = ${esc(id)}`,
        );
        const rows = await q.all(
          `DELETE FROM output_state WHERE id = ${
            esc(id)
          } AND adopted RETURNING id`,
        );
        return rows.length > 0;
      });
    },

    loadAdopted(): Promise<OutputSnapshot[]> {
      return engine.exclusive((q) => load(q, true));
    },

    loadCredential(
      id: string,
      kind: EncryptedSpeakerCredential['kind'],
    ): Promise<string | null> {
      return engine.exclusive(async (q) => {
        const rows = await q.all<{ ciphertext: string }>(
          `SELECT ciphertext FROM speaker_credentials
          WHERE speaker_id = ${esc(id)} AND kind = ${esc(kind)}`,
        );
        return rows[0]?.ciphertext ?? null;
      });
    },

    saveCredential(
      id: string,
      kind: EncryptedSpeakerCredential['kind'],
      ciphertext: string | null,
    ): Promise<void> {
      return atomic(engine, async (q) => {
        const adopted = await q.all(
          `SELECT id FROM output_state WHERE id = ${esc(id)} AND adopted`,
        );
        if (!adopted.length) {
          throw new Error('Saved speaker credential requires adoption');
        }
        if (ciphertext === null) {
          await q.run(
            `DELETE FROM speaker_credentials WHERE speaker_id = ${
              esc(id)
            } AND kind = ${esc(kind)}`,
          );
        } else await saveCredential(q, id, { kind, ciphertext });
      });
    },

    saveIgnored(id: string): Promise<void> {
      return atomic(engine, async (q) => {
        const adopted = await q.all(
          `SELECT id FROM output_state WHERE id = ${esc(id)} AND adopted`,
        );
        if (adopted.length) {
          throw new Error('Adopted speaker must be forgotten before ignoring');
        }
        await q.run(
          `INSERT INTO speaker_ignores (id) VALUES (${
            esc(id)
          }) ON CONFLICT DO NOTHING`,
        );
      });
    },

    deleteIgnored(id: string): Promise<boolean> {
      return engine.exclusive(async (q) => {
        const rows = await q.all(
          `DELETE FROM speaker_ignores WHERE id = ${esc(id)} RETURNING id`,
        );
        return rows.length > 0;
      });
    },

    loadIgnored(): Promise<string[]> {
      return engine.exclusive(async (q) => {
        const rows = await q.all<{ id: string }>(
          'SELECT id FROM speaker_ignores ORDER BY id',
        );
        return rows.map((row) => row.id);
      });
    },

    // Compatibility for the old persistence port until ingress lifetimes move
    // to the speakers service. Preference saves cannot create adoption.
    saveOutput(row: AdoptedSpeakerSnapshot): Promise<void> {
      return engine.exclusive((q) => save(q, row, false));
    },

    loadOutputs(): Promise<OutputSnapshot[]> {
      return engine.exclusive((q) => load(q, false));
    },
  };
}
