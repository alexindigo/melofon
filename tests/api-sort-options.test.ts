import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { apiFixture, error } from './helpers/api.ts';
import { tagged } from './helpers/tagged.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { scanLibrary } from '../src/scan.ts';

const records = [
  ['The Zebra', 'Album 10', '2000'],
  ['Beta', 'Album 2', '2010'],
  ['Éclair', '   ', '2010'],
  ['Alpha', 'The Tagged', '1990'],
  ['Delta', 'Album 02', '1990'],
  ['Я 10', '', '2005'],
  ['я 2', '', '2005'],
  ['123', '', '2020'],
];
type Entity = 'artists' | 'albums' | 'songs';
type Row = {
  id: string;
  name?: string | null;
  title?: string | null;
  fileName?: string;
  folderName?: string;
};
type Index = { key: string; label: string; offset: number; count: number };

async function fixture(entity: Entity) {
  const root = await Deno.makeTempDir({ prefix: 'melofon-sort-options-' });
  try {
    const f = await apiFixture({
      services: async (f) => {
        const libraries = createLibraries(f.store);
        for (const part of ['Music', 'Other', 'Empty']) {
          await Deno.mkdir(`${root}/${part}`);
          await libraries.add(part, `${root}/${part}`);
        }
        for (const [i, [name, sortName, year]] of records.entries()) {
          const dir = `${root}/${i === 0 ? 'Other' : 'Music'}/${i}`;
          await Deno.mkdir(dir);
          await tagged(`${dir}/song.mp3`, {
            TIT2: name,
            TALB: name,
            TPE1: entity === 'albums' ? 'Member' : name,
            TPE2: entity === 'artists' ? name : 'Member',
            TSOT: sortName,
            TSOA: sortName,
            TSOP: sortName,
            TSO2: entity === 'artists' ? sortName : '',
            TCON: 'Fixture',
            TDRC: year,
          });
        }
        if (entity === 'artists') {
          await Deno.mkdir(`${root}/Music/unknown`);
          await tagged(`${root}/Music/unknown/song.mp3`, { TALB: 'Unknown' });
          await Deno.mkdir(`${root}/Music/various`);
          for (const guest of ['Guest One', 'Guest Two']) {
            await tagged(`${root}/Music/various/${guest}.mp3`, {
              TALB: 'Various',
              TPE1: guest,
            });
          }
        } else {
          await Deno.mkdir(`${root}/Music/Gamma 2`);
          await tagged(`${root}/Music/Gamma 2/Gamma 2.mp3`, {
            TPE1: 'Member',
            TPE2: 'Member',
            TCON: 'Fixture',
          });
        }
        await scanLibrary(f.store);
        return {
          libraries,
          library: createLibrary(f.store, undefined, { state: f.state }),
        };
      },
    });
    await f.auth.users.create(f.admin.id, {
      username: 'listener',
      password: 'password-listener',
      role: 'user',
    });
    return {
      ...f,
      root,
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

for (const entity of ['artists', 'albums', 'songs'] as const) {
  Deno.test(`native ${entity}: signed sorts, optional tags and snapshot index agree with HTTP pages`, async () => {
    const f = await fixture(entity);
    try {
      const path = `/api/v1/${entity}`;
      const libraries = await f.store.catalog.listLibraries();
      const music = libraries.find((l) => l.name === 'Music')!.id;
      const empty = libraries.find((l) => l.name === 'Empty')!.id;
      const label = (r: Row) =>
        entity === 'songs' ? r.title ?? r.fileName! : r.name ?? r.folderName!;
      const unauth = await f.get(`${path}?index=true`);
      assertEquals(unauth.status, 401);
      await unauth.body?.cancel();
      for (const mode of ['cookie', 'bearer'] as const) {
        const { credential } = await f.login(
          mode,
          'listener',
          'password-listener',
        );
        const read = async (url: string) => {
          const response = await f.get(url, credential, {
            Origin: 'http://foreign.example',
          });
          assertEquals(response.status, 200, await response.clone().text());
          assertEquals(
            response.headers.get('cache-control'),
            'private, no-cache',
          );
          return {
            body: await response.json(),
            etag: response.headers.get('etag')!,
          };
        };
        for (const scope of ['', `&library=${music}`]) {
          const normal = await read(`${path}?sort=name${scope}`);
          const policy = (await createLibrary(f.store).order()).ignoredArticles;
          const off = await read(`${path}?sort=name&sortTags=false${scope}`);
          assertEquals(off.body, normal.body);
          assert(!('index' in normal.body));
          const rows = normal.body[entity] as Row[];
          const find = (name: string) => rows.find((r) => label(r) === name)!;
          const pair = ['Beta', 'Delta'].map(find).sort((a, b) =>
            a.id < b.id ? -1 : 1
          );
          const suffix = entity === 'artists'
            ? [find('[Unknown Artist]'), find('[Various Artists]')]
            : [];
          // Placeholder names are null; use native reserved IDs rather than their display labels.
          if (entity === 'artists') {
            suffix[0] = rows.find((r) => r.id === 'unknown')!;
            suffix[1] = rows.find((r) => r.id === 'various')!;
          }
          const ordered = [
            find('123'),
            ...pair,
            ...(scope ? [] : [find('The Zebra')]),
            find('Éclair'),
            ...(entity === 'artists' ? [] : [find('Gamma 2')]),
            find('Alpha'),
            find('я 2'),
            find('Я 10'),
          ];
          const expectedIndex: Index[] = [
            { key: '1', label: '1', offset: 0, count: 1 },
            { key: 'A', label: 'A', offset: 1, count: scope ? 2 : 3 },
            { key: 'E', label: 'E', offset: scope ? 3 : 4, count: 1 },
            ...(entity === 'artists'
              ? []
              : [{ key: 'G', label: 'G', offset: scope ? 4 : 5, count: 1 }]),
            { key: 'T', label: 'T', offset: ordered.length - 3, count: 1 },
            { key: 'Я', label: 'Я', offset: ordered.length - 2, count: 2 },
            ...(entity === 'artists'
              ? [
                {
                  key: 'unknown',
                  label: '[Unknown Artist]',
                  offset: ordered.length,
                  count: 1,
                },
                {
                  key: 'various',
                  label: '[Various Artists]',
                  offset: ordered.length + 1,
                  count: 1,
                },
              ]
              : []),
          ];
          for (const descending of [false, true]) {
            // Descending reverses keys, never the final identity tie or placeholder suffix.
            const wanted = descending
              ? [
                find('Я 10'),
                find('я 2'),
                find('Alpha'),
                ...(entity === 'artists' ? [] : [find('Gamma 2')]),
                find('Éclair'),
                ...(scope ? [] : [find('The Zebra')]),
                ...pair,
                find('123'),
              ]
              : ordered;
            const query = `sort=${
              descending ? '-name' : 'name'
            }&natural=true&sortTags=true&index=true${scope}`;
            const all = await read(`${path}?${query}`);
            assertEquals(all.body[entity], [...wanted, ...suffix]);
            assertEquals(all.body.total, rows.length);
            assertEquals(all.body.ignoredArticles, policy);
            assertNotEquals(all.etag, normal.etag);
            if (!descending) assertEquals(all.body.index, expectedIndex);
            else {
              let offset = 0;
              const expected = expectedIndex.filter((r) =>
                !['unknown', 'various'].includes(r.key)
              ).reverse().map((r) => {
                const result = { ...r, offset };
                offset += r.count;
                return result;
              });
              assertEquals(all.body.index, [
                ...expected,
                ...expectedIndex.filter((r) =>
                  ['unknown', 'various'].includes(r.key)
                ),
              ]);
            }
            const joined = [];
            for (let offset = 0; offset <= rows.length; offset += 2) {
              const page = await read(
                `${path}?${query}&offset=${offset}&limit=2`,
              );
              assertEquals(page.body.index, all.body.index);
              assertEquals(page.body.total, rows.length);
              joined.push(...page.body[entity]);
            }
            assertEquals(joined, all.body[entity]);
            for (const entry of all.body.index as Index[]) {
              const section = await read(
                `${path}?${query}&offset=${entry.offset}&limit=${entry.count}`,
              );
              assertEquals(
                section.body[entity],
                all.body[entity].slice(
                  entry.offset,
                  entry.offset + entry.count,
                ),
              );
            }
            const repeat = await f.get(`${path}?${query}`, credential, {
              'If-None-Match': all.etag,
            });
            assertEquals(repeat.status, 304);
            assertEquals(await repeat.text(), '');
            const cross = await f.get(
              `${path}?${query.replace('index=true', 'index=false')}`,
              credential,
              { 'If-None-Match': all.etag },
            );
            assertEquals(cross.status, 200);
            assert(!('index' in await cross.json()));
            if (entity === 'albums') {
              const artist = (await f.store.catalog.listArtists())[0];
              const membership = await read(
                `/api/v1/artists/${artist.id}/albums?${query}`,
              );
              assertEquals(membership.body, all.body);
            }
          }
          const lexicalTags = await read(`${path}?sortTags=true${scope}`);
          assertEquals(
            lexicalTags.body[entity].map((r: Row) => r.id),
            [
              find('123'),
              find('Delta'),
              ...(scope ? [] : [find('The Zebra')]),
              find('Beta'),
              find('Éclair'),
              ...(entity === 'artists' ? [] : [find('Gamma 2')]),
              find('Alpha'),
              find('Я 10'),
              find('я 2'),
              ...suffix,
            ].map((r) => r.id),
          );
          // Without sort tags, articles still determine index initials, not displayed names.
          const raw = await read(`${path}?index=true${scope}`);
          assert((raw.body.index as Index[]).some((r) => r.key === 'A'));
          assertEquals(
            (raw.body.index as Index[]).find((r) => r.key === 'Z')?.count,
            scope ? undefined : 1,
          );
          assert(!(raw.body.index as Index[]).some((r) => r.key === 'T'));
          const search = await read(
            `/api/v1/search?sortTags=true&natural=true${scope}`,
          );
          assertEquals(search.body[entity][entity], ordered);
          if (entity !== 'artists') {
            const years = await read(
              `${path}?sort=-year&natural=true&sortTags=true${scope}`,
            );
            assertEquals(years.body[entity].map(label), [
              '123',
              'Éclair',
              'Beta',
              'Я 10',
              'я 2',
              ...(scope ? [] : ['The Zebra']),
              'Alpha',
              'Delta',
              'Gamma 2',
            ]);
            const names = await read(
              `${path}?sort=-name&natural=true&sortTags=true${scope}`,
            );
            for (const sort of ['-genre&genre=Fixture', '-artist']) {
              const result = await read(
                `${path}?sort=${sort}&natural=true&sortTags=true${scope}`,
              );
              // Album artists are the one common Member, so name subkeys decide.
              if (entity === 'albums' || sort.startsWith('-genre')) {
                assertEquals(result.body[entity], names.body[entity]);
              } else {assertEquals(result.body[entity].map(label), [
                  'Я 10',
                  'я 2',
                  'Alpha',
                  'Gamma 2',
                  'Éclair',
                  ...(scope ? [] : ['The Zebra']),
                  ...pair.map(label),
                  '123',
                ]);}
            }
          }
        }
        const emptyPage = await read(
          `${path}?index=true&library=${empty}&offset=100`,
        );
        assertEquals(emptyPage.body, {
          [entity]: [],
          index: [],
          ignoredArticles:
            (await createLibrary(f.store).order()).ignoredArticles,
          total: 0,
          offset: 100,
          limit: 50,
        });
        const missing = await f.get(
          `${path}?index=true&library=missing`,
          credential,
          { 'If-None-Match': '*' },
        );
        await error(missing, 404, 'not_found');
        for (
          const query of [
            'sort=--name',
            'sort=+name',
            'sort=NAME',
            'sort=name&sort=-name',
            'sortTags=',
            'sortTags=1',
            'sortTags=TRUE',
            'sortTags=true&sortTags=false',
            'index=',
            'index=1',
            'index=true&index=false',
            'natural=true&natural=false',
            ...(entity === 'artists' ? ['sort=-year'] : [
              'sort=-random&seed=x',
              'sort=-starred',
              'sort=year&index=true',
              'sort=random&seed=x&index=true',
            ]),
          ]
        ) {
          await error(
            await f.get(`${path}?${query}`, credential),
            400,
            'invalid_field',
          );
        }
      }
      const admin = (await f.login('bearer')).credential;
      const response = await f.get(`${path}?index=true&sortTags=true`, admin);
      assertEquals(response.status, 200);
      await response.body?.cancel();
      // Direct core callers remain opt-in, independently of the native parser.
      const options = {
        ignoredArticles: (await createLibrary(f.store).order()).ignoredArticles,
        offset: 0,
        limit: 50,
      };
      const core = entity === 'artists'
        ? await f.store.catalog.artistsPage(options)
        : entity === 'albums'
        ? await f.store.catalog.albumsPage({ ...options, sort: 'name' })
        : await f.store.catalog.songsPage({ ...options, sort: 'name' });
      const explicit = entity === 'artists'
        ? await f.store.catalog.artistsPage({ ...options, sortTags: false })
        : entity === 'albums'
        ? await f.store.catalog.albumsPage({
          ...options,
          sort: 'name',
          sortTags: false,
        })
        : await f.store.catalog.songsPage({
          ...options,
          sort: 'name',
          sortTags: false,
        });
      assertEquals(core, explicit);
      assert(!('index' in core));
      const beforeArticles = await f.get(`${path}?index=true`, admin);
      assertEquals(beforeArticles.status, 200);
      await beforeArticles.body?.cancel();
      const edited = await f.json('/api/v1/admin/settings', 'PATCH', {
        changes: [{ key: 'catalog.ignoredArticles', value: [] }],
      }, admin);
      assertEquals(edited.status, 200);
      await edited.body?.cancel();
      const afterArticles = await f.get(`${path}?index=true`, admin, {
        'If-None-Match': beforeArticles.headers.get('etag')!,
      });
      assertEquals(afterArticles.status, 200);
      const articleBody = await afterArticles.json();
      assertEquals(articleBody.ignoredArticles, []);
      assertEquals(
        articleBody.index.find((r: Index) => r.key === 'Z'),
        undefined,
      );
      const tGroup = articleBody.index.find((r: Index) =>
        r.key === 'T'
      ) as Index;
      assertEquals(tGroup.count, 1);
      assertEquals(label(articleBody[entity][tGroup.offset]), 'The Zebra');
      if (entity !== 'artists') {
        // A new real scan observation makes newest reversal observable, and changes index validators.
        const previousEtag = response.headers.get('etag')!;
        await Deno.mkdir(`${f.root}/Music/Latest`);
        await tagged(`${f.root}/Music/Latest/latest.mp3`, {
          TIT2: 'Latest',
          TALB: 'Latest',
          TPE1: 'Member',
          TPE2: 'Member',
        });
        await scanLibrary(f.store);
        const newest = await f.get(`${path}?sort=newest`, admin);
        assertEquals(newest.status, 200);
        assertEquals(label((await newest.json())[entity][0]), 'Latest');
        const oldest = await f.get(`${path}?sort=-newest`, admin);
        assertEquals(oldest.status, 200);
        assertEquals(label((await oldest.json())[entity].at(-1)), 'Latest');
        const changed = await f.get(`${path}?index=true&sortTags=true`, admin, {
          'If-None-Match': previousEtag,
        });
        assertEquals(changed.status, 200);
        assertNotEquals(changed.headers.get('etag'), previousEtag);
        const body = await changed.json();
        assertEquals(body.total, core.total + 1);
        assertEquals(body.index.find((r: Index) => r.key === 'L')?.count, 1);
        assertEquals(
          body.index.reduce((n: number, r: Index) => n + r.count, 0),
          body.total,
        );
      }
      assert(f.peers.every((peer) => peer !== '127.0.0.1' && peer !== '::1'));
    } finally {
      await f.close();
    }
  });
}
