import { atomic, type Engine, esc, type Queries } from './engine.ts';

export interface StationInput {
  name: string;
  streamUrl: string;
  homePageUrl: string | null;
}

export interface StationRow extends StationInput {
  id: string;
  createdAtMs: number;
  updatedAtMs: number;
}

const SELECT = `SELECT id, name, stream_url AS "streamUrl",
  home_page_url AS "homePageUrl", epoch_ms(created_at)::DOUBLE AS "createdAtMs",
  epoch_ms(updated_at)::DOUBLE AS "updatedAtMs" FROM radio_stations`;

async function get(q: Queries, id: string): Promise<StationRow | null> {
  return (await q.all<StationRow>(`${SELECT} WHERE id = ${esc(id)}`))[0] ??
    null;
}

export function createRadioStore(engine: Engine) {
  return {
    list: (): Promise<StationRow[]> =>
      engine.exclusive((q) =>
        q.all<StationRow>(`${SELECT} ORDER BY lower(name), name, id`)
      ),
    get: (id: string) => engine.exclusive((q) => get(q, id)),
    create(input: StationInput): Promise<StationRow> {
      return atomic(engine, async (q) => {
        // Catalog identities are unprefixed hashes; station ids have their own namespace.
        const id = `radio-${crypto.randomUUID()}`;
        await q.run(
          `INSERT INTO radio_stations
          (id, name, stream_url, home_page_url, created_at, updated_at)
          VALUES (${esc(id)}, ${esc(input.name)},
          ${esc(input.streamUrl)}, ${
            input.homePageUrl === null ? 'NULL' : esc(input.homePageUrl)
          }, now(), now())`,
        );
        return (await get(q, id))!;
      });
    },
    update(id: string, input: StationInput): Promise<StationRow | null> {
      return atomic(engine, async (q) => {
        await q.run(`UPDATE radio_stations SET name = ${esc(input.name)},
          stream_artwork = CASE WHEN stream_url = ${
          esc(input.streamUrl)
        } THEN stream_artwork ELSE NULL END,
          stream_url = ${esc(input.streamUrl)},
          home_page_url = ${
          input.homePageUrl === null ? 'NULL' : esc(input.homePageUrl)
        },
          updated_at = now() WHERE id = ${esc(id)}`);
        return await get(q, id);
      });
    },
    delete(id: string): Promise<boolean> {
      return atomic(engine, async (q) => {
        if (await get(q, id) === null) return false;
        await q.run(`DELETE FROM radio_stations WHERE id = ${esc(id)}`);
        return true;
      });
    },
    artwork(id: string): Promise<string | null | undefined> {
      return engine.exclusive(async (q) => {
        const rows = await q.all<{ payload: string | null }>(
          `SELECT uploaded_artwork AS payload FROM radio_stations WHERE id = ${
            esc(id)
          }`,
        );
        return rows[0]?.payload;
      });
    },
    streamArtwork(id: string): Promise<string | null | undefined> {
      return engine.exclusive(async (q) => {
        const rows = await q.all<{ payload: string | null }>(
          `SELECT stream_artwork AS payload FROM radio_stations WHERE id = ${
            esc(id)
          }`,
        );
        return rows[0]?.payload;
      });
    },
    setStreamArtwork(id: string, streamUrl: string, payload: string | null) {
      return atomic(engine, async (q) => {
        const rows = await q.all<{ previous: string | null }>(
          `SELECT stream_artwork AS previous FROM radio_stations
           WHERE id = ${esc(id)} AND stream_url = ${esc(streamUrl)}`,
        );
        if (!rows.length) return null;
        await q.run(
          `UPDATE radio_stations SET stream_artwork = ${
            payload === null ? 'NULL' : esc(payload)
          }
          WHERE id = ${esc(id)} AND stream_url = ${esc(streamUrl)}`,
        );
        return rows[0];
      });
    },
    imagePayloads(): Promise<string[]> {
      return engine.exclusive(async (q) =>
        (await q.all<{ payload: string }>(
          `SELECT uploaded_artwork AS payload FROM radio_stations WHERE uploaded_artwork IS NOT NULL
           UNION ALL SELECT stream_artwork AS payload FROM radio_stations WHERE stream_artwork IS NOT NULL`,
        )).map((row) => row.payload)
      );
    },
    setArtwork(id: string, payload: string | null) {
      return atomic(engine, async (q) => {
        const rows = await q.all<{ previous: string | null }>(
          `SELECT uploaded_artwork AS previous FROM radio_stations WHERE id = ${
            esc(id)
          }`,
        );
        if (!rows.length) return null;
        await q.run(
          `UPDATE radio_stations SET uploaded_artwork = ${
            payload === null ? 'NULL' : esc(payload)
          },
          updated_at = now() WHERE id = ${esc(id)}`,
        );
        return rows[0];
      });
    },
  };
}
