import { atomic, type Engine, esc } from './engine.ts';
import type {
  ReferenceName,
  ReferenceType,
  ReferenceValues,
} from '../reference-types.ts';

export interface ReferenceFact {
  name: ReferenceName;
  plugin: string;
  value: ReferenceValues[ReferenceName] | null;
  fetchedAtMs: number;
}
export function createReferenceStore(engine: Engine) {
  return {
    get(type: ReferenceType, id: string): Promise<ReferenceFact[]> {
      return engine.exclusive(async (q) => {
        const rows = await q.all<
          {
            name: ReferenceName;
            plugin: string;
            value: string | null;
            fetchedAtMs: number;
          }
        >(
          `SELECT name, plugin, value::VARCHAR AS value, epoch_ms(fetched_at) AS fetchedAtMs
          FROM reference_facts WHERE entity_type = ${
            esc(type)
          } AND entity_id = ${esc(id)}`,
        );
        return rows.map((row) => ({
          ...row,
          fetchedAtMs: Number(row.fetchedAtMs),
          value: row.value === null ? null : JSON.parse(row.value),
        }));
      });
    },
    put(
      type: ReferenceType,
      id: string,
      plugin: string,
      names: readonly ReferenceName[],
      values: ReferenceValues,
      fetchedAtMs: number,
    ): Promise<void> {
      return atomic(engine, async (q) => {
        for (const name of names) {
          const value = values[name];
          await q.run(
            `INSERT INTO reference_facts VALUES (${esc(type)}, ${esc(id)}, ${
              esc(name)
            }, ${esc(plugin)},
            ${
              value === undefined
                ? 'NULL'
                : `${esc(JSON.stringify(value))}::JSON`
            }, to_timestamp(${fetchedAtMs} / 1000.0))
            ON CONFLICT (entity_type, entity_id, name, plugin) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at`,
          );
        }
      });
    },
    purgeOrphans(): Promise<void> {
      return engine.exclusive((q) =>
        q.run(`DELETE FROM reference_facts WHERE
        (entity_type = 'artist' AND NOT EXISTS (SELECT 1 FROM artists WHERE artists.id = reference_facts.entity_id)) OR
        (entity_type = 'track' AND NOT EXISTS (SELECT 1 FROM files WHERE files.id = reference_facts.entity_id))`)
      );
    },
  };
}
