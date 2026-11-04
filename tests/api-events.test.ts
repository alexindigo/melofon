import { assert, assertEquals } from '@std/assert';
import { apiFixture, error } from './helpers/api.ts';
import { createLibraries } from '../src/libraries.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibrary } from '../src/library.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createOutputs, createPlayer, type Outputs } from '../src/player.ts';
import { createPlayback, type Playback } from '../src/playback.ts';
import { browseFixture } from './helpers/browse.ts';
import { createScan } from '../src/scan.ts';
import { tagged } from './helpers/tagged.ts';

type Fixture = Awaited<ReturnType<typeof apiFixture>>;
interface Frame {
  type: string;
  version?: number;
  heartbeatMs?: number;
  bootId?: string;
  events?: Record<string, string[] | '*'>;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    assert(Date.now() < deadline, 'events outcome timeout');
    await sleep(10);
  }
}
function connect(
  f: Fixture,
  credential: string,
  path = '/api/v1/events',
  origin: string | null = f.origin,
) {
  const headers = new Headers(
    credential.startsWith('melofon_session=')
      ? { Cookie: credential }
      : { Authorization: `Bearer ${credential}` },
  );
  if (origin !== null) headers.set('Origin', origin);
  const ws = new WebSocket(`${f.origin.replace('http:', 'ws:')}${path}`, {
    headers,
  });
  const frames: Frame[] = [];
  let ended: CloseEvent | undefined;
  ws.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)));
  ws.onclose = (ev) => {
    ended = ev;
  };
  return {
    ws,
    frames,
    ended: () => ended,
    async hello(heartbeatMs = 25000) {
      await waitFor(() => frames.length > 0);
      const frame = frames.shift()!;
      assertEquals(frame.type, 'hello');
      assertEquals(frame.version, 1);
      assertEquals(frame.heartbeatMs, heartbeatMs);
      assert(/^[0-9a-f-]{36}$/.test(frame.bootId!));
      assertEquals(Object.keys(frame).sort(), [
        'bootId',
        'heartbeatMs',
        'type',
        'version',
      ]);
      return frame;
    },
    async close() {
      if (ws.readyState < WebSocket.CLOSING) ws.close();
      await waitFor(() => ws.readyState === WebSocket.CLOSED);
    },
  };
}
function handshake(
  f: Fixture,
  headers: Record<string, string> = {},
  query = '',
) {
  return f.request(`/api/v1/events${query}`, {
    headers: {
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version': '13',
      ...headers,
    },
  });
}
async function member(
  f: Fixture,
  name: string,
  role: 'user' | 'admin' = 'user',
) {
  const created = await f.auth.users.create(f.admin.id, {
    username: name,
    password: 'password-member',
    role,
  });
  const login = await f.login('bearer', name, 'password-member');
  return { ...login, id: created.id };
}

Deno.test('events: cookie/Bearer hello, forced mount, no replay and stable process boot id', async () => {
  const f = await apiFixture();
  const sockets: ReturnType<typeof connect>[] = [];
  try {
    const cookie = await f.login();
    const bearer = await f.login('bearer');
    for (
      const [credential, path, origin] of [
        [cookie.credential, '/api/v1/events', f.origin],
        [bearer.credential, '/api/v1/events', null],
        [cookie.credential, '/_melofon/api/v1/events', f.origin],
      ] as const
    ) {
      const socket = connect(f, credential, path, origin);
      sockets.push(socket);
      assertEquals((await socket.hello()).bootId, f.notify!.bootId);
      f.notify!.emit(
        ['settings'],
        { settings: ['only-key-no-value'] },
        'admins',
      );
      await waitFor(() => socket.frames.length > 0);
      assertEquals(socket.frames.shift(), {
        type: 'changed',
        events: { settings: ['only-key-no-value'] },
      });
      await socket.close();
    }
    f.notify!.emit(['settings'], { settings: ['not-replayed'] }, 'admins');
    const reconnect = connect(f, cookie.credential);
    sockets.push(reconnect);
    await reconnect.hello();
    await sleep(80);
    assertEquals(reconnect.frames, []);
  } finally {
    for (const socket of sockets) await socket.close();
    await f.close();
  }
});

