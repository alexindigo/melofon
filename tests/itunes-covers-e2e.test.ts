import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { createState } from '../src/state.ts';
import { createLibraries } from '../src/libraries.ts';
import { createNotify } from '../src/notify.ts';
import { createScan } from '../src/scan.ts';
import { createLibrary } from '../src/library.ts';
import { createArtwork } from '../src/artwork.ts';
import { createUserService } from '../src/user.ts';
import { seedFirstUser } from '../src/users.ts';
import { facade } from '../src/facade.ts';
import { loadLayers } from '../src/layers.ts';
import { createLookupRunner } from '../src/lookups/runner.ts';
import { createLookupNetwork } from '../src/lookups/net.ts';
import { candidateImagePath, imageHash } from '../src/images.ts';
import { eventually } from './helpers/lookup.ts';
import { pictured } from './helpers/pictured.ts';

const AUTH = 'u=admin&p=test&v=1.16.1&c=itunes-e2e';
const bytes = async (response: Response) =>
  new Uint8Array(await response.arrayBuffer());

for (const approved of [true, false]) {
  Deno.test(`iTunes scan -> isolated plugin -> OpenSubsonic getCoverArt, approved=${approved}`, async () => {
    const dir = await Deno.makeTempDir({ prefix: 'melofon-itunes-' });
    const root = `${dir}/music`;
    await Deno.mkdir(root);
    const store = await openStore(`${dir}/data`);
    const state = createState(store);
    const notify = createNotify();
    const libraries = createLibraries(store);
    const library = createLibrary(store);
    const artwork = createArtwork(library);
    const scan = createScan(store, undefined, { notify });
    const image = await Deno.readFile(
      'tests/fixtures/library/Fixture Artist/Fixture Album/cover.jpg',
    );
    const exact = JSON.parse(
      await Deno.readTextFile('tests/fixtures/itunes/exact.json'),
    );
    const close = JSON.parse(
      await Deno.readTextFile('tests/fixtures/itunes/close.json'),
    );
    const hits: URL[] = [];
    const server = Deno.serve(
      { hostname: '127.0.0.1', port: 0, onListen() {} },
      (request) => {
        const url = new URL(request.url);
        hits.push(url);
        if (url.pathname === '/search') {
          assertEquals(url.searchParams.get('country'), 'us');
          assertEquals(url.searchParams.get('entity'), 'album');
          assertEquals(url.searchParams.get('limit'), '8');
          return Response.json(
            url.searchParams.get('term') === 'Abbey Road The Beatles'
              ? exact
              : close,
          );
        }
        assert(url.pathname.endsWith('/1200x1200bb.jpg'));
        return new Response(image, {
          headers: { 'Content-Type': 'image/jpeg' },
        });
      },
    );
    const origin = `http://127.0.0.1:${server.addr.port}`;
    let runner: Awaited<ReturnType<typeof createLookupRunner>> | undefined;
    try {
      const cfg = {
        listen: undefined,
        dataDir: `${dir}/data`,
        user: 'admin',
        password: 'test',
        secret: 'fixture',
        version: '0.0.0-test',
      };
      await seedFirstUser(store, cfg);
      await libraries.add('Music', root);
      // Both albums really lack local artwork. Only the first has an exact artist.
      await pictured(`${root}/Strong/song.mp3`, undefined, {
        TALB: 'Abbey Road',
        TPE2: 'The Beatles',
      });
      await pictured(`${root}/Medium/song.mp3`, undefined, {
        TALB: 'Abbey Road',
        TPE2: 'The Beatle',
      });
      await state.set('lookups.maxAttempts', '1');
      if (approved) {
        await state.set(
          'lookups.plugin.itunes-covers.hosts',
          'itunes.apple.com,*.mzstatic.com',
        );
      }
      runner = await createLookupRunner({
        store,
        state,
        dataDir: cfg.dataDir,
        notify,
        network: createLookupNetwork({
          fixtures: {
            'itunes.apple.com': origin,
            'is1-ssl.mzstatic.com': origin,
          },
        }),
      });
      assertEquals(
        await state.getTyped('lookups.plugin.itunes-covers.hosts'),
        approved ? ['itunes.apple.com', '*.mzstatic.com'] : [],
      );
      if (approved) {
        // Live typed plugin settings reach the Worker on its next generation.
        await state.set(
          'lookups.plugin.itunes-covers.settings.countries',
          'us',
        );
      }
      await scan.run();
      const albums = await store.catalog.listAlbums({
        sort: 'name',
        size: 10,
        offset: 0,
      });
      assertEquals(albums.length, 2);
      await eventually(
        async () =>
          (await store.lookups.stats('itunes-covers'))[
            approved ? 'done' : 'failed'
          ] === 2,
        20000,
      );
      const app = facade(
        await pathfinder({ roots: ['core/'], app: { store, cfg } }),
        await loadLayers({
          app: {
            state,
            cfg,
            libraries,
            library,
            artwork,
            user: createUserService(store, cfg),
          },
        }),
      );
      const placeholder = await bytes(artwork.placeholder());
      for (const album of albums) {
        const response = await app(
          new Request(`http://x/rest/getCoverArt.view?${AUTH}&id=${album.id}`),
        );
        assertEquals(response.status, 200);
        const candidates = await store.candidates.candidatesFor(
          'album',
          album.id,
        );
        if (approved) {
          assertEquals(candidates.length, 1);
          const candidate = candidates[0];
          const strong = album.artistName === 'The Beatles';
          assertEquals(candidate.source, 'itunes-covers');
          assertEquals(candidate.confidence, strong ? 'strong' : 'medium');
          assertEquals(candidate.state, 'open');
          assertEquals(candidate.imageHash, await imageHash(image));
          assertEquals(
            await Deno.readFile(
              candidateImagePath(
                { path: root },
                candidate.imageHash,
                candidate.imageExt,
              ),
            ),
            image,
          );
          assertEquals(candidate.details.country, 'us');
          assertEquals(
            candidate.details.collectionId,
            strong ? 1441164426 : 1441164427,
          );
          assertEquals(await bytes(response), strong ? image : placeholder);
        } else {
          assertEquals(candidates, []);
          assertEquals(await bytes(response), placeholder);
        }
      }
      assertEquals(
        hits.filter((u) => u.pathname === '/search').length,
        approved ? 2 : 0,
      );
      assertEquals(
        hits.filter((u) => u.pathname.endsWith('/1200x1200bb.jpg')).length,
        approved ? 2 : 0,
      );
      if (approved) {
        // Both candidates share a content-addressed image, with no tag writes.
        assertEquals(
          [...Deno.readDirSync(`${root}/.melofon/candidates`)].length,
          1,
        );
        assertEquals(
          [...Deno.readDirSync(`${root}/Strong`)].map((e) => e.name),
          ['song.mp3'],
        );
      } else assertEquals(hits, []);
    } finally {
      await runner?.close();
      await server.shutdown();
      await store.close();
      await Deno.remove(dir, { recursive: true });
    }
  });
}
