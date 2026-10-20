import { assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../../src/store/index.ts';
import { createState } from '../../src/state.ts';
import { createLibraries } from '../../src/libraries.ts';
import { createScan } from '../../src/scan.ts';
import { seedFirstUser } from '../../src/users.ts';
import { createUserService } from '../../src/user.ts';
import { createLibrary } from '../../src/library.ts';
import { createAnnotation } from '../../src/annotation.ts';
import { createListens } from '../../src/listens.ts';
import { loadLayers } from '../../src/layers.ts';
import { facade } from '../../src/facade.ts';
import type { Reference } from '../../src/reference.ts';

export async function referenceFixture() {
  const dir = await Deno.makeTempDir({ prefix: 'reference-match-' });
  const root = `${dir}/music`;
  await Deno.mkdir(root);
  const store = await openStore(`${dir}/data`);
  const state = createState(store);
  const libraries = createLibraries(store);
  await libraries.add('Music', root);
  const cfg = {
    dataDir: `${dir}/data`,
    user: 'admin',
    password: 'test',
    secret: 'secret',
    listen: undefined,
  };
  await seedFirstUser(store, cfg);
  const scan = createScan(store);
  const annotation = createAnnotation(store);
  return {
    dir,
    root,
    store,
    state,
    scan,
    annotation,
    async consumer(reference: Reference) {
      const http = facade(
        await pathfinder({ roots: ['core/'], app: { store, cfg, state } }),
        await loadLayers({
          app: {
            cfg,
            state,
            reference,
            library: createLibrary(store),
            libraries,
            annotation,
            listens: createListens(store),
            user: createUserService(store, cfg),
          },
        }),
      );
      return async (operation: string, params: Record<string, string> = {}) => {
        const query = new URLSearchParams({
          u: 'admin',
          p: 'test',
          v: '1.16.1',
          c: 'g7',
          f: 'json',
          ...params,
        });
        const response = await http(
          new Request(`http://x/rest/${operation}?${query}`),
        );
        assertEquals(response.status, 200);
        const body = (await response.json())['subsonic-response'];
        assertEquals(body.status, 'ok');
        return body;
      };
    },
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}