Deno.test('events: regular cookie/Bearer clients receive committed library invalidation then refetch native changes', async () => {
  const f = await browseFixture();
  const sockets: ReturnType<typeof connect>[] = [];
  try {
    const song = f.songs.find((s) => s.title === 'Tagged Song')!;
    const path = `/api/v1/songs/${song.id}`;
    const clients = [];
    for (const mode of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        mode,
        'listener',
        'password-listener',
      );
      const socket = connect(f, credential);
      sockets.push(socket);
      await socket.hello();
      const response = await f.get(path, credential);
      assertEquals(response.status, 200);
      const etag = response.headers.get('etag')!;
      await response.body?.cancel();
      clients.push({ credential, socket, etag });
    }
    const scan = createScan(f.store, undefined, {
      notify: f.notify,
      state: f.state,
    });
    await tagged(song.path, {
      TIT2: 'Published title',
      TALB: 'Album',
      TPE1: 'Shared Artist',
      TPOS: '1/2',
    });
    await scan.run({ mode: 'full' });
    for (const client of clients) {
      await waitFor(() =>
        client.socket.frames.some((frame) => frame.events?.library)
      );
      assert(
        !client.socket.frames.some((frame) =>
          frame.events?.scan || frame.events?.libraries
        ),
      );
      const response = await f.get(path, client.credential, {
        'If-None-Match': client.etag,
      });
      assertEquals(response.status, 200);
      assert(response.headers.get('etag') !== client.etag);
      assertEquals((await response.json()).song.title, 'Published title');
      // Publication invalidates before candidate acquisition finishes. Each
      // event is delivered asynchronously; receipt of one is no drain barrier.
      await waitFor(() =>
        client.socket.frames.some((frame) => frame.events?.database) &&
        client.socket.frames.some((frame) => frame.events?.update)
      );
      client.socket.frames.length = 0;
    }
    const libraries = createLibraries(f.store, { notify: f.notify });
    const library = (await libraries.list()).find((l) => l.name === 'Music')!;
    await libraries.update(library.id, { name: 'Public source rename' });
    for (const client of clients) {
      await waitFor(() =>
        client.socket.frames.some((frame) => frame.events?.library)
      );
      assertEquals(
        client.socket.frames.find((frame) => frame.events?.library)?.events
          ?.library,
        [],
      );
      assert(
        !client.socket.frames.some((frame) =>
          frame.events?.scan || frame.events?.libraries
        ),
      );
      const response = await f.get('/api/v1/libraries', client.credential);
      assertEquals(response.status, 200);
      assertEquals(
        (await response.json()).libraries.find((l: { id: string }) =>
          l.id === library.id
        ).name,
        'Public source rename',
      );
    }
  } finally {
    for (const socket of sockets) await socket.close();
    await f.close();
  }
});

Deno.test('events: authentication and Origin reject before 101; plain authenticated GET requires upgrade', async () => {
  const f = await apiFixture();
  try {
    const cookie = await f.login();
    const bearer = await f.login('bearer');
    await error(
      await handshake(f, { Origin: f.origin }),
      401,
      'unauthenticated',
    );
    await error(
      await handshake(
        f,
        { Origin: f.origin },
        `?token=${bearer.credential}&key=${bearer.credential}`,
      ),
      401,
      'unauthenticated',
    );
    await error(
      await handshake(f, { Cookie: cookie.credential }),
      403,
      'origin',
    );
    const credentials: Record<string, string>[] = [
      { Cookie: cookie.credential },
      { Authorization: `Bearer ${bearer.credential}` },
    ];
    for (const origin of ['null', 'http://foreign.home', `${f.origin}1`]) {
      for (const auth of credentials) {
        await error(
          await handshake(f, { ...auth, Origin: origin }),
          403,
          'origin',
        );
      }
    }
    await error(
      await handshake(f, {
        Origin: f.origin,
        Cookie: cookie.credential,
        Authorization: 'Bearer bad',
      }),
      401,
      'unauthenticated',
    );
    await error(
      await f.get('/api/v1/events', bearer.credential),
      400,
      'upgrade_required',
    );
  } finally {
    await f.close();
  }
});

