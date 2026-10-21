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
          `INSERT INTO radio_stations VALUES (${esc(id)}, ${esc(input.name)},
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
  };
}
