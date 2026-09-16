// tests/playlists.test.ts — M2 playlists over the opensubsonic hat: create
// (by name, with songs), replace-by-playlistId, getPlaylist entries in order,
// getPlaylists (Navidrome quirk: ignores username), updatePlaylist
// (rename/comment/add/remove), deletePlaylist, ownership-as-404.
import { assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openDb } from '../src/db.ts';
import { seedFirstUser } from '../src/users.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createUserService } from '../src/user.ts';
import { createLibrary } from '../src/library.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { createPlaylists } from '../src/playlists.ts';

const AUTH = 'u=admin&p=test&v=1.16.1&c=melofon-test';

interface PlaylistPayload {
  id: string;
  name: string;
  comment?: string;
  owner: string;
  songCount: number;
  entry?: { id: string }[];
}

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-pl-' });
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
  await scanLibrary(db);
  const bag = {
    cfg,
    libraries,
    user: createUserService(db, cfg),
    library: createLibrary(db),
    annotation: createAnnotation(db),
    listens: createListens(db),
    playlists: createPlaylists(db),
  };
  const app = await pathfinder({ roots: ['layers/opensubsonic/'], app: bag });
  const songs = await db.conn.runAndReadAll(
    "SELECT id FROM files WHERE title != '' ORDER BY path",
  );
  const songIds = (songs.getRowObjects() as { id: string }[]).map((r) => r.id);
  return {
    app,
    songIds,
    close: async () => {
      db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

async function jsonBody(res: Response) {
  const body = await res.json();
  return (body as Record<string, Record<string, unknown>>)[
    'subsonic-response'
  ];
}

async function call(
  app: (req: Request) => Promise<Response>,
  op: string,
  extra = '',
): Promise<Record<string, unknown>> {
  const res = await app(
    new Request(`http://x/rest/${op}.view?${AUTH}&f=json${extra}`),
  );
  return await jsonBody(res);
}

Deno.test('createPlaylist with songs, then getPlaylist lists entries in order', async () => {
  const { app, songIds, close } = await setup();
  try {
    const [a, b] = songIds;
    const created = await call(
      app,
      'createPlaylist',
      `&name=Mix&songId=${a}&songId=${b}`,
    );
    assertEquals(created.status, 'ok');
    const playlist = created.playlist as PlaylistPayload;
    assertEquals(playlist.name, 'Mix');
    assertEquals(playlist.owner, 'admin');
    assertEquals(playlist.songCount, 2);
    assertEquals(playlist.entry!.map((s) => s.id), [a, b]);

    const got = await call(app, 'getPlaylist', `&id=${playlist.id}`);
    assertEquals(got.status, 'ok');
    assertEquals(
      (got.playlist as PlaylistPayload).entry!.map((s) => s.id),
      [a, b],
    );

    const list = await call(app, 'getPlaylists');
    const playlists = (list.playlists as { playlist: PlaylistPayload[] })
      .playlist;
    assertEquals(playlists.map((p) => p.id), [playlist.id]);
  } finally {
    await close();
  }
});

Deno.test('getPlaylists ignores the username param (Navidrome quirk)', async () => {
  const { app, songIds, close } = await setup();
  try {
    await call(app, 'createPlaylist', `&name=Mine&songId=${songIds[0]}`);
    const list = await call(app, 'getPlaylists', '&username=someoneelse');
    const playlists = (list.playlists as { playlist: PlaylistPayload[] })
      .playlist;
    assertEquals(playlists.length, 1);
    assertEquals(playlists[0].owner, 'admin');
  } finally {
    await close();
  }
});

Deno.test('createPlaylist with playlistId replaces the track list', async () => {
  const { app, songIds, close } = await setup();
  try {
    const [a, b, c] = songIds;
    const created = await call(
      app,
      'createPlaylist',
      `&name=Mix&songId=${a}&songId=${b}`,
    );
    const id = (created.playlist as PlaylistPayload).id;
    const replaced = await call(
      app,
      'createPlaylist',
      `&playlistId=${id}&songId=${c}`,
    );
    assertEquals(replaced.status, 'ok');
    const playlist = replaced.playlist as PlaylistPayload;
    assertEquals(playlist.entry!.map((s) => s.id), [c]);
  } finally {
    await close();
  }
});

Deno.test('updatePlaylist renames, comments, adds and removes', async () => {
  const { app, songIds, close } = await setup();
  try {
    const [a, b, c] = songIds;
    const created = await call(
      app,
      'createPlaylist',
      `&name=Mix&songId=${a}&songId=${b}`,
    );
    const id = (created.playlist as PlaylistPayload).id;

    const updated = await call(
      app,
      'updatePlaylist',
      `&playlistId=${id}&name=Renamed&comment=hello&songIdToAdd=${c}&songIndexToRemove=0`,
    );
    assertEquals(updated.status, 'ok');

    const got = await call(app, 'getPlaylist', `&id=${id}`);
    const playlist = got.playlist as PlaylistPayload;
    assertEquals(playlist.name, 'Renamed');
    assertEquals(playlist.comment, 'hello');
    assertEquals(playlist.entry!.map((s) => s.id), [b, c]);
  } finally {
    await close();
  }
});

Deno.test('deletePlaylist removes it; unknown ids are 70', async () => {
  const { app, songIds, close } = await setup();
  try {
    const created = await call(
      app,
      'createPlaylist',
      `&name=Mix&songId=${songIds[0]}`,
    );
    const id = (created.playlist as PlaylistPayload).id;
    assertEquals((await call(app, 'deletePlaylist', `&id=${id}`)).status, 'ok');

    const got = await call(app, 'getPlaylist', `&id=${id}`);
    assertEquals(got.status, 'failed');
    assertEquals((got.error as { code: number }).code, 70);

    const again = await call(app, 'deletePlaylist', `&id=${id}`);
    assertEquals((again.error as { code: number }).code, 70);
  } finally {
    await close();
  }
});
