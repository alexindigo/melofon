import { assert, assertEquals } from '@std/assert';
import { apiFixture } from './helpers/api.ts';
import { tagged } from './helpers/tagged.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { scanLibrary } from '../src/scan.ts';

const names = [
  'Épisode 10',
  'episode 2',
  'EPISODE 02',
  'Episode 0002',
  'episode 1',
  'episode 2 part 10',
  'episode 2 part 2',
  'The Episode 3',
  'episode 99999999999999999999',
  'episode 100000000000000000000',
  'Я 10',
  'я 2',
];
type Entity = 'artists' | 'albums' | 'songs' | 'genres';
type Row = {
  id?: string;
  name?: string | null;
  title?: string | null;
  fileName?: string;
  folderName?: string;
};

async function fixture(entity: Entity) {
  const root = await Deno.makeTempDir({ prefix: 'melofon-natural-' });
  try {
    const f = await apiFixture({
      services: async (f) => {
        const libraries = createLibraries(f.store);
        const library = createLibrary(f.store, undefined, { state: f.state });
        for (const part of ['Music', 'Other']) {
          await Deno.mkdir(`${root}/${part}`);
          await libraries.add(part, `${root}/${part}`);
        }
        for (const [i, name] of [...names, 'episode 4'].entries()) {
          // Last row has factual filesystem fallbacks for missing album/song tags.
          const missing = i === names.length &&
            (entity === 'albums' || entity === 'songs');
          const part = i === 0 ? 'Other' : 'Music';
          const dir = `${root}/${part}/${missing ? name : i}`;
          await Deno.mkdir(dir);
          await tagged(`${dir}/${missing ? name : 'song'}.mp3`, {
            TIT2: missing ? '' : name,
            TALB: missing ? '' : name,
            TPE1: entity === 'artists' ? name : 'Member',
            TPE2: entity === 'artists' ? name : 'Member',
            TCON: entity === 'genres' ? name : 'Fixture',
            TDRC: '2000',
          });
        }
        await scanLibrary(f.store);
        return { library, libraries };
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
  Deno.test(`API ${entity}: opt-in natural keys partition real HTTP pages with stable ties`, async () => {
    const f = await fixture(entity);
    try {
      const music = (await f.store.catalog.listLibraries()).find((r) =>
        r.name === 'Music'
      )!;
      const label = (r: Row) =>
        entity === 'songs' ? r.title ?? r.fileName! : r.name ?? r.folderName!;
      const identity = (r: Row) => entity === 'genres' ? r.name! : r.id!;
      const path = `/api/v1/${entity}`;
      const unauthenticated = await f.get(path + '?natural=true');
      assertEquals(unauthenticated.status, 401);
      await unauthenticated.body?.cancel();
      for (const use of ['cookie', 'bearer'] as const) {
        const { credential } = await f.login(
          use,
          'listener',
          'password-listener',
        );
        const read = async (url: string) => {
          const response = await f.get(url, credential, {
            Origin: 'http://foreign.example',
          });
          assertEquals(response.status, 200, await response.clone().text());
          return { response, body: await response.json() };
        };
        for (const scope of ['', `&library=${music.id}`]) {
          const { body: normal } = await read(`${path}?sort=name${scope}`);
          const off = await read(`${path}?sort=name&natural=false${scope}`);
          assertEquals(off.body, normal);
          const rows = normal[entity] as Row[];
          const byLabel = (name: string) =>
            rows.find((r) => label(r) === name)!;
          const ties = ['episode 2', 'EPISODE 02', 'Episode 0002'].map(byLabel)
            .sort((a, b) => identity(a) < identity(b) ? -1 : 1);
          const wanted = [
            byLabel('episode 1'),
            ...ties,
            byLabel('episode 2 part 2'),
            byLabel('episode 2 part 10'),
            byLabel('The Episode 3'),
            byLabel('episode 4'),
            ...(scope ? [] : [byLabel('Épisode 10')]),
            byLabel('episode 99999999999999999999'),
            byLabel('episode 100000000000000000000'),
            byLabel('я 2'),
            byLabel('Я 10'),
          ].map(identity);
          const natural = await read(`${path}?sort=name&natural=true${scope}`);
          assertEquals(natural.body[entity].map(identity), wanted);
          assertEquals(natural.body.total, wanted.length);
          assert(
            natural.response.headers.get('etag') !==
              off.response.headers.get('etag'),
          );
          const repeat = await f.get(
            `${path}?sort=name&natural=true${scope}`,
            credential,
            { 'If-None-Match': natural.response.headers.get('etag')! },
          );
          assertEquals(repeat.status, 304);
          assertEquals(await repeat.text(), '');
          const joined: Row[] = [];
          for (let offset = 0; offset <= wanted.length; offset += 2) {
            const { body } = await read(
              `${path}?natural=true&limit=2&offset=${offset}${scope}`,
            );
            assertEquals(body.total, wanted.length);
            assertEquals(
              body[entity].map(identity),
              wanted.slice(offset, offset + 2),
            );
            joined.push(...body[entity]);
          }
          assertEquals(joined, natural.body[entity]);
          if (entity === 'albums') {
            const artist = (await f.store.catalog.listArtists())[0];
            const membership = await read(
              `/api/v1/artists/${artist.id}/albums?natural=true${scope}`,
            );
            assertEquals(membership.body.albums.map(identity), wanted);
            assertEquals(
              membership.body.albums.find((r: Row) => r.name === null)
                ?.folderName,
              'episode 4',
            );
          }
          if (entity === 'songs') {
            assertEquals(
              natural.body.songs.find((r: Row) => r.title === null)?.fileName,
              'episode 4',
            );
          }
          if (entity !== 'genres') {
            const search = await read(`/api/v1/search?natural=true${scope}`);
            assertEquals(search.body[entity][entity].map(identity), wanted);
          }
          if (entity === 'albums' || entity === 'songs') {
            for (const sort of ['artist', 'year', 'genre&genre=Fixture']) {
              assertEquals(
                (await read(`${path}?sort=${sort}&natural=true${scope}`))
                  .body[entity].map(identity),
                wanted,
              );
            }
          }
        }
        for (const raw of ['', '1', 'TRUE', 'no', 'true&natural=false']) {
          const invalid = await f.get(`${path}?natural=${raw}`, credential);
          assertEquals(invalid.status, 400);
          assertEquals((await invalid.json()).code, 'invalid_field');
        }
      }
      const { credential } = await f.login('bearer');
      const admin = await f.get(path + '?natural=true', credential);
      assertEquals(admin.status, 200);
      await admin.body?.cancel();
      assert(f.origin.startsWith('http://melofon.home:'));
      assert(f.peers.every((p) => p !== '127.0.0.1' && p !== '::1'));
    } finally {
      await f.close();
    }
  });
}
