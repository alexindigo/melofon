import { assertEquals } from '@std/assert';
import { apiFixture } from './api.ts';
import { tagged } from './tagged.ts';
import { createScan } from '../../src/scan.ts';
import { createLibraries } from '../../src/libraries.ts';
import { createLibrary } from '../../src/library.ts';
import { createAnnotation } from '../../src/annotation.ts';
import { createListens } from '../../src/listens.ts';
import { createLogger } from '../../src/logging.ts';
import { freePort } from './api-status.ts';
import { createMedia } from '../../src/media.ts';

export async function scanFixture(
  options: { beforeDescribe?: (path: string) => Promise<void> } = {},
) {
  const root = await Deno.makeTempDir({ prefix: 'melofon-scopes-' });
  const logger = createLogger({ sinks: { stdout() {}, stderr() {} } });
  const f = await apiFixture({
    allLayers: true,
    hats: {
      layersRoot: 'layers',
      env: { MELOFON_LISTEN_owntone: `${freePort()},${freePort()}` },
    },
    status: logger,
    services(f) {
      const media = createMedia();
      return Promise.resolve({
        scan: createScan(f.store, {
          ...media,
          async describeAudio(path) {
            await options.beforeDescribe?.(path);
            return media.describeAudio(path);
          },
        }, {
          state: f.state,
          notify: f.notify,
        }),
        libraries: createLibraries(f.store, { notify: f.notify }),
        library: createLibrary(f.store),
        annotation: createAnnotation(f.store),
        listens: createListens(f.store),
      });
    },
  });
  const cookie = (await f.login('cookie')).credential;
  const bearer = (await f.login('bearer')).credential;
  const get = async (path: string) => {
    const response = await f.get(`/api/v1/${path}`, bearer);
    assertEquals(response.status, 200, await response.clone().text());
    return response.json();
  };
  const idle = async () => {
    for (let n = 0; n < 1000; n++) {
      const { scan } = await get('admin/scans/current');
      if (!scan.scanning) {
        assertEquals(scan.lastError, null);
        return scan;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('Scan timed out');
  };
  const rest = async (op: string, extra: Record<string, string> = {}) => {
    const q = new URLSearchParams({
      u: 'admin',
      p: 'password-admin',
      c: 'a13',
      v: '1.16.1',
      f: 'json',
      ...extra,
    });
    const response = await f.request(`/rest/${op}?${q}`);
    const body = (await response.json())['subsonic-response'];
    assertEquals(body.status, 'ok', JSON.stringify(body));
    return body;
  };
  return {
    ...f,
    root,
    cookie,
    bearer,
    getApi: get,
    rest,
    idle,
    async write(library: string, rel: string, title: string, disc?: number) {
      const path = `${root}/${library}/${rel}`;
      await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), {
        recursive: true,
      });
      await tagged(path, {
        TIT2: title,
        TALB: 'Album',
        TPE1: 'Artist',
        TPE2: 'Artist',
        ...(disc ? { TPOS: `${disc}/2` } : {}),
      });
    },
    async add(name: string) {
      const response = await f.json('/api/v1/admin/libraries', 'POST', {
        name,
        path: `${root}/${name}`,
      }, cookie);
      assertEquals(response.status, 201);
      return (await response.json()).library;
    },
    async scan(scope: unknown = {}) {
      const response = await f.json(
        '/api/v1/admin/scans',
        'POST',
        scope,
        cookie,
      );
      assertEquals(response.status, 202, await response.clone().text());
      await response.json();
      return idle();
    },
    async songs() {
      return (await rest('search3', { query: '' })).searchResult3.song ?? [];
    },
    async close() {
      await idle();
      await f.close();
      await Deno.remove(root, { recursive: true });
    },
  };
}
