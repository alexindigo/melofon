import { atomic, type Engine, esc, type Queries } from './engine.ts';

export interface EncryptedSpeakerCredential {
  kind: 'password' | 'pairing-key';
  ciphertext: string;
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

async function save(
  q: Queries,
  row: AdoptedSpeakerSnapshot,
  adopted: boolean,
): Promise<void> {
  await q.run(
    `INSERT INTO output_state (id, host, port, name, type, selected,
       volume, model, connection_strategy, adopted, receiver_identity)
     VALUES (${esc(row.id)},
       ${row.host === undefined ? 'NULL' : esc(row.host)},
       ${row.port === undefined ? 'NULL' : Math.trunc(row.port)},
       ${esc(row.name)}, ${esc(row.type)},
       ${row.selected}, ${Math.trunc(row.volume)},
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
       selected = excluded.selected,
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
    `SELECT id, host, port, name, type, selected, volume, model,
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
