import { assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore, type Store } from '../../src/store/index.ts';
import { rawSql } from '../../src/store/testing.ts';
import { encryptPassword, seedFirstUser } from '../../src/users.ts';
import { createUserService } from '../../src/user.ts';
import { createLibraries } from '../../src/libraries.ts';
import { createLibrary } from '../../src/library.ts';
import { createState } from '../../src/state.ts';
import { createPlaylists } from '../../src/playlists.ts';
import { createShares } from '../../src/shares.ts';
import { createAnnotation } from '../../src/annotation.ts';
import { createListens } from '../../src/listens.ts';
import { createArtwork } from '../../src/artwork.ts';
import { scanLibrary } from '../../src/scan.ts';
import { facade } from '../../src/facade.ts';
import { loadLayers } from '../../src/layers.ts';

export const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
export type Params = Record<string, string | string[]>;
export interface Playlist {
  id: string;
  owner: string;
  public: boolean;
  readonly: boolean;
  name: string;
  songCount: number;
  duration: number;
  coverArt: string;
  entry: { id: string; duration: number }[];
}
export interface Envelope {
  status: string;
  error?: { code: number };
  playlist: Playlist;
  playlists: { playlist: Playlist[] };
  user: { username: string; adminRole: boolean; folder: number[] };
  users: { user: Envelope['user'][] };
}

export async function h9Facade(store: Store, dir: string) {
  const cfg = {
    listen: undefined,
    dataDir: dir,
    user: 'admin',
    password: 'test',
    secret: 'h9-secret',
    version: 'h9-test',
  };
  const libraries = createLibraries(store);
  const library = createLibrary(store);
  const state = createState(store);
  const playlists = createPlaylists(store);
  const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
  const layers = await loadLayers({
    app: {
      cfg,
      libraries,
      library,
      state,
      playlists,
      shares: createShares(store, state, library, playlists),
      user: createUserService(store, cfg),
      annotation: createAnnotation(store),
      listens: createListens(store),
      artwork: createArtwork(library, { state, dataDir: dir, playlists }),
    },
  });
  const app = facade(core, layers);
  const own = facade(core, layers, {
    listenPort: 3689,
    defaultPort: 4534,
    env: {},
  });
  const request = (
    op: string,
    params: Params = {},
    user = 'admin',
    post = false,
  ) => {
    const p = new URLSearchParams({
      u: user,
      p: 'test',
      v: '1.16.1',
      c: 'h9',
      f: 'json',
    });
    for (const [key, value] of Object.entries(params)) {
      p.delete(key);
      for (const v of Array.isArray(value) ? value : [value]) p.append(key, v);
    }
    return app(
      post
        ? new Request(`http://x/rest/${op}`, { method: 'POST', body: p })
        : new Request(`http://x/rest/${op}?${p}`),
    );
  };
  const get = async (
    op: string,
    params: Params = {},
    user = 'admin',
    post = false,
  ): Promise<Envelope> => {
    const res = await request(op, params, user, post);
    assertEquals(res.status, 200);
    return (await res.json())['subsonic-response'];
  };
  const ok = async (
    op: string,
    params: Params = {},
    user = 'admin',
    post = false,
  ) => {
    const result = await get(op, params, user, post);
    assertEquals(result.status, 'ok', JSON.stringify(result));
    return result;
  };
  const error = async (
    code: number,
    op: string,
    params: Params = {},
    user = 'admin',
  ) => {
    const result = await get(op, params, user);
    assertEquals(
      [result.status, result.error?.code],
      ['failed', code],
      `${user} ${op}`,
    );
  };
  return {
    cfg,
    libraries,
    request,
    get,
    ok,
    error,
    own: async (path: string) => {
      const res = await own(new Request(`http://x/api/${path}`));
      assertEquals(res.status, 200);
      return await res.json();
    },
  };
}

export async function h9Setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-h9-' });
  const store = await openStore(dir);
  const api = await h9Facade(store, dir);
  await seedFirstUser(store, api.cfg);
  const password = quote(await encryptPassword(api.cfg.secret, 'test'));
  for (const name of ['alice', 'bob']) {
    await rawSql(store).run(
      `INSERT INTO users (id, name, password_enc, created_at) VALUES ('${name}', '${name}', ${password}, now())`,
    );
  }
  await api.libraries.add('Music', 'tests/fixtures/library');
  await scanLibrary(store);
  const songs = await rawSql(store).all<{ id: string; duration_ms: number }>(
    'SELECT id, duration_ms FROM files ORDER BY path',
  );
  return {
    ...api,
    store,
    songs,
    dir,
    close: async () => {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}
