import { type Engine, esc, type Queries } from './engine.ts';

/** The hats table's sole writer, including release migration seeds. */
export async function seedShippedHats(q: Queries): Promise<void> {
  for (const name of ['opensubsonic', 'owntone', 'share']) {
    await q.run(`INSERT INTO hats (name, active) VALUES (${esc(name)}, true)
      ON CONFLICT (name) DO NOTHING`);
  }
}

export function createHatsStore(engine: Engine) {
  return {
    list: (): Promise<{ name: string; active: boolean }[]> =>
      engine.exclusive((q) =>
        q.all('SELECT name, active FROM hats ORDER BY name')
      ),
    set: (name: string, active: boolean): Promise<void> =>
      engine.exclusive((q) =>
        q.run(`INSERT INTO hats (name, active) VALUES (${esc(name)}, ${active})
          ON CONFLICT (name) DO UPDATE SET active = excluded.active`)
      ),
  };
}
