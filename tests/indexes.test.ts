// tests/indexes.test.ts — M3 simulated folder browse: getIndexes buckets the
// album artists (musicFolderId-aware), getMusicDirectory resolves artist ids
// to album directories and album ids to song children, all in the Navidrome
// /Artist/Album/01 - Song.mp3 shape.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { seedFirstUser } from '../src/users.ts';
import { createScan } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createUserService } from '../src/user.ts';
import { createLibrary } from '../src/library.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { loadLayers } from '../src/layers.ts';
import { facade } from '../src/facade.ts';

const AUTH = 'u=admin&p=test&v=1.16.1&c=melofon-test';

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-idx-' });
  const store = await openStore(dir);
  const db = store.legacy;
  const cfg = {
    listen: undefined,
    dataDir: dir,
    user: 'admin',
    password: 'test',
    secret: 's3cret',
    version: '0.0.0-test',
  };
  await seedFirstUser(store, cfg);
  const libraries = createLibraries(db);
  await libraries.add('Music', 'tests/fixtures/library');
  const scan = createScan(db);
  await scan.run();
  const bag = {
    cfg,
    libraries,
    scan,
    user: createUserService(store, cfg),
    library: createLibrary(db),
    annotation: createAnnotation(db),
    listens: createListens(store),
  };
  const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
  const app = facade(core, await loadLayers({ app: bag }));
  return {
    db,
    app,
    close: async () => {
      db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

type Envelope = Record<string, unknown> & { status: string };

async function get(
  app: (req: Request) => Promise<Response>,
  op: string,
  extra = '',
): Promise<Envelope> {
  const res = await app(
    new Request(`http://x/rest/${op}?${AUTH}&f=json${extra}`),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  return (body as Record<string, Envelope>)['subsonic-response'];
}

Deno.test('getIndexes buckets album artists; musicFolderId filters', async () => {
  const { app, close } = await setup();
  try {
    const body = await get(app, 'getIndexes');
    const indexes = body.indexes as {
      ignoredArticles: string;
      lastModified: number;
      index: { name: string; artist: { id: string; name: string }[] }[];
    };
    assertEquals(typeof indexes.ignoredArticles, 'string');
    // Required by the OpenSubsonic schema: epoch ms of the last scan.
    assertEquals(typeof indexes.lastModified, 'number');
    assert(indexes.lastModified > 0);
    assertEquals(
      indexes.index.map((i) => [i.name, i.artist.map((a) => a.name)]),
      [['F', ['Fixture Artist']], ['V', ['Various Artists']]],
    );

    const folders = await get(app, 'getMusicFolders');
    const folderId = (
      folders.musicFolders as { musicFolder: { id: string }[] }
    ).musicFolder[0].id;
    const inFolder = await get(app, 'getIndexes', `&musicFolderId=${folderId}`);
    assertEquals(
      (inFolder.indexes as { index: unknown[] }).index.length,
      2,
    );
    const empty = await get(app, 'getIndexes', '&musicFolderId=bogus');
    assertEquals((empty.indexes as { index: unknown[] }).index.length, 0);
  } finally {
    await close();
  }
});

Deno.test('getMusicDirectory walks artist → album → songs', async () => {
  const { app, close } = await setup();
  try {
    const indexes = await get(app, 'getIndexes');
    const artists = (indexes.indexes as {
      index: { artist: { id: string; name: string }[] }[];
    }).index.flatMap((i) => i.artist);
    const fixture = artists.find((a) => a.name === 'Fixture Artist')!;

    const artistDir = await get(app, 'getMusicDirectory', `&id=${fixture.id}`);
    const dir = artistDir.directory as {
      id: string;
      name: string;
      child: Record<string, unknown>[];
    };
    assertEquals(dir.id, fixture.id);
    assertEquals(dir.name, 'Fixture Artist');
    assertEquals(dir.child.length, 1);
    assertEquals(dir.child[0].isDir, true);
    assertEquals(dir.child[0].title, 'Fixture Album');
    assertEquals(dir.child[0].parent, fixture.id);

    const albumDir = await get(
      app,
      'getMusicDirectory',
      `&id=${dir.child[0].id}`,
    );
    const album = albumDir.directory as {
      id: string;
      name: string;
      parent: string;
      child: Record<string, unknown>[];
    };
    assertEquals(album.name, 'Fixture Album');
    assertEquals(album.parent, fixture.id);
    assertEquals(
      album.child.map((c) => [c.title, c.path, c.isDir, c.parent]),
      [
        [
          'First Song',
          'Fixture Artist/Fixture Album/01 - First Song.mp3',
          false,
          album.id,
        ],
        [
          'Second Song',
          'Fixture Artist/Fixture Album/02 - Second Song.mp3',
          false,
          album.id,
        ],
        [
          'Clip',
          'Fixture Artist/Fixture Album/03 - Clip.mp4',
          false,
          album.id,
        ],
      ],
    );

    const bogus = await get(app, 'getMusicDirectory', '&id=no-such-dir');
    assertEquals((bogus.error as { code: number }).code, 70);
  } finally {
    await close();
  }
});

Deno.test('getIndexes renders as XML', async () => {
  const { app, close } = await setup();
  try {
    const res = await app(
      new Request(`http://x/rest/getIndexes?${AUTH}`),
    );
    assertEquals(res.status, 200);
    const xml = await res.text();
    assert(xml.includes('<indexes ignoredArticles='));
    assert(xml.includes('<index name="F">'));
    assert(xml.includes('<artist id="'));
  } finally {
    await close();
  }
});
