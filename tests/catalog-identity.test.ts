import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { encodeHex } from '@std/encoding/hex';
import type { Db } from '../src/db.ts';
import { openStore } from '../src/store/index.ts';
import { createMedia } from '../src/media.ts';
import { createScan, scanLibrary } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { seedFirstUser } from '../src/users.ts';

const MP3 =
  'tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3';
const SECOND =
  'tests/fixtures/library/Fixture Artist/Fixture Album/02 - Second Song.mp3';

interface IdentityEvent {
  seq: number;
  occurredAtMs: number;
  kind: string;
  fileId: string;
  fingerprint: string | null;
  fromLibraryId: string | null;
  fromPath: string | null;
  toLibraryId: string | null;
  toPath: string | null;
  candidates: string[];
}
interface Identity {
  firstSeen(ids: string[]): Promise<Record<string, number>>;
  duplicates(): Promise<
    {
      fingerprint: string;
      files: { id: string; libraryId: string; relPath: string }[];
    }[]
  >;
  events(opts: { limit: number }): Promise<IdentityEvent[]>;
}

async function setup() {
  // Assertion before dynamic import means the unchanged-HEAD red run cannot
  // fail on a missing module, missing table or TypeScript declaration.
  const url = new URL('../src/identity.ts', import.meta.url);
  assert(
    await Deno.stat(url).then(() => true, () => false),
    'core identity service must exist',
  );
  const mod = await import(url.href);
  assert(typeof mod.createIdentity === 'function');
  const dir = await Deno.makeTempDir({ prefix: 'melofon-identity-' });
  const root = `${dir}/music`;
  await Deno.mkdir(root);
  const store = await openStore(`${dir}/db`);
  const db = store.legacy;
  const libraries = createLibraries(store);
  const source = await libraries.add('Music', root);
  const media = createMedia() as ReturnType<typeof createMedia> & {
    fingerprint?: (
      path: string,
    ) => Promise<{ fingerprint: string | null; pcmMd5: string | null }>;
  };
  const fingerprint = media.fingerprint;
  assert(typeof fingerprint === 'function', 'media.fingerprint must exist');
  let calls = 0;
  const wrapped = {
    ...media,
    fingerprint: (path: string) => {
      calls++;
      return fingerprint.call(media, path);
    },
  };
  await Deno.copyFile(MP3, `${root}/a.mp3`);
  const identity: Identity = mod.createIdentity(store);
  return {
    dir,
    root,
    db,
    store,
    source,
    libraries,
    identity,
    media: wrapped,
    calls: () => calls,
    scan: () => scanLibrary(store, wrapped),
    async close() {
      db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

async function pathId(libraryId: string, rel: string): Promise<string> {
  return encodeHex(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`file\n${libraryId}\n${rel}`),
      ),
    ),
  ).slice(0, 32);
}

async function catalog(db: Db) {
  return (await db.conn.runAndReadAll(
    'SELECT id, path FROM files ORDER BY path',
  )).getRowObjects() as { id: string; path: string }[];
}

Deno.test('identity: fresh-install ids match path hashes and first-seen is recorded once', async () => {
  const t = await setup();
  try {
    const before = Date.now();
    await t.scan();
    const id = await pathId(t.source.id, 'a.mp3');
    assertEquals(await catalog(t.db), [{ id, path: `${t.root}/a.mp3` }]);
    const first = await t.identity.firstSeen([id, 'missing']);
    assert(first[id] >= before && first[id] <= Date.now());
    assertEquals(Object.keys(first), [id]);
    assertEquals(await t.identity.firstSeen([]), {});
    const rows = (await t.db.conn.runAndReadAll(
      'SELECT present, fingerprint FROM file_identity',
    )).getRowObjects();
    assertEquals(rows.length, 1);
    assertEquals(rows[0].present, true);
    assert(typeof rows[0].fingerprint === 'string');
  } finally {
    await t.close();
  }
});

Deno.test('identity: unchanged rescan preserves first-seen and does not reread fingerprints', async () => {
  const t = await setup();
  try {
    await t.scan();
    const ids = (await catalog(t.db)).map((r) => r.id);
    const first = await t.identity.firstSeen(ids);
    assertEquals(t.calls(), 1);
    await t.scan();
    assertEquals(t.calls(), 1);
    assertEquals(await t.identity.firstSeen(ids), first);
    assertEquals(await t.identity.events({ limit: 10 }), []);
  } finally {
    await t.close();
  }
});

