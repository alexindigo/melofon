// Phase A's composition proof: no injected app bag or prebuilt database. State
// enters through the shipped HTTP hats; main.ts owns scanning and persistence.
import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { reservePorts } from './helpers/ports.ts';
import { tagged } from './helpers/tagged.ts';

const password = 'browse-boot-password';
const prefix = '/api/v1';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(
  check: () => boolean | Promise<boolean>,
  description: string,
) {
  const deadline = Date.now() + 30_000;
  while (!await check()) {
    assert(Date.now() < deadline, description);
    await sleep(50);
  }
}

async function boot(data: string) {
  using ports = reservePorts(3);
  const [port, own, ws] = ports.ports;
  const env: Record<string, string> = {};
  for (
    const name of ['HOME', 'PATH', 'DENO_DIR', 'TMPDIR', 'MELOFON_RAOP_LIB']
  ) {
    const value = Deno.env.get(name);
    if (value !== undefined) env[name] = value;
  }
  Object.assign(env, {
    MELOFON_DATA: data,
    MELOFON_USER: 'admin',
    MELOFON_PASSWORD: password,
    MELOFON_SECRET: 'browse-boot-test-secret',
    MELOFON_LISTEN: `0.0.0.0:${port}`,
    MELOFON_LISTEN_owntone: `${own},${ws}`,
    MELOFON_AIRPLAY_MDNS: 'off',
  });
  ports.release();
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--frozen',
      '--cached-only',
      '--node-modules-dir=manual',
      '--allow-net',
      '--allow-env',
      '--allow-read',
      '--allow-write',
      '--allow-ffi',
      '--allow-sys',
      'main.ts',
    ],
    cwd: new URL('../', import.meta.url),
    clearEnv: true,
    env,
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  // Drain immediately, including failed startup, to avoid pipe backpressure.
  const logs = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      child.kill('SIGTERM');
    } catch {
      // An early child exit is checked by status below.
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const status = await Promise.race([
      child.status,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 10_000);
      }),
    ]);
    clearTimeout(timer);
    if (status === null) {
      child.kill('SIGKILL');
      await child.status;
    }
    const output = (await logs).join('\n');
    assert(status?.success, `main did not shut down cleanly:\n${output}`);
  };
  const origin = `http://melofon.home:${port}`;
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(5000) });
  const headers = (credential = '') =>
    new Headers(
      credential.startsWith('melofon_session=')
        ? { Cookie: credential }
        : credential
        ? { Authorization: `Bearer ${credential}` }
        : {},
    );
  const get = (path: string, credential?: string, etag?: string) => {
    const h = headers(credential);
    h.set('Origin', 'http://foreign.example');
    if (etag) h.set('If-None-Match', etag);
    return request(`${prefix}${path}`, { headers: h });
  };
  const json = (
    path: string,
    method: string,
    body: unknown,
    credential?: string,
  ) => {
    const h = headers(credential);
    h.set('Origin', origin);
    h.set('Content-Type', 'application/json');
    return request(`${prefix}${path}`, {
      method,
      headers: h,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  const login = async (use: 'cookie' | 'bearer', username = 'admin') => {
    const res = await json('/session', 'POST', { username, password, use });
    assertEquals(res.status, 200, await res.clone().text());
    const body = await res.json();
    if (use === 'cookie') {
      const cookie = res.headers.get('set-cookie')!;
      assert(cookie.includes('HttpOnly') && !cookie.includes('Secure'));
      return cookie.split(';')[0];
    }
    assert(typeof body.key === 'string' && body.key.length > 0);
    return body.key as string;
  };
  const rest = async (
    username: string,
    op: string,
    extra: Record<string, string> = {},
  ) => {
    const query = new URLSearchParams({
      u: username,
      p: password,
      v: '1.16.1',
      c: 'browse-boot',
      f: 'json',
      ...extra,
    });
    const res = await request(`/rest/${op}?${query}`);
    assertEquals(res.status, 200);
    const body = (await res.json())['subsonic-response'];
    assertEquals(body.status, 'ok', JSON.stringify(body));
    return body;
  };
  try {
    await until(async () => {
      try {
        const res = await request('/_/health');
        return (await res.json()).ok === true;
      } catch {
        return false;
      }
    }, 'cold main never became healthy');
  } catch (error) {
    await stop();
    throw error;
  }
  return { origin, get, json, login, rest, headers, stop };
}

type Server = Awaited<ReturnType<typeof boot>>;
type Song = {
  id: string;
  albumId: string;
  libraryId: string;
  title: string | null;
  path: string;
};
type Album = { id: string; name: string | null; songCount: number };
type Artist = { id: string; kind: string; name: string | null };
type Snapshot = { body: unknown; etag: string };

function publicFacts(value: unknown) {
  const forbidden = new Set([
    'starred',
    'userRating',
    'averageRating',
    'playCount',
    'played',
    'lastPlayed',
    'libraryPath',
    'file',
  ]);
  if (Array.isArray(value)) {
    value.forEach(publicFacts);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assert(!forbidden.has(key), `private/internal field ${key}`);
      if (typeof item === 'string') {
        assert(!item.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(item), item);
      }
      publicFacts(item);
    }
  }
}

async function read(
  server: Server,
  path: string,
  credential: string,
  stored = true,
) {
  const res = await server.get(path, credential);
  assertEquals(res.status, 200, `${path}: ${await res.clone().text()}`);
  const body = await res.json();
  publicFacts(body);
  assertEquals(
    res.headers.get('cache-control'),
    stored ? 'private, no-cache' : 'private, no-store',
  );
  if (stored) assert(res.headers.get('etag'), path);
  else assertEquals(res.headers.get('etag'), null, path);
  return { body, etag: res.headers.get('etag')! };
}

async function conditional(
  server: Server,
  path: string,
  credential: string,
  tag: string,
) {
  const res = await server.get(path, credential, tag);
  assertEquals(res.status, 304, path);
  assertEquals(await res.text(), '');
  assertEquals(res.headers.get('etag'), tag);
  assertEquals(res.headers.get('cache-control'), 'private, no-cache');
}

async function events(server: Server, credential: string) {
  const h = server.headers(credential);
  h.set('Origin', server.origin);
  const ws = new WebSocket(
    `${server.origin.replace('http:', 'ws:')}${prefix}/events`,
    { headers: h },
  );
  const frames: {
    type: string;
    bootId?: string;
    events?: Record<string, unknown>;
  }[] = [];
  ws.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
  const close = async () => {
    if (ws.readyState < WebSocket.CLOSING) ws.close();
    await until(
      () => ws.readyState === WebSocket.CLOSED,
      'event socket did not close',
    );
  };
  try {
    await until(() => frames.length > 0, 'no cold-main event hello');
    assertEquals(frames.shift()!.type, 'hello');
  } catch (error) {
    await close();
    throw error;
  }
  return {
    frames,
    close,
    async changed() {
      await until(
        () => frames.some((f) => f.events?.library),
        'no committed library invalidation',
      );
      assertEquals(frames.find((f) => f.events?.library)!.events!.library, []);
      assert(
        !frames.some((f) => f.events?.scan || f.events?.libraries),
        'admin events leaked',
      );
    },
  };
}

async function scan(server: Server, admin: string) {
  const res = await server.json(
    '/admin/scans',
    'POST',
    { mode: 'full' },
    admin,
  );
  assertEquals(res.status, 202, await res.clone().text());
  await res.json();
  await until(async () => {
    const status = await server.get('/admin/scans/current', admin);
    assertEquals(status.status, 200);
    return !(await status.json()).scan.scanning;
  }, 'HTTP-requested scan did not finish');
}

Deno.test('API browse cold main: every route, personal isolation, WS publication and durable restart', async () => {
  const ips = await Deno.resolveDns('melofon.home', 'A');
  assert(
    ips.length > 0 && ips.every((ip) => !ip.startsWith('127.')),
    'household HTTP must use the guest NIC',
  );
  const root = await Deno.makeTempDir({ prefix: 'melofon-browse-boot-' });
  let server: Server | undefined;
  const sockets: Awaited<ReturnType<typeof events>>[] = [];
  try {
    for (
      const path of [
        'Music/Album/CD1',
        'Music/Album/CD2',
        'Music/Loose',
        'Other/Album',
      ]
    ) {
      await Deno.mkdir(`${root}/${path}`, { recursive: true });
    }
    const tags = {
      TALB: 'The Album 2',
      TPE1: 'The Artist',
      TPE2: 'The Artist',
      TCON: 'Jazz',
      TDRC: '2024',
      TSOA: 'Album 10',
      TSOT: 'Song 10',
    };
    const songFile = `${root}/Music/Album/CD1/one.mp3`;
    await tagged(songFile, { ...tags, TIT2: 'Song 2', TPOS: '1', TRCK: '1' });
    await tagged(`${root}/Music/Album/CD2/two.mp3`, {
      ...tags,
      TIT2: 'Song 10',
      TPOS: '2',
      TRCK: '1',
    });
    await tagged(`${root}/Music/Loose/no_title.mp3`, {});
    await tagged(`${root}/Other/Album/other.mp3`, {
      ...tags,
      TALB: 'Other Album',
      TIT2: 'Other Song',
    });
    await Deno.writeTextFile(
      `${root}/Music/Album/CD1/one.lrc`,
      '[00:01.00]Cold-start lyrics\n',
    );
    await Deno.copyFile(
      'tests/fixtures/library/Fixture Artist/Fixture Album/03 - Clip.mp4',
      `${root}/Music/clip.mp4`,
    );
    await Deno.writeTextFile(
      `${root}/Music/clip.en.srt`,
      '1\n00:00:00,000 --> 00:00:01,000\nCaption\n',
    );

    server = await boot(`${root}/data`);
    let admin = await server.login('bearer');
    assertEquals((await read(server, '/songs', admin)).body.total, 0);
    for (const username of ['alice', 'bob']) {
      const res = await server.json('/admin/users', 'POST', {
        username,
        password,
        role: 'user',
      }, admin);
      assertEquals(res.status, 201, await res.clone().text());
      await res.json();
    }
    const sourceIds: string[] = [];
    for (const name of ['Music', 'Other']) {
      const res = await server.json('/admin/libraries', 'POST', {
        name,
        path: `${root}/${name}`,
      }, admin);
      assertEquals(res.status, 201, await res.clone().text());
      sourceIds.push((await res.json()).library.id);
    }
    await scan(server, admin);
    let alice = await server.login('cookie', 'alice');
    let aliceBearer = await server.login('bearer', 'alice');
    let bob = await server.login('bearer', 'bob');
    const songs: Song[] = (await read(server, '/songs', alice)).body.songs;
    const albums: Album[] = (await read(server, '/albums', alice)).body.albums;
    const artists: Artist[] =
      (await read(server, '/artists', alice)).body.artists;
    assertEquals(songs.length, 5);
    const song = songs.find((s) => s.title === 'Song 2')!;
    const other = songs.find((s) => s.title === 'Other Song')!;
    const video = songs.find((s) => s.path === 'clip.mp4')!;
    const artist = artists.find((a) => a.name === 'The Artist')!;
    assert(song && other && video && artist);
    assertEquals(albums.find((a) => a.id === song.albumId)!.songCount, 2);
    for (const credential of [alice, aliceBearer]) {
      const opened =
        (await read(server, `/albums/${song.albumId}`, credential)).body.album;
      assertEquals(opened.songs.map((s: Song) => s.title), [
        'Song 2',
        'Song 10',
      ]);
      assertEquals(
        opened.songs[0],
        (await read(server, `/songs/${song.id}`, credential)).body.song,
      );
      assertEquals(
        (await read(server, '/statistics', credential)).body.statistics
          .songCount,
        5,
      );
      assertEquals(
        (await read(server, '/statistics', credential)).body.statistics
          .videoCount,
        1,
      );
      assertEquals(
        (await read(server, '/videos', credential)).body.videos.map((s: Song) =>
          s.id
        ),
        [video.id],
      );
      assertEquals(
        (await read(server, '/search?query=Song', credential)).body.songs.total,
        3,
      );
      assertEquals(
        (await read(server, '/genres', credential)).body.genres.find((
          g: { name: string },
        ) => g.name === 'Jazz').songCount,
        3,
      );
      const natural = await read(
        server,
        '/songs?genre=Jazz&natural=true',
        credential,
      );
      assertEquals(natural.body.songs.map((s: Song) => s.title), [
        'Other Song',
        'Song 2',
        'Song 10',
      ]);
      const indexed =
        (await read(server, '/artists?index=true', credential)).body;
      assertEquals(
        indexed.index.reduce(
          (n: number, run: { count: number }) => n + run.count,
          0,
        ),
        indexed.total,
      );
    }
    const playlist = (await server.rest('alice', 'createPlaylist', {
      name: 'Boot playlist',
      songId: song.id,
    })).playlist;

    // Enumerate all Phase A route families, all indexed entities, and real tree
    // descendants. Every common representation gets both auth modes and 304.
    const common = new Set([
      '/libraries',
      '/artists',
      '/albums',
      '/songs',
      '/genres',
      '/statistics',
      '/search',
      '/videos',
      '/folders',
    ]);
    for (const library of sourceIds) {
      for (
        const path of [
          '/artists',
          '/albums',
          '/songs',
          '/genres',
          '/statistics',
          '/search',
          '/videos',
          '/folders',
        ]
      ) common.add(`${path}?library=${library}`);
    }
    for (const entity of ['artists', 'albums', 'songs']) {
      common.add(
        `/${entity}?sort=-name&natural=true&sortTags=true&index=true&limit=1`,
      );
    }
    for (const entity of ['albums', 'songs']) {
      for (const sort of ['artist', '-year', 'newest', '-genre', 'random']) {
        common.add(
          `/${entity}?sort=${sort}${
            sort === '-genre'
              ? '&genre=Jazz'
              : sort === 'random'
              ? '&seed=cold-main'
              : ''
          }`,
        );
      }
      common.add(
        `/${entity}?library=${
          sourceIds[0]
        }&genre=Jazz&fromYear=2024&toYear=2024&limit=1&offset=99`,
      );
    }
    common.add('/search?query=Song&natural=true&sortTags=true&songLimit=1');
    common.add('/genres?natural=true');
    for (const s of songs) common.add(`/songs/${s.id}`);
    for (const a of albums) common.add(`/albums/${a.id}`);
    for (const a of artists) {
      common.add(`/artists/${a.id}`);
      common.add(
        `/artists/${a.id}/albums?natural=true&sortTags=true&index=true`,
      );
    }
    common.add(`/videos/${video.id}`);
    const pending = sourceIds.map((library) => ({ library, path: '' }));
    while (pending.length) {
      const { library, path } = pending.shift()!;
      const route = `/folders?${new URLSearchParams({ library, path })}`;
      common.add(route);
      const { body } = await read(server, route, alice);
      for (const folder of body.folders.folders) {
        pending.push({ library, path: folder.path });
      }
    }
    const snapshots = new Map<string, Snapshot>();
    for (const path of common) {
      const snapshot = await read(server, path, alice);
      assertEquals(await read(server, path, aliceBearer), snapshot, path);
      assertEquals(await read(server, path, bob), snapshot, path);
      assertEquals(await read(server, path, admin), snapshot, path);
      for (const credential of [alice, aliceBearer]) {
        await conditional(server, path, credential, snapshot.etag);
        const denied = await server.get(path, undefined, snapshot.etag);
        assertEquals(denied.status, 401, path);
        assertEquals((await denied.json()).code, 'unauthenticated');
      }
      snapshots.set(path, snapshot);
    }
    for (const credential of [alice, aliceBearer]) {
      for (const s of songs) {
        for (const suffix of ['lyrics', 'playlists', 'radio']) {
          const path = `/songs/${s.id}/${suffix}`;
          const response = await server.get(path, credential, '*');
          assertEquals(response.status, 200, path);
          assertEquals(
            response.headers.get('cache-control'),
            'private, no-store',
          );
          assertEquals(response.headers.get('etag'), null);
          const body = await response.json();
          publicFacts(body);
          assert(
            Array.isArray(body[suffix === 'radio' ? 'songs' : suffix]),
            path,
          );
          if (suffix === 'radio') {
            assertEquals(
              new Set(body.songs.map((r: Song) => r.id)).size,
              body.songs.length,
            );
            assert(
              body.songs.every((r: Song) =>
                r.id !== s.id && songs.some((known) => known.id === r.id)
              ),
            );
            if (s.id === song.id) {
              assert(
                body.songs.length > 0,
                'real main must supply song recommendations',
              );
            }
          }
        }
      }
      for (const a of albums) {
        await read(server, `/albums/${a.id}/radio`, credential, false);
      }
      for (const a of artists) {
        for (const suffix of ['info', 'top-songs', 'radio']) {
          await read(server, `/artists/${a.id}/${suffix}`, credential, false);
        }
      }
      assertEquals(
        (await read(server, `/songs/${song.id}/lyrics`, credential, false)).body
          .lyrics[0].lines[0].text,
        'Cold-start lyrics',
      );
      assertEquals(
        (await read(server, `/songs/${song.id}/playlists`, credential, false))
          .body.playlists.map((p: { id: string }) => p.id),
        [playlist.id],
      );
      assertEquals(
        (await read(server, `/videos/${video.id}`, credential)).body.video
          .details.captions[0].key,
        'sidecar:clip.en.srt',
      );
    }

    // Stage 3 mutations already have a shipped REST facade. Use that facade to
    // prove native common facts stay common while core personal selections move.
    for (
      const [username, selected] of [['alice', song], ['bob', other]] as const
    ) {
      await server.rest(username, 'star', { albumId: selected.albumId });
      await server.rest(username, 'setRating', {
        id: selected.albumId,
        rating: '5',
      });
      await server.rest(username, 'scrobble', { id: selected.id });
    }
    for (
      const [credential, selected] of [[alice, song], [aliceBearer, song], [
        bob,
        other,
      ]] as const
    ) {
      for (const sort of ['starred', 'highest', 'recent', 'frequent']) {
        const path = `/albums?sort=${sort}`;
        const res = await server.get(
          path,
          credential,
          snapshots.get('/albums')!.etag,
        );
        assertEquals(res.status, 200);
        assertEquals(res.headers.get('cache-control'), 'private, no-store');
        assertEquals(res.headers.get('etag'), null);
        const body = await res.json();
        publicFacts(body);
        assertEquals(body.total, 1);
        assertEquals(body.albums.map((a: Album) => a.id), [selected.albumId]);
      }
      const top = await read(
        server,
        `/artists/${artist.id}/top-songs`,
        credential,
        false,
      );
      assert(top.body.songs.some((s: Song) => s.id === selected.id));
      assert(top.body.songs.every((s: Song) => s.albumId === selected.albumId));
      for (
        const path of [
          `/artists/${artist.id}/radio`,
          `/albums/${selected.albumId}/radio`,
        ]
      ) {
        const mix = (await read(server, path, credential, false)).body.songs;
        assert(mix.length > 0, path);
        assert(
          mix.every((s: Song) => songs.some((known) => known.id === s.id)),
          path,
        );
        assertEquals(
          new Set(mix.map((s: Song) => s.id)).size,
          mix.length,
          path,
        );
      }
    }
    for (const [path, before] of snapshots) {
      assertEquals(
        await read(server, path, bob),
        before,
        `personal mutation changed ${path}`,
      );
      await conditional(server, path, alice, before.etag);
    }

    const clients = await Promise.all([
      events(server, alice),
      events(server, aliceBearer),
    ]);
    sockets.push(...clients);
    await tagged(songFile, {
      ...tags,
      TIT2: 'Published after cold start',
      TPOS: '1',
      TRCK: '1',
    });
    await scan(server, admin);
    for (const client of clients) await client.changed();
    for (const credential of [alice, aliceBearer]) {
      const res = await server.get(
        `/songs/${song.id}`,
        credential,
        snapshots.get(`/songs/${song.id}`)!.etag,
      );
      assertEquals(res.status, 200);
      assertNotEquals(
        res.headers.get('etag'),
        snapshots.get(`/songs/${song.id}`)!.etag,
      );
      assertEquals((await res.json()).song.title, 'Published after cold start');
    }
    const beforeRestart = new Map<string, Snapshot>();
    for (const path of common) {
      beforeRestart.set(path, await read(server, path, alice));
    }
    for (const client of sockets.splice(0)) await client.close();
    await server.stop();
    server = await boot(`${root}/data`);
    admin = await server.login('bearer');
    // Both original sessions survive a real process restart; also prove fresh
    // cookie/Bearer login against the persisted one-way user/session owners.
    for (const credential of [alice, aliceBearer]) {
      for (const [path, before] of beforeRestart) {
        const res = await server.get(path, credential, before.etag);
        assertEquals(res.status, 200, path); // startup publication advances revision
        assertNotEquals(res.headers.get('etag'), before.etag, path);
        assertEquals(await res.json(), before.body, path);
        await conditional(server, path, credential, res.headers.get('etag')!);
      }
    }
    alice = await server.login('cookie', 'alice');
    aliceBearer = await server.login('bearer', 'alice');
    bob = await server.login('bearer', 'bob');
    for (
      const [credential, selected] of [[alice, song], [aliceBearer, song], [
        bob,
        other,
      ]] as const
    ) {
      for (const sort of ['starred', 'highest', 'recent', 'frequent']) {
        assertEquals(
          (await read(server, `/albums?sort=${sort}`, credential, false)).body
            .albums.map((a: Album) => a.id),
          [selected.albumId],
        );
      }
    }
    const removalClients = await Promise.all([
      events(server, alice),
      events(server, aliceBearer),
    ]);
    sockets.push(...removalClients);
    const prior = await read(server, '/songs', alice);
    const removed = await server.json(
      `/admin/libraries/${sourceIds[1]}`,
      'DELETE',
      undefined,
      admin,
    );
    assertEquals(removed.status, 204);
    await removed.text();
    for (const client of removalClients) await client.changed();
    for (const credential of [alice, aliceBearer]) {
      const res = await server.get('/songs', credential, prior.etag);
      assertEquals(res.status, 200);
      assertNotEquals(res.headers.get('etag'), prior.etag);
      const body = await res.json();
      assertEquals(body.total, 4);
      assert(!body.songs.some((s: Song) => s.id === other.id));
      const missing = await server.get(`/songs/${other.id}`, credential, '*');
      assertEquals(missing.status, 404);
      assertEquals((await missing.json()).code, 'not_found');
      assertEquals(
        (await read(server, '/statistics', credential)).body.statistics
          .songCount,
        4,
      );
      assertEquals(
        (await read(server, '/libraries', credential)).body.libraries.map((
          l: { id: string },
        ) => l.id),
        [sourceIds[0]],
      );
    }
    for (const client of sockets.splice(0)) await client.close();
    await server.stop();
    server = await boot(`${root}/data`);
    for (const credential of [alice, aliceBearer]) {
      assertEquals((await read(server, '/songs', credential)).body.total, 4);
      assertEquals(
        (await read(server, '/albums?sort=starred', credential, false)).body
          .albums[0].id,
        song.albumId,
      );
    }
    assertEquals(
      (await read(server, '/albums?sort=starred', bob, false)).body.total,
      0,
    );
    assertEquals(
      (await read(server, `/songs/${song.id}/playlists`, alice, false)).body
        .playlists[0].id,
      playlist.id,
    );
  } finally {
    for (const socket of sockets) await socket.close();
    await server?.stop();
    await Deno.remove(root, { recursive: true });
  }
});
