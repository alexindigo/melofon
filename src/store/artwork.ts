import { type Engine, esc } from './engine.ts';

/** Disposable source facts, never scanner-owned catalog or hat placeholder data. */
export interface ArtworkSourceFacts {
  sourceHash: string;
  width: number | null;
  height: number | null;
  format: string;
  byteLength: number;
}
export function createArtworkStore(engine: Engine) {
  return {
    get(key: string): Promise<
      {
        signature: string;
        facts: ArtworkSourceFacts | null;
      } | null
    > {
      return engine.exclusive(async (q) => {
        const [row] = await q.all<{ signature: string; facts: string | null }>(
          `SELECT signature, facts::VARCHAR AS facts FROM artwork_sources WHERE source_key = ${
            esc(key)
          }`,
        );
        return row
          ? {
            signature: row.signature,
            facts: row.facts === null ? null : JSON.parse(row.facts),
          }
          : null;
      });
    },
    put(
      key: string,
      signature: string,
      facts: ArtworkSourceFacts | null,
    ): Promise<void> {
      return engine.exclusive((q) =>
        q.run(
          `INSERT INTO artwork_sources (source_key, signature, facts) VALUES (${
            esc(key)
          }, ${esc(signature)}, ${
            facts === null ? 'NULL' : `${esc(JSON.stringify(facts))}::JSON`
          })
        ON CONFLICT (source_key) DO UPDATE SET signature = excluded.signature, facts = excluded.facts`,
        )
      );
    },
  };
}
