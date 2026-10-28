import { assert, assertEquals } from '@std/assert';
import { apiFixture } from './helpers/api.ts';
import { tagged } from './helpers/tagged.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { scanLibrary } from '../src/scan.ts';

const names = [
  'Zulu',
  'élan',
  'ELAN',
  'Elan',
  'deadmau5',
  'The Alpha',
  'alpha',
];
const binaryNames = [
  'ELAN',
  'Elan',
  'The Alpha',
  'Zulu',
  'alpha',
  'deadmau5',
  'élan',
];
type Entity = 'artists' | 'albums' | 'songs' | 'genres';
type Row = { id?: string | null; name?: string | null; title?: string | null };

async function nameFixture(entity: Entity) {
  const root = await Deno.makeTempDir({ prefix: 'melofon-api-name-order-' });
  try {
    const f = await apiFixture({
      services: async (f) => {
        const libraries = createLibraries(f.store, { notify: f.notify });
        await libraries.add('Music', root);
        for (const [i, name] of names.entries()) {
          await Deno.mkdir(`${root}/${i}`);
          await tagged(`${root}/${i}/song.mp3`, {
            TIT2: name,
            TALB: name,
            TPE1: entity === 'artists' ? name : 'Member',
            TPE2: entity === 'artists' ? name : 'Member',
            TCON: entity === 'genres' ? name : 'Fixture',
            TDRC: '2000',
          });
        }
        await scanLibrary(f.store);
        return { libraries, library: createLibrary(f.store) };
      },
    });
    await f.auth.users.create(f.admin.id, {
      username: 'listener',
      password: 'password-listener',
      role: 'user',
    });
    return {
      ...f,
      async close() {
        await f.close();
        await Deno.remove(root, { recursive: true });
      },
    };
  } catch (error) {
    await Deno.remove(root, { recursive: true });
    throw error;
  }
}

for (const entity of ['artists', 'albums', 'songs', 'genres'] as const) {
  Deno.test(`API ${entity}: native name pages fold case and accents with stable identity ties`, async () => {
    const f = await nameFixture(entity);
    try {
      const label = (row: Row) => entity === 'songs' ? row.title! : row.name!;
      // Exercise unoptioned core reads separately: other hats keep binary order.
      const options = { offset: 0, limit: 50 };
      const legacy = entity === 'artists'
        ? await f.store.catalog.artistsPage(options)
        : entity === 'albums'
        ? await f.store.catalog.albumsPage({ ...options, sort: 'name' })
        : entity === 'songs'
        ? await f.store.catalog.songsPage({ ...options, sort: 'name' })
        : await f.store.catalog.genresPage(options);
      assertEquals(legacy.rows.map(label), binaryNames);
      const rows = legacy.rows as Row[];
      const ties = rows.filter((row) =>
        ['ELAN', 'Elan', 'élan'].includes(label(row))
      )
        .sort((a, b) => {
          const left = entity === 'genres' ? a.name! : a.id!;
          const right = entity === 'genres' ? b.name! : b.id!;
          return left < right ? -1 : left > right ? 1 : 0;
        });
      const expected = [
        rows.find((row) => label(row) === 'alpha')!,
        rows.find((row) => label(row) === 'deadmau5')!,
        ...ties,
        rows.find((row) => label(row) === 'The Alpha')!,
        rows.find((row) => label(row) === 'Zulu')!,
      ];
      const identity = (row: Row) => entity === 'genres' ? row.name : row.id;
      const wanted = expected.map(identity);
      const library = (await f.store.catalog.listLibraries())[0];
      const paths = [`/api/v1/${entity}`];
      if (entity === 'albums') {
        const member = (await f.store.catalog.listArtists())[0];
        const memberships = await f.store.catalog.artistAlbumsPage(
          { kind: 'artist', id: member.id },
          options,
        );
        assertEquals(memberships.rows.map(label), binaryNames);
        paths.push(`/api/v1/artists/${member.id}/albums`);
      }
      for (const use of ['cookie', 'bearer'] as const) {
        const { credential } = await f.login(
          use,
          'listener',
          'password-listener',
        );
        const read = async (path: string) => {
          const response = await f.get(path, credential, { Origin: f.origin });
          assertEquals(response.status, 200, await response.clone().text());
          return await response.json();
        };
        for (const path of paths) {
          for (const scope of ['', `library=${library.id}`]) {
            const query = scope ? `?${scope}&` : '?';
            const all = await read(path + query + 'sort=name');
            assertEquals(all.total, names.length);
            assertEquals(all[entity].map(identity), wanted);
            assertEquals(
              (await read(path + (scope ? `?${scope}` : '')))[entity],
              all[entity],
            );
            const joined: Row[] = [];
            for (let offset = 0; offset <= names.length; offset++) {
              const page = await read(
                `${path}${query}sort=name&limit=1&offset=${offset}`,
              );
              assertEquals(page.total, names.length);
              assertEquals(
                page[entity].map(identity),
                wanted.slice(offset, offset + 1),
              );
              joined.push(...page[entity]);
            }
            assertEquals(joined, all[entity]);
            // Artist/year modes also sort by name within this fixture's ties;
            // genre mode is a genre-filtered name page, not a different key.
            if (
              path === `/api/v1/${entity}` &&
              (entity === 'albums' || entity === 'songs')
            ) {
              for (const sort of ['artist', 'year', 'genre&genre=Fixture']) {
                assertEquals(
                  (await read(`${path}${query}sort=${sort}`))[entity].map(
                    identity,
                  ),
                  wanted,
                );
              }
            }
          }
        }
      }
      assert(f.origin.startsWith('http://melofon.home:'));
      assert(
        f.peers.length > 0 &&
          f.peers.every((p) => p !== '127.0.0.1' && p !== '::1'),
      );
    } finally {
      await f.close();
    }
  });
}
