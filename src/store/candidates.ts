import { atomic, type Engine, esc, type Queries } from './engine.ts';

export type EntityType = 'album' | 'song' | 'artist';
export type CandidateState = 'open' | 'accepted' | 'rejected' | 'edited';
export interface CandidateInput {
  entityType: EntityType;
  entityId: string;
  kind: 'cover' | 'fields';
  source: string;
  confidence: 'strong' | 'medium' | 'low' | null;
  imageHash: string;
  imageExt: string;
  libraryId: string;
  /** Source URL, library-relative image path, or kept song id. */
  origin: string;
  details?: Record<string, unknown>;
  foundAtMs?: number;
}
export interface Candidate
  extends Omit<CandidateInput, 'details' | 'foundAtMs'> {
  id: string;
  state: CandidateState;
  details: Record<string, unknown>;
  foundAtMs: number;
  decidedAtMs: number | null;
}
export type LocalVersion = Pick<
  CandidateInput,
  'imageHash' | 'imageExt' | 'libraryId' | 'origin' | 'details'
>;

const projection = `id, entity_type AS entityType, entity_id AS entityId, kind,
  source, confidence, state, image_hash AS imageHash, image_ext AS imageExt,
  library_id AS libraryId, origin, details::VARCHAR AS details,
  epoch_ms(found_at) AS foundAtMs, epoch_ms(decided_at) AS decidedAtMs`;

async function read(q: Queries, suffix: string): Promise<Candidate[]> {
  const rows = await q.all<Omit<Candidate, 'details'> & { details: string }>(
    `SELECT ${projection} FROM candidates ${suffix}`,
  );
  return rows.map((row) => ({ ...row, details: JSON.parse(row.details) }));
}

// Private helpers share the caller's transaction, never nest public operations.
async function add(q: Queries, list: CandidateInput[]): Promise<Candidate[]> {
  const added: Candidate[] = [];
  for (const input of list) {
    // The same source/image is one proposal, including remembered rejections.
    const match = `entity_type = ${esc(input.entityType)} AND entity_id = ${
      esc(input.entityId)
    }
      AND source = ${esc(input.source)} AND image_hash = ${
      esc(input.imageHash)
    }`;
    if (
      (await q.all(`SELECT 1 FROM candidates WHERE ${match} LIMIT 1`)).length
    ) continue;
    const id = crypto.randomUUID();
    await q.run(`INSERT INTO candidates
      (id, entity_type, entity_id, kind, source, confidence, state,
       image_hash, image_ext, library_id, origin, found_at, details)
      VALUES (${esc(id)}, ${esc(input.entityType)}, ${esc(input.entityId)},
        ${esc(input.kind)}, ${esc(input.source)},
        ${input.confidence === null ? 'NULL' : esc(input.confidence)}, 'open',
        ${esc(input.imageHash)}, ${esc(input.imageExt)}, ${
      esc(input.libraryId)
    },
        ${esc(input.origin)}, to_timestamp(${
      input.foundAtMs ?? Date.now()
    } / 1000.0),
        ${esc(JSON.stringify(input.details ?? {}))})`);
    added.push(...await read(q, `WHERE id = ${esc(id)}`));
  }
  return added;
}

export function createCandidatesStore(engine: Engine) {
  return {
    addCandidates(list: CandidateInput[]): Promise<Candidate[]> {
      return atomic(engine, (q) => add(q, list));
    },
    candidatesFor(
      entityType: EntityType,
      entityId: string,
    ): Promise<Candidate[]> {
      return engine.exclusive((q) =>
        read(
          q,
          `WHERE entity_type = ${esc(entityType)} AND entity_id = ${
            esc(entityId)
          } ORDER BY found_at, seq`,
        )
      );
    },
    strongestOpen(
      entityType: EntityType,
      entityId: string,
      kind: CandidateInput['kind'],
    ): Promise<Candidate | null> {
      return engine.exclusive(async (q) =>
        (await read(
          q,
          `WHERE entity_type = ${esc(entityType)} AND entity_id = ${
            esc(entityId)
          }
         AND kind = ${esc(kind)} AND state = 'open' AND confidence = 'strong'
         ORDER BY found_at DESC, seq DESC LIMIT 1`,
        ))[0] ?? null
      );
    },
    setState(id: string, state: CandidateState): Promise<void> {
      return engine.exclusive((q) =>
        q.run(`UPDATE candidates SET state = ${esc(state)},
        decided_at = ${state === 'open' ? 'NULL' : 'now()'} WHERE id = ${
          esc(id)
        }`)
      );
    },
    replaceLocal(albumId: string, versions: LocalVersion[]): Promise<void> {
      return atomic(engine, async (q) => {
        const scope = `entity_type = 'album' AND entity_id = ${
          esc(albumId)
        } AND source = 'local' AND state = 'open'`;
        const hashes = versions.map((v) => esc(v.imageHash));
        await q.run(`DELETE FROM candidates WHERE ${scope}
          ${
          hashes.length ? `AND image_hash NOT IN (${hashes.join(',')})` : ''
        }`);
        // Refresh live references after a move without changing a decision or its history.
        for (const version of versions) {
          await q.run(`UPDATE candidates SET origin = ${esc(version.origin)},
            library_id = ${esc(version.libraryId)}, image_ext = ${
            esc(version.imageExt)
          }
            WHERE ${scope} AND image_hash = ${esc(version.imageHash)}`);
        }
        await add(
          q,
          versions.map((v) => ({
            ...v,
            entityType: 'album',
            entityId: albumId,
            kind: 'cover',
            source: 'local',
            confidence: null,
          })),
        );
      });
    },
  };
}