Deno.test('events: current admin role, per-user profile/session audience and household events', async () => {
  const f = await apiFixture();
  const sockets: ReturnType<typeof connect>[] = [];
  try {
    const admin = await f.login('bearer');
    const a = await member(f, 'alice');
    const b = await member(f, 'bob');
    const otherAdmin = await member(f, 'second-admin', 'admin');
    const sa = connect(f, a.credential), sb = connect(f, b.credential);
    const sc = connect(f, admin.credential),
      sd = connect(f, otherAdmin.credential);
    sockets.push(sa, sb, sc, sd);
    for (const socket of sockets) await socket.hello();
    const updated = await f.json('/api/v1/me', 'PATCH', {
      displayName: 'Alice Updated',
    }, a.credential);
    assertEquals(updated.status, 200);
    await updated.json();
    await waitFor(() => sa.frames.length > 0 && sc.frames.length > 0);
    assertEquals(sa.frames.shift(), {
      type: 'changed',
      events: { me: [a.id] },
    });
    assertEquals(sc.frames.shift(), {
      type: 'changed',
      events: { users: [a.id] },
    });
    const device = await f.login('bearer', 'alice', 'password-member');
    await waitFor(() => sa.frames.length > 0);
    assertEquals(sa.frames.shift(), {
      type: 'changed',
      events: { sessions: [device.body.session.id] },
    });
    const settings = await f.json('/api/v1/admin/settings', 'PATCH', {
      changes: [
        { key: 'auth.sessionIdleDays', value: 2, revision: 0 },
      ],
    }, admin.credential);
    assertEquals(settings.status, 200);
    await settings.json();
    await waitFor(() =>
      sc.frames.some((frame) => frame.events?.settings !== undefined)
    );
    assert(
      sc.frames.some((frame) =>
        JSON.stringify(frame) ===
          JSON.stringify({
            type: 'changed',
            events: { settings: ['auth.sessionIdleDays'] },
          })
      ),
    );
    await f.auth.users.setRole(f.admin.id, otherAdmin.id, 'user');
    await sleep(80);
    assertEquals(sb.frames, []); // Neither Alice's private ids nor admin changes.
    assertEquals(sa.frames, []); // No other user's profile/session ids.
    for (const socket of [sc, sd]) {
      assert(
        !socket.frames.some((frame) =>
          frame.events?.me?.includes(a.id) ||
          frame.events?.sessions?.includes(device.body.session.id)
        ),
      );
    }
    for (const socket of sockets) socket.frames.length = 0;
    f.notify!.emit(['hats', 'settings', 'libraries', 'scan', 'users'], {
      users: ['admin-only'],
    }, 'admins');
    f.notify!.emit(['player', 'queue', 'outputs'], undefined, 'all');
    // Unscoped private events must fail closed, even for admins.
    // @ts-expect-error A producer cannot omit the required audience.
    f.notify!.emit(['me', 'sessions'], {
      me: ['private'],
      sessions: ['private'],
    });
    await sleep(120);
    for (const socket of [sa, sb, sd]) {
      assertEquals(socket.frames, [{
        type: 'changed',
        events: { player: [], queue: [], speakers: [] },
      }]);
    }
    assertEquals(sc.frames, [{
      type: 'changed',
      events: {
        player: [],
        queue: [],
        speakers: [],
        hats: [],
        settings: [],
        libraries: [],
        scan: [],
        users: ['admin-only'],
      },
    }]);
  } finally {
    for (const socket of sockets) await socket.close();
    await f.close();
  }
});

