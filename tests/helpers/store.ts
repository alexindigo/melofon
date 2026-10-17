import { type Engine, openEngine } from '../../src/store/engine.ts';

/** Real engine with a one-shot commit fault, to observe rollback at consumers. */
export async function domainFixture<T>(factory: (engine: Engine) => T) {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-store-' });
  const engine = await openEngine(dir);
  let failCommit = false;
  const observed: Engine = {
    ...engine,
    exclusive: (fn) =>
      engine.exclusive((q) =>
        fn({
          ...q,
          run(sql) {
            if (failCommit && sql === 'COMMIT') {
              failCommit = false;
              return Promise.reject(new Error('injected commit failure'));
            }
            return q.run(sql);
          },
        })
      ),
  };
  const all = <R = Record<string, unknown>>(sql: string) =>
    engine.exclusive((q) => q.all<R>(sql));
  const run = (sql: string) => engine.exclusive((q) => q.run(sql));
  await run(
    "INSERT INTO users VALUES ('u', 'alice', 'encrypted', now()), ('v', 'bob', 'other', now())",
  );
  await run("INSERT INTO artists VALUES ('artist', 'Artist')");
  await run(
    "INSERT INTO albums (id, name, album_artist_id, artist_kind, folder_name) VALUES ('album', 'Album', 'artist', 'tagged', 'Music')",
  );
  await run(
    "INSERT INTO files (id, path, album_id, artist_id) VALUES ('song', '/song', 'album', 'artist')",
  );
  return {
    domain: factory(observed),
    all,
    run,
    failCommit: () => {
      failCommit = true;
    },
    async close() {
      await engine.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}