Deno.test('identity: within-library move and rename preserve user-state joins and use the inode cache', async () => {
  const t = await setup();
  try {
    await t.scan();
    const [{ id }] = await catalog(t.db);
    const first = await t.identity.firstSeen([id]);
    await seedFirstUser(t.store, {
      dataDir: '',
      listen: undefined,
      user: 'admin',
      password: 'test',
      secret: 'test-secret',
    });
    const annotation = createAnnotation(t.store);
    const listens = createListens(t.store);
    assert(await annotation.star('admin', id));
    assert(await annotation.setRating('admin', id, 5));
    assert(
      await listens.record('admin', id, {
        source: 'test',
        playedAtMs: 1700000000000,
      }),
    );
    await Deno.mkdir(`${t.root}/sub`);
    await Deno.rename(`${t.root}/a.mp3`, `${t.root}/sub/renamed.mp3`);
    await t.scan();
    assertEquals(t.calls(), 1);
    assertEquals(
      (await createLibrary(t.store).getSong(id))?.path,
      `${t.root}/sub/renamed.mp3`,
    );
    assertEquals((await annotation.facts('admin', [id]))[id].starred, true);
    assertEquals((await annotation.facts('admin', [id]))[id].userRating, 5);
    assertEquals(
      (await annotation.starred('admin', { folderId: t.source.id }))[0]
        .targetId,
      id,
    );
    assertEquals(
      (await listens.facts('admin', { songs: [id] })).songs[id].playCount,
      1,
    );
    assertEquals(await t.identity.firstSeen([id]), first);
    const events = await t.identity.events({ limit: 10 });
    assertEquals(events.length, 1);
    assertEquals(events[0].kind, 'linked');
    assertEquals(events[0].fileId, id);
    assertEquals([events[0].fromPath, events[0].toPath], [
      'a.mp3',
      'sub/renamed.mp3',
    ]);
    assertEquals([events[0].fromLibraryId, events[0].toLibraryId], [
      t.source.id,
      t.source.id,
    ]);
  } finally {
    await t.close();
  }
});

Deno.test('identity: across-library move keeps the original id and records a link', async () => {
  const t = await setup();
  try {
    await t.scan();
    const [{ id }] = await catalog(t.db);
    const first = await t.identity.firstSeen([id]);
    const other = `${t.dir}/other`;
    await Deno.mkdir(other);
    const dest = await t.libraries.add('Other', other);
    await Deno.rename(`${t.root}/a.mp3`, `${other}/b.mp3`);
    await t.scan();
    assertEquals(await catalog(t.db), [{ id, path: `${other}/b.mp3` }]);
    assertEquals(await t.identity.firstSeen([id]), first);
    const [event] = await t.identity.events({ limit: 10 });
    assertEquals(event.kind, 'linked');
    assertEquals([event.fromLibraryId, event.toLibraryId], [
      t.source.id,
      dest.id,
    ]);
  } finally {
    await t.close();
  }
});

Deno.test('identity: disappear then reappear at the same path retains id and first-seen', async () => {
  const t = await setup();
  try {
    await t.scan();
    const [{ id }] = await catalog(t.db);
    const first = await t.identity.firstSeen([id]);
    await Deno.rename(`${t.root}/a.mp3`, `${t.dir}/held.mp3`);
    await t.scan();
    assertEquals(await catalog(t.db), []);
    assertEquals(
      (await t.db.conn.runAndReadAll('SELECT present FROM file_identity'))
        .getRowObjects()[0].present,
      false,
    );
    assertEquals(await t.identity.firstSeen([id]), first);
    await Deno.rename(`${t.dir}/held.mp3`, `${t.root}/a.mp3`);
    await t.scan();
    assertEquals((await catalog(t.db))[0].id, id);
    assertEquals(await t.identity.firstSeen([id]), first);
  } finally {
    await t.close();
  }
});

Deno.test('identity: ambiguous one-to-many moves get fresh ids and candidate events', async () => {
  const t = await setup();
  try {
    await t.scan();
    const [{ id }] = await catalog(t.db);
    await Deno.copyFile(`${t.root}/a.mp3`, `${t.root}/b.mp3`);
    await Deno.copyFile(`${t.root}/a.mp3`, `${t.root}/c.mp3`);
    await Deno.remove(`${t.root}/a.mp3`);
    await t.scan();
    const rows = await catalog(t.db);
    assertEquals(rows.length, 2);
    for (const row of rows) assertNotEquals(row.id, id);
    const events = await t.identity.events({ limit: 10 });
    assertEquals(events.length, 2);
    assertEquals(events.map((e) => e.kind), ['ambiguous', 'ambiguous']);
    for (const event of events) assertEquals(event.candidates, [id]);
    assert(events[0].seq > events[1].seq);
    assertEquals((await t.identity.events({ limit: 1 })).length, 1);
    assertEquals(await t.identity.events({ limit: 0 }), []);
  } finally {
    await t.close();
  }
});