Deno.test('events: household queue, player and speaker changes reach cookie/Bearer members and admins', async () => {
  let playback!: Playback;
  let outputs!: Outputs;
  const f = await apiFixture({
    services: async (f) => {
      const libraries = createLibraries(f.store);
      await libraries.add(
        'Music',
        await Deno.realPath('tests/fixtures/library'),
      );
      await scanLibrary(f.store);
      const library = createLibrary(f.store);
      playback = createPlayback({
        player: createPlayer(),
        nowPlaying: createNowPlaying(f.store),
        library,
        cfg: f.cfg,
        notify: f.notify,
      });
      outputs = createOutputs({ notify: f.notify });
      return { libraries, library, playback, outputs };
    },
  });
  const sockets: ReturnType<typeof connect>[] = [];
  try {
    const admin = await f.login('bearer');
    const a = await member(f, 'listener');
    const cookie = await f.login('cookie', 'listener', 'password-member');
    for (
      const credential of [admin.credential, a.credential, cookie.credential]
    ) {
      const socket = connect(f, credential);
      sockets.push(socket);
      await socket.hello();
    }
    const songs = await createLibrary(f.store).listSongs({
      size: 1,
      offset: 0,
    });
    assertEquals(songs.length, 1);
    playback.queueAdd(songs, { play: true });
    assertEquals(playback.queueView().items[0].song.id, songs[0].id);
    assertEquals(playback.playerView().state, 'play');
    for (const socket of sockets) {
      await waitFor(() => socket.frames.some((frame) => frame.events?.queue));
      assertEquals(socket.frames.shift(), {
        type: 'changed',
        events: { queue: [], player: [], nowPlaying: [] },
      });
    }
    outputs.register({
      id: 'speaker',
      name: 'Household',
      type: 'AirPlay',
      selected: true,
      volume: 100,
    });
    outputs.update('speaker', { volume: 42 });
    assertEquals(outputs.get('speaker')?.volume, 42);
    for (const socket of sockets) {
      await waitFor(() =>
        socket.frames.some((frame) => frame.events?.speakers)
      );
      assertEquals(socket.frames.shift(), {
        type: 'changed',
        events: { speakers: [], volume: [] },
      });
    }
  } finally {
    for (const socket of sockets) await socket.close();
    playback?.close();
    await f.close();
  }
});

Deno.test('events: core audience overrides names and same-name ids stay separate during send-time demotion', async () => {
  let hold: Promise<void> | undefined;
  let waiting = 0;
  const f = await apiFixture({
    services: (f) =>
      Promise.resolve({
        sessions: {
          ...f.auth.sessions,
          async authenticate(
            ...args: Parameters<typeof f.auth.sessions.authenticate>
          ) {
            if (args[1]?.touch === false && hold) {
              waiting++;
              await hold;
            }
            return f.auth.sessions.authenticate(...args);
          },
        },
      }),
  });
  const sockets: ReturnType<typeof connect>[] = [];
  let release = () => {};
  try {
    const admin = await f.login('bearer');
    const a = await member(f, 'demoted-listener', 'admin');
    const b = await member(f, 'ordinary-listener');
    const sa = connect(f, a.credential), sb = connect(f, b.credential);
    sockets.push(sa, sb);
    for (const socket of sockets) await socket.hello();
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.notify.emit(['player'], { player: ['admin-only'] }, 'admins');
    await waitFor(() => waiting === 2);
    f.notify.emit(['player'], { player: ['public'] }, 'all');
    f.notify.emit(['database'], { database: ['private-a'] }, { userId: a.id });
    f.notify.emit(['database'], { database: ['private-b'] }, { userId: b.id });
    // The name cannot add a restriction that core did not mark.
    f.notify.emit(['settings'], { settings: ['public-setting'] }, 'all');
    const demoted = await f.json(`/api/v1/admin/users/${a.id}`, 'PATCH', {
      role: 'user',
    }, admin.credential);
    assertEquals(demoted.status, 200);
    await demoted.body?.cancel();
    hold = undefined;
    release();
    for (const socket of sockets) await waitFor(() => socket.frames.length > 0);
    assertEquals(sa.frames.shift(), {
      type: 'changed',
      events: {
        player: ['public'],
        database: ['private-a'],
        settings: ['public-setting'],
        me: [a.id],
      },
    });
    assertEquals(sb.frames.shift(), {
      type: 'changed',
      events: {
        player: ['public'],
        database: ['private-b'],
        settings: ['public-setting'],
      },
    });
    // With an admin still signed in, the two authorized buckets merge ids.
    const sc = connect(f, admin.credential);
    sockets.push(sc);
    await sc.hello();
    f.notify.emit(['queue'], { queue: ['public', 'duplicate'] }, 'all');
    f.notify.emit(['queue'], { queue: ['restricted', 'duplicate'] }, 'admins');
    await waitFor(() => sc.frames.length > 0);
    assertEquals(sc.frames.shift(), {
      type: 'changed',
      events: { queue: ['public', 'duplicate', 'restricted'] },
    });
    for (const socket of [sa, sb]) {
      await waitFor(() => socket.frames.length > 0);
      assertEquals(socket.frames.shift(), {
        type: 'changed',
        events: { queue: ['public', 'duplicate'] },
      });
    }
  } finally {
    hold = undefined;
    release();
    for (const socket of sockets) await socket.close();
    await f.close();
  }
});

