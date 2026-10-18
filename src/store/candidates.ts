import { atomic, type Engine, esc, type Queries } from './engine.ts';
import { enqueueLookups } from './lookups.ts';

export type EntityType = 'album' | 'song' | 'artist';
export type CandidateState = 'open' | 'accepted' | 'rejected' | 'edited';
export interface CandidateInput {
  entityType: EntityType;
  entityId: string;
  kind: 'cover' | 'fields' | 'lyrics';
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
      AND kind = ${esc(input.kind)} AND source = ${
      esc(input.source)
    } AND image_hash = ${esc(input.imageHash)}`;
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
  const accept = (id: string): Promise<void> =>
    atomic(engine, async (q) => {
      const candidate = (await read(q, `WHERE id = ${esc(id)}`))[0];
      if (
        !candidate || !(
          candidate.entityType === 'album' && candidate.kind === 'cover' ||
          candidate.entityType === 'song' && candidate.kind === 'lyrics'
        )
      ) throw new Error('Unifiable candidate not found');
      await enqueueLookups(q, [{
        plugin: 'core.unify',
        entityType: candidate.entityType,
        entityId: candidate.entityId,
        factsHash: candidate.id,
        mode: 'all',
      }]);
      // Lyrics are confirmed only after publication. In particular an unsupported
      // native write must leave the choice open while its job reports failure.
      await q.run(
        `UPDATE candidates SET state = ${
          esc(candidate.kind === 'lyrics' ? 'open' : 'accepted')
        }, decided_at = ${
          candidate.kind === 'lyrics' ? 'NULL' : 'now()'
        } WHERE id = ${esc(id)}`,
      );
    });
  return {
    byId(id: string): Promise<Candidate | null> {
      return engine.exclusive(async (q) =>
        (await read(q, `WHERE id = ${esc(id)}`))[0] ?? null
      );
    },
    /** The decision and its durable work commit together, with no nested slot. */
    accept,
    acceptCover: accept,
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
    /** Archived pictures remain selectable after scan reconciles live conflicts. */
    preserveLocal(
      albumId: string,
      versions: LocalVersion[],
      kind: 'cover' | 'lyrics' = 'cover',
    ): Promise<void> {
      const entityType = kind === 'lyrics' ? 'song' : 'album';
      return atomic(engine, async (q) => {
        await add(
          q,
          versions.map((version) => ({
            ...version,
            entityType,
            entityId: albumId,
            kind,
            source: 'local',
            confidence: null,
            details: { ...version.details, preserved: true },
          })),
        );
        for (const version of versions) {
          const rows = await read(
            q,
            `WHERE entity_type = ${esc(entityType)} AND entity_id = ${
              esc(albumId)
            }
            AND kind = ${esc(kind)} AND source = 'local' AND image_hash = ${
              esc(version.imageHash)
            }`,
          );
          for (const row of rows) {
            const backups = [
              ...(Array.isArray(row.details.backups)
                ? row.details.backups
                : []),
            ];
            if (
              kind === 'lyrics' && version.details?.lyrics !== undefined &&
              !backups.some((backup) =>
                JSON.stringify(backup) ===
                  JSON.stringify(version.details!.lyrics)
              )
            ) backups.push(version.details.lyrics);
            await q.run(
              `UPDATE candidates SET details = ${
                esc(
                  JSON.stringify({
                    ...row.details,
                    preserved: true,
                    ...(kind === 'lyrics' ? { backups } : {}),
                  }),
                )
              }
              WHERE id = ${esc(row.id)}`,
            );
          }
        }
      });
    },
    replaceLocal(
      albumId: string,
      versions: LocalVersion[],
      kind: 'cover' | 'lyrics' = 'cover',
    ): Promise<void> {
      const entityType = kind === 'lyrics' ? 'song' : 'album';
      return atomic(engine, async (q) => {
        const scope = `entity_type = ${esc(entityType)} AND kind = ${
          esc(kind)
        } AND entity_id = ${
          esc(albumId)
        } AND source = 'local' AND state = 'open'`;
        // Open-until-published lyrics choices are protected by their durable job.
        const unrequested = kind === 'lyrics'
          ? `AND NOT EXISTS (SELECT 1 FROM lookup_jobs j WHERE j.plugin = 'core.unify'
            AND j.facts_hash = candidates.id AND j.state IN ('waiting', 'active'))`
          : '';
        const hashes = versions.map((v) => esc(v.imageHash));
        await q.run(`DELETE FROM candidates WHERE ${scope}
          ${unrequested}
          AND json_extract_string(details, '$.preserved') IS DISTINCT FROM 'true'
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
          if (kind === 'lyrics' && version.details) {
            await q.run(
              `UPDATE candidates SET details = ${
                esc(JSON.stringify(version.details))
              }
            WHERE ${scope} AND image_hash = ${esc(version.imageHash)}
            ${unrequested}
            AND json_extract_string(details, '$.preserved') IS DISTINCT FROM 'true'`,
            );
          }
        }
        await add(
          q,
          versions.map((v) => ({
            ...v,
            entityType,
            entityId: albumId,
            kind,
            source: 'local',
            confidence: null,
          })),
        );
      });
    },
  };
}

/** DuckDB cannot alter a CHECK constraint. Upgrade the kept table atomically
 * using its canonical DDL, preserving every row, decision and sequence value. */
export async function upgradeCandidates(q: Queries, schema: string) {
  const constraints = await q.all<{ constraint_text: string }>(
    `SELECT constraint_text FROM duckdb_constraints() WHERE table_name = 'candidates' AND constraint_type = 'CHECK'`,
  );
  if (
    !constraints.some((row) =>
      row.constraint_text.includes('kind') &&
      !row.constraint_text.includes('lyrics')
    )
  ) return;
  const definition = schema.split(';').find((sql) =>
    /CREATE TABLE IF NOT EXISTS candidates\s*\(/.test(sql)
  );
  if (!definition) throw new Error('Missing canonical candidates schema');
  await q.run('BEGIN TRANSACTION');
  try {
    await q.run('ALTER TABLE candidates RENAME TO candidates_before_lyrics');
    await q.run(definition);
    await q.run(
      'INSERT INTO candidates SELECT * FROM candidates_before_lyrics',
    );
    await q.run('DROP TABLE candidates_before_lyrics');
    await q.run('COMMIT');
  } catch (error) {
    await q.run('ROLLBACK');
    throw error;
  }
}
