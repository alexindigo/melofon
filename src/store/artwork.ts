import { type Engine, esc } from './engine.ts';

export interface ArtworkPreview {
  thumbHash: string;
  dominantColor: string | null;
}

/** Disposable source facts, independent of scanner-owned catalog records. */
export interface ArtworkSourceFacts {
  sourceHash: string;
  width: number | null;
  height: number | null;
  format: string;
  byteLength: number;
}
export function createArtworkStore(engine: Engine) {
  return {
    preview(sourceHash: string): Promise<ArtworkPreview | null> {
      return engine.exclusive(async (q) =>
        (await q.all<ArtworkPreview>(
          `SELECT thumb_hash AS thumbHash, dominant_color AS dominantColor
           FROM artwork_previews WHERE source_hash = ${esc(sourceHash)}
           AND algorithm_version = 2`,
        ))[0] ?? null
      );
    },
    savePreview(sourceHash: string, value: ArtworkPreview): Promise<void> {
      return engine.exclusive((q) =>
        q.run(
          `INSERT INTO artwork_previews VALUES (${esc(sourceHash)}, 2,
          ${esc(value.thumbHash)}, ${
            value.dominantColor === null ? 'NULL' : esc(value.dominantColor)
          })
         ON CONFLICT (source_hash) DO UPDATE SET algorithm_version = 2,
          thumb_hash = excluded.thumb_hash, dominant_color = excluded.dominant_color`,
        )
      );
    },
    /** Internal discovery inventory, including private playlists under their owner. */
    references(): Promise<{
      kind: 'song' | 'album' | 'artist' | 'playlist' | 'podcast' | 'radio';
      id: string;
      username: string | null;
    }[]> {
      return engine.exclusive((q) =>
        q.all(
          `SELECT 'song' AS kind, id, NULL::VARCHAR AS username FROM files
         UNION ALL SELECT 'album', id, NULL FROM albums
         UNION ALL SELECT 'artist', id, NULL FROM artists
         UNION ALL SELECT 'radio', id, NULL FROM radio_stations
         UNION ALL SELECT 'podcast', id, NULL FROM podcast_channels
         UNION ALL SELECT 'playlist', p.id, u.name FROM playlists p
           JOIN users u ON u.id = p.user_id`,
        )
      );
    },
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
