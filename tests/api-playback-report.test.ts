import { assert, assertEquals } from '@std/assert';
import { apiFixture, error } from './helpers/api.ts';
import { authFixture } from './helpers/authentication.ts';
import { restored } from './helpers/prepared.ts';
import { createLibraries } from '../src/libraries.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibrary } from '../src/library.ts';
import { createClientQueue } from '../src/clientqueue.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createPlayback, type Playback } from '../src/playback.ts';
import { createPlayer } from '../src/player.ts';
import { rawSql } from '../src/store/testing.ts';

const path = '/api/v1/me/playback';
async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert(Date.now() < deadline, 'playback observer timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function setup() {
  const dir = await restored('api-playback-report', async (dir) => {
    const f = await authFixture(undefined, dir);
    try {
      await createLibraries(f.store).add(
        'Music',
        await Deno.realPath('tests/fixtures/library'),
      );
      await scanLibrary(f.store);
    } finally {
      await f.close();
    }
  }, 'melofon-api-report-');
  let clock = Date.now();
  let playback!: Playback;
  const f = await apiFixture({
    storeDir: dir,
    services: (f) => {
      const library = createLibrary(f.store);
      playback = createPlayback({
        player: createPlayer(),
        library,
        cfg: f.cfg,
        notify: f.notify,
        nowPlaying: createNowPlaying(f.store, {
          state: f.state,
          now: () => clock,
        }),
        sessions: f.auth.sessions,
      });
      return Promise.resolve({
        library,
        playback,
        clientQueue: createClientQueue(f.store),
      });
    },
  });
  const ips = await Deno.resolveDns('melofon.home', 'A');
  assert(ips.length > 0 && ips.every((ip) => !ip.startsWith('127.')));
  const songs = await createLibrary(f.store).listSongs({ size: 2, offset: 0 });
  const a = await f.login('cookie', 'admin', 'password-admin', 'Phone');
  const b = await f.login('bearer', 'admin', 'password-admin', 'Phone');
  const observers: {
    credential: string;
    ws: WebSocket;
    frames: { type: string; events?: Record<string, string[]> }[];
  }[] = [];
  for (
    const [name, mode] of [['alice', 'cookie'], ['bob', 'bearer'], [
      'admin',
      'bearer',
    ]] as const
  ) {
    if (name !== 'admin') {
      await f.auth.users.create(f.admin.id, {
        username: name,
        password: 'password-member',
        role: 'user',
      });
    }
    const login = await f.login(
      mode,
      name,
      name === 'admin' ? 'password-admin' : 'password-member',
    );
    const ws = new WebSocket(
      f.origin.replace('http:', 'ws:') + '/api/v1/events',
      {
        headers: {
          Origin: f.origin,
          ...(mode === 'cookie'
            ? { Cookie: login.credential }
            : { Authorization: `Bearer ${login.credential}` }),
        },
      },
    );
    const frames: { type: string; events?: Record<string, string[]> }[] = [];
    ws.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
    await waitFor(() => frames.some((frame) => frame.type === 'hello'));
    observers.push({ ...login, ws, frames });
  }
  const base = {
    songId: songs[0].id,
    run: 1,
    sequence: 0,
    state: 'starting',
    positionMs: 0,
  };
  const post = (
    credential: string,
    extra: Record<string, unknown> = {},
    route = path,
  ) => f.json(route, 'POST', { ...base, ...extra }, credential);
  const send = async (
    credential: string,
    extra: Record<string, unknown> = {},
    route = path,
  ) => {
    const r = await post(credential, extra, route);
    assertEquals(r.status, 200, await r.clone().text());
    assertEquals(await r.json(), { accepted: true });
  };
  const read = async (credential: string) => {
    const r = await f.get('/api/v1/now-playing', credential);
    assertEquals(r.status, 200);
    const body = await r.json();
    const text = JSON.stringify(body);
    for (
      const value of [
        dir,
        a.credential,
        b.credential,
        a.body.session.id,
        b.body.session.id,
        ...songs.map((s) => s.path),
      ]
    ) {
      assert(!text.includes(value), 'private report identity escaped');
    }
    return body.nowPlaying as {
      kind: string;
      username: string;
      client: string;
      appPlayerId: number;
      state: string;
      positionMs: number;
      playbackRate: number;
      song: { id: string };
    }[];
  };
  let marker = 0;
  const drain = async () => {
    const id = String(++marker);
    f.notify.emit(['library'], { library: [id] }, 'all');
    for (const o of observers) {
      await waitFor(() =>
        o.frames.some((frame) => frame.events?.library?.includes(id))
      );
    }
  };
  const clear = () => {
    for (const o of observers) o.frames.length = 0;
  };
  const changed = async () => {
    for (const o of observers) {
      await waitFor(() => o.frames.some((frame) => frame.events?.nowPlaying));
      assertEquals(
        o.frames.find((frame) => frame.events?.nowPlaying)!.events!.nowPlaying,
        [],
      );
      assert(!o.frames.some((frame) => frame.events?.player));
    }
    await drain();
    const rows = await read(observers[0].credential);
    for (const o of observers) assertEquals(await read(o.credential), rows);
    clear();
    return rows;
  };
  await drain();
  clear();
  return {
    f,
    a,
    b,
    songs,
    base,
    playback,
    observers,
    post,
    send,
    read,
    drain,
    clear,
    changed,
    advance(ms: number) {
      clock += ms;
    },
    async close() {
      for (const o of observers) {
        o.ws.close();
        await waitFor(() => o.ws.readyState === WebSocket.CLOSED);
      }
      await playback.close();
      await f.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('API playback reports: cookie and Bearer progress reaches every household observer and counts once', async () => {
  const t = await setup();
  try {
    const { f, a, b } = t;
    const song = t.songs[0];
    const duration = song.durationMs!;
    assert(duration > 1000);
    const saved = await f.json('/api/v1/me/queue', 'PUT', {
      songIds: t.songs.map((s) => s.id),
      currentIndex: 1,
      positionMs: 123,
    }, a.credential);
    assertEquals(saved.status, 200);
    const queue = await saved.json();
    const engine = t.playback.playerView();
    await t.send(a.credential);
    let rows = await t.changed();
    assertEquals(rows.length, 1);
    assertEquals(rows[0].state, 'starting');
    assertEquals(rows[0].username, 'admin');
    assertEquals(rows[0].client, 'Phone');
    assertEquals(rows[0].positionMs, 0);
    assertEquals(rows[0].playbackRate, 1);
    const id = rows[0].appPlayerId;
    await t.send(
      b.credential,
      { state: 'paused', positionMs: 20 },
      '/_melofon/api/v1/me/playback',
    );
    rows = await t.changed();
    assertEquals(rows.length, 2);
    assertEquals(new Set(rows.map((r) => r.appPlayerId)).size, 2);
    assert(rows.every((r) => r.client === 'Phone'));
    await t.send(t.observers[0].credential, { state: 'paused' });
    rows = await t.changed();
    assertEquals(rows.length, 3);
    assertEquals(rows.find((r) => r.username === 'alice')!.client, 'Device');
    await t.send(t.observers[0].credential, { sequence: 1, state: 'stopped' });
    assertEquals((await t.changed()).length, 2);
    await t.send(a.credential, {
      sequence: 1,
      state: 'playing',
      positionMs: 100,
      playbackRate: 2,
    });
    rows = await t.changed();
    assertEquals(rows.find((r) => r.appPlayerId === id)!.positionMs, 100);
    t.advance(200);
    rows = await t.read(t.observers[0].credential);
    assertEquals(rows.find((r) => r.appPlayerId === id)!.positionMs, 500);
    assertEquals(rows.find((r) => r.appPlayerId !== id)!.positionMs, 20);
    await t.send(a.credential, {
      sequence: 2,
      state: 'paused',
      positionMs: 300,
    });
    await t.changed();
    t.advance(500);
    assertEquals(
      (await t.read(a.credential)).find((r) => r.appPlayerId === id)!
        .positionMs,
      300,
    );
    await t.send(a.credential, {
      sequence: 3,
      state: 'playing',
      positionMs: duration - 1,
      playbackRate: 2,
    });
    await t.changed();
    t.advance(1000);
    assertEquals(
      (await t.read(a.credential)).find((r) => r.appPlayerId === id)!
        .positionMs,
      duration,
    );
    await error(
      await t.post(a.credential, { sequence: 2, state: 'paused' }),
      409,
      'playback_conflict',
    );
    // Repeating the same song must replace the run, not admit delayed run-1 packets.
    await t.send(a.credential, { run: 2, state: 'paused', positionMs: 10 });
    const current = await t.changed();
    for (
      const extra of [
        { sequence: 99, state: 'stopped', positionMs: duration },
        { sequence: 100 },
        { run: 2 },
        { run: 2, sequence: 1, songId: t.songs[1].id },
      ]
    ) {
      await error(await t.post(a.credential, extra), 409, 'playback_conflict');
    }
    await t.drain();
    assert(
      t.observers.every((o) =>
        !o.frames.some((frame) => frame.events?.nowPlaying)
      ),
    );
    assertEquals(await t.read(a.credential), current);
    t.clear();
    const stop = {
      run: 2,
      sequence: 1,
      state: 'stopped',
      positionMs: duration,
    };
    const results = await Promise.all([
      t.post(a.credential, stop),
      t.post(a.credential, stop),
    ]);
    assertEquals(results.map((r) => r.status).sort(), [200, 409]);
    for (const r of results) {
      if (r.status === 200) assertEquals(await r.json(), { accepted: true });
      else await error(r, 409, 'playback_conflict');
    }
    rows = await t.changed();
    assertEquals(rows.length, 1);
    assert(rows[0].appPlayerId !== id);
    await error(
      await t.post(a.credential, { run: 2, sequence: 2, state: 'playing' }),
      409,
      'playback_conflict',
    );
    await t.send(b.credential, {
      sequence: 1,
      state: 'stopped',
      positionMs: duration,
      ignoreScrobble: true,
    });
    assertEquals(await t.changed(), []);
    await t.send(a.credential, { run: 3, state: 'playing' });
    await t.changed();
    await t.send(a.credential, {
      run: 3,
      sequence: 1,
      state: 'stopped',
      positionMs: Math.ceil(duration / 2) - 1,
    });
    assertEquals(await t.changed(), []);
    assertEquals(
      await rawSql(f.store).all('SELECT source, duration_ms FROM listens'),
      [{ source: 'melofon', duration_ms: duration }],
    );
    assertEquals(t.playback.playerView(), engine);
    const after = await f.get('/api/v1/me/queue', b.credential);
    assertEquals(after.status, 200);
    assertEquals(await after.json(), queue);
  } finally {
    await t.close();
  }
});

Deno.test('API playback reports: invalid input auth and Origin preserve live reports', async () => {
  const t = await setup();
  try {
    const { f, a, b } = t;
    await error(await f.json(path, 'POST', t.base), 401, 'unauthenticated');
    await error(
      await f.json('/_melofon' + path, 'POST', t.base),
      401,
      'unauthenticated',
    );
    await t.send(a.credential, { state: 'paused', positionMs: 40 });
    const before = await t.changed();
    for (
      const key of [
        'username',
        'userId',
        'sessionId',
        'client',
        'deviceName',
        'source',
        'trackId',
      ]
    ) {
      await error(
        await t.post(a.credential, {
          [key]: key === 'sessionId' ? b.body.session.id : 'spoofed',
        }),
        400,
        'unknown_field',
      );
    }
    for (
      const extra of [
        { songId: '' },
        { songId: null },
        { songId: 1 },
        { run: 0 },
        { run: -1 },
        { run: 1.5 },
        { run: 9007199254740992 },
        { run: '2' },
        { sequence: -1 },
        { sequence: 0.5 },
        { sequence: 9007199254740992 },
        { sequence: '1' },
        { positionMs: -1 },
        { positionMs: 0.5 },
        { positionMs: 9007199254740992 },
        { positionMs: null },
        { state: 'idle' },
        { state: null },
        { playbackRate: 0 },
        { playbackRate: -1 },
        { playbackRate: '1' },
        { playbackRate: null },
        { ignoreScrobble: 'false' },
        { ignoreScrobble: null },
      ]
    ) await error(await t.post(a.credential, extra), 400, 'invalid_field');
    for (const key of ['songId', 'run', 'sequence', 'state', 'positionMs']) {
      const body: Record<string, unknown> = { ...t.base };
      delete body[key];
      await error(
        await f.json(path, 'POST', body, a.credential),
        400,
        'invalid_field',
      );
    }
    await error(
      await t.post(a.credential, { songId: 'missing', run: 2 }),
      404,
      'not_found',
    );
    for (const origin of [null, 'null', 'http://foreign.home']) {
      await error(
        await f.json(path, 'POST', { ...t.base, run: 2 }, a.credential, origin),
        403,
        'origin',
      );
    }
    await error(
      await f.json(path, 'POST', t.base, b.credential, 'http://foreign.home'),
      403,
      'origin',
    );
    await error(
      await f.request(path, {
        method: 'POST',
        headers: {
          Origin: f.origin,
          Cookie: a.credential,
          'Content-Type': 'application/json',
        },
        body: '{',
      }),
      400,
      'not_json',
    );
    await error(
      await f.request(path, {
        method: 'POST',
        headers: {
          Origin: f.origin,
          Cookie: a.credential,
          'Content-Type': 'application/json',
        },
        body:
          '{"songId":"x","run":2,"sequence":0,"positionMs":0,"state":"paused","playbackRate":1e999}',
      }),
      400,
      'invalid_field',
    );
    await error(await f.json(path, 'POST', [], a.credential), 400, 'not_json');
    await t.drain();
    assert(
      t.observers.every((o) =>
        !o.frames.some((frame) => frame.events?.nowPlaying)
      ),
    );
    assertEquals(await t.read(a.credential), before);
    assertEquals(await rawSql(f.store).all('SELECT * FROM listens'), []);
    t.clear();
    // Bearer devices need no Origin; their identity still comes only from auth.
    const bearer = await f.json(
      path,
      'POST',
      { ...t.base, state: 'paused' },
      b.credential,
      null,
    );
    assertEquals(bearer.status, 200);
    assertEquals(await bearer.json(), { accepted: true });
    assertEquals((await t.changed()).length, 2);
    const revoke = await f.json(
      `/api/v1/me/sessions/${b.body.session.id}`,
      'DELETE',
      undefined,
      a.credential,
    );
    assertEquals(revoke.status, 200);
    await revoke.body?.cancel();
    assertEquals(await t.changed(), before);
    await error(await t.post(b.credential, { run: 2 }), 401, 'unauthenticated');
    assertEquals(await t.read(a.credential), before);
    assertEquals(await rawSql(f.store).all('SELECT * FROM listens'), []);
  } finally {
    await t.close();
  }
});