Deno.test('events: ten synchronous changes merge, duplicate ids deduplicate, >100 collapses and empty collection dominates', async () => {
  const f = await apiFixture();
  const login = await f.login('bearer');
  const socket = connect(f, login.credential);
  try {
    await socket.hello();
    for (let i = 0; i < 10; i++) {
      f.notify!.emit(
        ['settings'],
        { settings: [`key-${i}`, 'duplicate'] },
        'admins',
      );
    }
    await waitFor(() => socket.frames.length > 0);
    await sleep(80);
    assertEquals(socket.frames, [{
      type: 'changed',
      events: {
        settings: [
          'key-0',
          'duplicate',
          ...Array.from({ length: 9 }, (_, i) => `key-${i + 1}`),
        ],
      },
    }]);
    socket.frames.length = 0;
    for (let i = 0; i < 101; i++) {
      f.notify!.emit(['users'], { users: [`id-${i}`] }, 'admins');
    }
    f.notify!.emit(['libraries'], { libraries: ['narrow'] }, 'admins');
    f.notify!.emit(['libraries'], undefined, 'admins');
    f.notify!.emit(['libraries'], { libraries: ['later'] }, 'admins');
    await waitFor(() => socket.frames.length > 0);
    assertEquals(socket.frames.shift(), {
      type: 'changed',
      events: { users: '*', libraries: [] },
    });
  } finally {
    await socket.close();
    await f.close();
  }
});

Deno.test('events: revoke, password change and sign-out-everywhere close exact sessions with 4401 within one second', async () => {
  const f = await apiFixture();
  const sockets: ReturnType<typeof connect>[] = [];
  try {
    const admin = await f.login('bearer');
    const unaffected = connect(f, admin.credential);
    sockets.push(unaffected);
    await unaffected.hello();
    for (const operation of ['revoke', 'password', 'everywhere']) {
      const user = await member(f, operation);
      const device = await f.login('bearer', operation, 'password-member');
      const socket = connect(f, user.credential),
        second = connect(f, device.credential);
      sockets.push(socket, second);
      await socket.hello();
      await second.hello();
      const start = Date.now();
      const response = operation === 'revoke'
        ? await f.json(
          `/api/v1/me/sessions/${user.body.session.id}`,
          'DELETE',
          undefined,
          device.credential,
        )
        : operation === 'password'
        ? await f.json('/api/v1/me/password', 'PUT', {
          current: 'password-member',
          new: 'replacement-password',
        }, device.credential)
        : await f.json(
          '/api/v1/me/sessions',
          'DELETE',
          undefined,
          device.credential,
        );
      assertEquals(response.status, 200);
      await response.body?.cancel();
      await waitFor(() => socket.ended() !== undefined, 1000);
      assert(Date.now() - start < 1100);
      assertEquals(socket.ended()!.code, 4401);
      assertEquals(socket.ended()!.reason, 'signed_out');
      if (operation === 'revoke') {
        assertEquals(second.ws.readyState, WebSocket.OPEN);
      } else {
        await waitFor(() => second.ended() !== undefined, 1000);
        assertEquals(second.ended()!.code, 4401);
      }
    }
    assertEquals(unaffected.ws.readyState, WebSocket.OPEN);
  } finally {
    for (const socket of sockets) await socket.close();
    await f.close();
  }
});

Deno.test('events: default 25s ping rechecks without activity; idle session closes and lastUsedAt stays at connect', async () => {
  const f = await apiFixture();
  const login = await f.login('bearer');
  f.advance(120000);
  const socket = connect(f, login.credential);
  try {
    await socket.hello();
    const before = await f.auth.sessions.list(f.admin.id);
    assertEquals(before[0].lastUsedAt, new Date(f.now()).toISOString());
    f.advance(120000);
    await waitFor(
      () => socket.frames.some((frame) => frame.type === 'ping'),
      27000,
    );
    assertEquals(socket.frames.find((frame) => frame.type === 'ping'), {
      type: 'ping',
    });
    assertEquals(
      (await f.auth.sessions.list(f.admin.id))[0].lastUsedAt,
      before[0].lastUsedAt,
    );
    await f.state.set('auth.sessionIdleDays', '0.001');
    // This emits a change and therefore triggers a no-touch session recheck.
    await waitFor(() => socket.ended() !== undefined, 1000);
    assertEquals(socket.ended()!.code, 4401);
    assertEquals(socket.ended()!.reason, 'signed_out');
  } finally {
    await socket.close();
    await f.close();
  }
});