Deno.test('identity: exact-audio duplicates list only present paths in stable order', async () => {
  const t = await setup();
  try {
    await Deno.copyFile(`${t.root}/a.mp3`, `${t.root}/b.mp3`);
    await t.scan();
    const rows = await catalog(t.db);
    const groups = await t.identity.duplicates();
    assertEquals(groups.length, 1);
    assertEquals(
      groups[0].files,
      rows.map((r) => ({
        id: r.id,
        libraryId: t.source.id,
        relPath: r.path.slice(t.root.length + 1),
      })),
    );
    await Deno.remove(`${t.root}/b.mp3`);
    await t.scan();
    assertEquals(await t.identity.duplicates(), []);
  } finally {
    await t.close();
  }
});

Deno.test('identity: replacing audio at the same path retains id and records audio_changed', async () => {
  const t = await setup();
  try {
    await t.scan();
    const [{ id }] = await catalog(t.db);
    const first = await t.identity.firstSeen([id]);
    await Deno.copyFile(SECOND, `${t.root}/a.mp3`);
    await Deno.utime(
      `${t.root}/a.mp3`,
      new Date(),
      new Date(Date.now() + 2000),
    );
    await t.scan();
    assertEquals((await catalog(t.db))[0].id, id);
    assertEquals(await t.identity.firstSeen([id]), first);
    assertEquals(t.calls(), 2);
    const [event] = await t.identity.events({ limit: 10 });
    assertEquals(event.kind, 'audio_changed');
    assertEquals(event.fileId, id);
    assert(event.occurredAtMs > 0);
  } finally {
    await t.close();
  }
});

Deno.test('identity: path reuse after a move allocates the first free salted id', async () => {
  const t = await setup();
  try {
    await t.scan();
    const [{ id }] = await catalog(t.db);
    await Deno.rename(`${t.root}/a.mp3`, `${t.root}/moved.mp3`);
    await t.scan();
    await Deno.copyFile(SECOND, `${t.root}/a.mp3`);
    await t.scan();
    const rows = await catalog(t.db);
    assertEquals(rows[1].id, id);
    assertNotEquals(rows[0].id, id);
    assertEquals(rows[0].id, await pathId(t.source.id, 'a.mp3\n1'));
  } finally {
    await t.close();
  }
});

Deno.test('identity: removed and re-added libraries restore ids and dates', async () => {
  const t = await setup();
  try {
    await t.scan();
    const [{ id }] = await catalog(t.db);
    const first = await t.identity.firstSeen([id]);
    assert(await t.libraries.remove(t.source.id));
    await t.scan();
    assertEquals(await catalog(t.db), []);
    await t.libraries.add('Returned', t.root);
    await t.scan();
    assertEquals((await catalog(t.db))[0].id, id);
    assertEquals(await t.identity.firstSeen([id]), first);
  } finally {
    await t.close();
  }
});

Deno.test('identity: concurrent run and start share one scan and its completion', async () => {
  const t = await setup();
  try {
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const media = {
      ...t.media,
      async fingerprint(path: string) {
        entered();
        await blocked;
        return await t.media.fingerprint(path);
      },
    };
    let completions = 0;
    const scan = createScan(t.store, media, {
      notify: {
        emit() {
          completions++;
        },
        subscribe() {
          return () => {};
        },
      },
    });
    const foreground = scan.run();
    await ready;
    const background = scan.start();
    const again = scan.run();
    assertEquals((await scan.status()).scanning, true);
    release();
    const [a, , b] = await Promise.all([foreground, background, again]);
    assertEquals(a, b);
    assertEquals(t.calls(), 1);
    assertEquals(completions, 1);
    assertEquals((await scan.status()).scanning, false);
    await scan.run();
    assertEquals(completions, 2);
  } finally {
    await t.close();
  }
});

Deno.test('identity: failed fingerprints warn but still catalog and null never links', async () => {
  const t = await setup();
  try {
    const events: string[] = [];
    const media = {
      ...t.media,
      fingerprint() {
        return Promise.reject(new Error('fixture fingerprint failure'));
      },
    };
    const log = {
      event(id: string) {
        events.push(id);
      },
    };
    await scanLibrary(t.store, media, log);
    const [{ id }] = await catalog(t.db);
    assertEquals(events, ['scan_fingerprint_failed']);
    await Deno.rename(`${t.root}/a.mp3`, `${t.root}/moved.mp3`);
    await scanLibrary(t.store, media, log);
    assertNotEquals((await catalog(t.db))[0].id, id);
    assertEquals(await t.identity.events({ limit: 10 }), []);
    assertEquals(await t.identity.duplicates(), []);
  } finally {
    await t.close();
  }
});
