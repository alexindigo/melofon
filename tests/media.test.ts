// tests/media.test.ts — M3 media-retrieval leftovers over the opensubsonic
// hat: getScanStatus/startScan (with Navidrome's folderCount/lastScan
// extras), download (stream bytes + Content-Disposition), getLyrics
// (embedded USLT only), and the bookmark trio.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openDb } from '../src/db.ts';
import { seedFirstUser } from '../src/users.ts';
import { createScan } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createUserService } from '../src/user.ts';
import { createLibrary } from '../src/library.ts';
import { createBookmarks } from '../src/bookmarks.ts';
import { createStream } from '../src/stream.ts';

const AUTH = 'u=admin&p=test&v=1.16.1&c=melofon-test';

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-media-' });
  const db = await openDb(dir);
  const cfg = {
    listen: undefined,
    dataDir: dir,
    user: 'admin',
    password: 'test',
    secret: 's3cret',
    version: '0.0.0-test',
  };
  await seedFirstUser(db, cfg);
  const libraries = createLibraries(db);
  await libraries.add('Music', 'tests/fixtures/library');
  const scan = createScan(db);
  await scan.run();
  const bag = {
    cfg,
    libraries,
    scan,
    user: createUserService(db, cfg),
    library: createLibrary(db),
    bookmarks: createBookmarks(db),
    stream: createStream(),
  };
  const app = await pathfinder({ roots: ['layers/opensubsonic/'], app: bag });
  const songIds = (await db.conn.runAndReadAll(
    "SELECT id, title FROM files WHERE title = 'First Song'",
  )).getRowObjects() as { id: string; title: string }[];
  return {
    db,
    app,
    scan,
    songIds,
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
    new Request(`http://x/rest/${op}.view?${AUTH}&f=json${extra}`),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  return (body as Record<string, Envelope>)['subsonic-response'];
}

Deno.test('getScanStatus reports the boot scan; startScan rescans', async () => {
  const { app, scan, close } = await setup();
  try {
    const before = await get(app, 'getScanStatus');
    const beforeStatus = before.scanStatus as Record<string, unknown>;
    assertEquals(beforeStatus.scanning, false);
    assertEquals(beforeStatus.count, 3);
    assertEquals(beforeStatus.folderCount, 1);
    assertEquals(typeof beforeStatus.lastScan, 'string');

    const kicked = await get(app, 'startScan');
    assertEquals((kicked.scanStatus as { scanning: boolean }).scanning, true);
    for (let i = 0; i < 200; i++) {
      if (!(await scan.status()).scanning) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const after = await get(app, 'getScanStatus');
    const afterStatus = after.scanStatus as Record<string, unknown>;
    assertEquals(afterStatus.scanning, false);
    assertEquals(afterStatus.count, 3);
  } finally {
    await close();
  }
});

Deno.test('download serves the original bytes as an attachment', async () => {
  const { app, songIds, close } = await setup();
  try {
    const song = songIds[0];
    const res = await app(
      new Request(`http://x/rest/download.view?${AUTH}&id=${song.id}`),
    );
    assertEquals(res.status, 200);
    const disposition = res.headers.get('content-disposition') ?? '';
    assert(disposition.startsWith('attachment; filename="'));
    assert(disposition.endsWith('.mp3"'));
    const original = await Deno.readFile(
      `tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3`,
    );
    assertEquals(new Uint8Array(await res.arrayBuffer()), original);

    const bogus = await get(app, 'download', '&id=no-such-song');
    assertEquals((bogus.error as { code: number }).code, 70);
  } finally {
    await close();
  }
});

Deno.test('getLyrics returns embedded lyrics, empty element when none', async () => {
  const { app, close } = await setup();
  try {
    const body = await get(
      app,
      'getLyrics',
      '&artist=Probe%20Performer&title=Theme',
    );
    assertEquals(body.lyrics, {
      artist: 'Probe Performer',
      title: 'Theme',
      value: 'Line one of the theme\nLine two of the theme',
    });

    const noTag = await get(app, 'getLyrics', '&title=First%20Song');
    assertEquals(noTag.lyrics, {});
    const noSong = await get(app, 'getLyrics', '&title=No%20Such%20Song');
    assertEquals(noSong.lyrics, {});

    const res = await app(
      new Request(
        `http://x/rest/getLyrics.view?${AUTH}&artist=Probe%20Performer&title=Theme`,
      ),
    );
    const xml = await res.text();
    assert(
      xml.includes(
        '<lyrics artist="Probe Performer" title="Theme">Line one of the theme',
      ),
      `lyrics is mixed content in XML, got: ${xml}`,
    );
  } finally {
    await close();
  }
});

Deno.test('bookmarks: create, list, update, delete', async () => {
  const { app, songIds, close } = await setup();
  try {
    const song = songIds[0];
    await get(
      app,
      'createBookmark',
      `&id=${song.id}&position=42000&comment=good%20part`,
    );
    const listed = await get(app, 'getBookmarks');
    const first = (listed.bookmarks as {
      bookmark: Record<string, unknown>[];
    }).bookmark;
    assertEquals(first.length, 1);
    assertEquals(first[0].position, 42000);
    assertEquals(first[0].comment, 'good part');
    assertEquals(first[0].username, 'admin');
    assertEquals((first[0].entry as { title: string }).title, song.title);
    assertEquals(typeof first[0].created, 'string');

    // Upsert: same track moves position, keeps one row.
    await get(app, 'createBookmark', `&id=${song.id}&position=99000`);
    const updated = await get(app, 'getBookmarks');
    const rows = (updated.bookmarks as { bookmark: Record<string, unknown>[] })
      .bookmark;
    assertEquals(rows.length, 1);
    assertEquals(rows[0].position, 99000);
    assertEquals(rows[0].created, first[0].created);

    await get(app, 'deleteBookmark', `&id=${song.id}`);
    const empty = await get(app, 'getBookmarks');
    assertEquals(
      (empty.bookmarks as { bookmark: unknown[] }).bookmark.length,
      0,
    );
    // Idempotent delete of an unknown id is ok, not an error.
    const again = await get(app, 'deleteBookmark', '&id=no-such-track');
    assertEquals(again.status, 'ok');
  } finally {
    await close();
  }
});