Deno.test('events: one in-flight validation merges changes, rechecks a demotion and cannot delay sign-out', async () => {
  let hold: Promise<void> | undefined;
  let waiting = 0;
  let validations = 0;
  const f = await apiFixture({
    services: (f) =>
      Promise.resolve({
        sessions: {
          ...f.auth.sessions,
          async authenticate(
            ...args: Parameters<typeof f.auth.sessions.authenticate>
          ) {
            if (args[1]?.touch === false && hold) {
              waiting++;
              await hold;
            }
            validations++;
            return f.auth.sessions.authenticate(...args);
          },
        },
      }),
  });
  const other = await member(f, 'pending-admin', 'admin');
  const socket = connect(f, other.credential);
  let release = () => {};
  try {
    await socket.hello();
    const before = validations;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.notify.emit(['settings'], { settings: ['first'] }, 'admins');
    await waitFor(() => waiting > 0);
    for (let i = 0; i < 1000; i++) {
      f.notify.emit(['settings'], { settings: [`key-${i}`] }, 'admins');
    }
    await f.auth.users.setRole(f.admin.id, other.id, 'user');
    assertEquals(waiting, 1);
    hold = undefined;
    release();
    await waitFor(() => socket.frames.length > 0);
    // Current role excludes the pending admin-only settings/users; the
    // same user's profile invalidation still arrives over the real socket.
    assertEquals(socket.frames.shift(), {
      type: 'changed',
      events: { me: [other.id] },
    });
    assertEquals(validations, before + 1);

    waiting = 0;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.notify.emit(['me'], { me: [other.id] }, { userId: other.id });
    await waitFor(() => waiting > 0);
    await f.auth.sessions.revoke(f.admin.id, other.body.session.id);
    await waitFor(() => socket.ended() !== undefined, 1000);
    assertEquals(socket.ended()!.code, 4401);
    hold = undefined;
    release();
    await sleep(80);
    assertEquals(socket.frames, []);
  } finally {
    hold = undefined;
    release();
    await socket.close();
    await f.close();
  }
});

Deno.test('events: heartbeat detects a missing session without an ended signal', async () => {
  const f = await apiFixture();
  await f.state.set('melofon.eventsHeartbeatMs', '1000');
  const login = await f.login('bearer');
  const socket = connect(f, login.credential);
  try {
    await socket.hello(1000);
    // Deliberately bypass the core ended signal to exercise the backstop.
    await f.store.sessions.revoke(f.admin.id, login.body.session.id);
    await waitFor(() => socket.ended() !== undefined, 1600);
    assertEquals(socket.ended()!.code, 4401);
    assertEquals(socket.ended()!.reason, 'signed_out');
    assertEquals(socket.frames, []);
  } finally {
    await socket.close();
    await f.close();
  }
});

Deno.test('events: closing the real socket unsubscribes both core listeners', async () => {
  let changes = 0;
  let endings = 0;
  const f = await apiFixture({
    services: (f) =>
      Promise.resolve({
        notify: {
          ...f.notify,
          subscribe(
            fn: Parameters<NonNullable<typeof f.notify>['subscribe']>[0],
          ) {
            changes++;
            const unsub = f.notify!.subscribe(fn);
            let active = true;
            return () => {
              if (active) {
                active = false;
                changes--;
                unsub();
              }
            };
          },
        },
        sessions: {
          ...f.auth.sessions,
          onSessionsEnded(
            fn: Parameters<typeof f.auth.sessions.onSessionsEnded>[0],
          ) {
            endings++;
            const unsub = f.auth.sessions.onSessionsEnded(fn);
            let active = true;
            return () => {
              if (active) {
                active = false;
                endings--;
                unsub();
              }
            };
          },
        },
      }),
  });
  const login = await f.login('bearer');
  const socket = connect(f, login.credential);
  try {
    await socket.hello();
    assertEquals([changes, endings], [1, 1]);
    await socket.close();
    await waitFor(() => changes === 0 && endings === 0);
    f.notify.emit(['settings'], { settings: ['after-close'] }, 'admins');
    await f.auth.sessions.revoke(f.admin.id, login.body.session.id);
    assertEquals(socket.frames, []);
  } finally {
    await socket.close();
    await f.close();
  }
});
