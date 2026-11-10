import { assert, assertEquals, assertRejects } from '@std/assert';
import { apiFixture, error } from './helpers/api.ts';
import { restored } from './helpers/prepared.ts';
import { openStore } from '../src/store/index.ts';
import { seedFirstUser } from '../src/users.ts';
import { createLibraries } from '../src/libraries.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibrary } from '../src/library.ts';
import { createUserService } from '../src/user.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { createClientQueue } from '../src/clientqueue.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createPlayback, type Playback } from '../src/playback.ts';
import { createOutputs, createPlayer, type Outputs } from '../src/player.ts';
import { wireInt } from '../layers/owntone/payloads.ts';
import { rawSql } from '../src/store/testing.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert(Date.now() < deadline, 'now-playing observer timeout');
    await sleep(10);
  }
}
interface Frame {
  type: string;
  events?: Record<string, string[]>;
  notify?: string[];
}
function socket(url: string, headers?: Record<string, string>) {
  const ws = headers
    ? new WebSocket(url, { headers })
    : new WebSocket(url, 'notify');
  const frames: Frame[] = [];
  ws.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
  return {
    ws,
    frames,
    async close() {
      if (ws.readyState < WebSocket.CLOSING) ws.close();
      await waitFor(() => ws.readyState === WebSocket.CLOSED);
    },
  };
}

async function setup(now?: () => number) {
  const dir = await restored('api-now-playing', async (dir) => {
    const store = await openStore(dir);
    try {
      await seedFirstUser(store, {
        listen: undefined,
        dataDir: dir,
        user: 'admin',
        password: 'password-admin',
        secret: 'test-secret',
      });
      await createLibraries(store).add(
        'Music',
        await Deno.realPath('tests/fixtures/library'),
      );
      await scanLibrary(store);
    } finally {
      await store.close();
    }
  }, 'melofon-api-np-');
  let playback!: Playback;
  let outputs!: Outputs;
  const f = await apiFixture({
    storeDir: dir,
    hats: {
      layersRoot: 'layers',
      extraPorts: 1,
      env: ([port]) => ({ MELOFON_LISTEN_owntone: `${port},${port}` }),
    },
    services: (f) => {
      const library = createLibrary(f.store);
      outputs = createOutputs({ notify: f.notify });
      playback = createPlayback({
        player: createPlayer(),
        outputs,
        library,
        nowPlaying: createNowPlaying(f.store, { state: f.state, now }),
        sessions: f.auth.sessions,
        cfg: f.cfg,
        notify: f.notify,
      });
      return Promise.resolve({
        library,
        libraries: createLibraries(f.store),
        user: createUserService(f.store, f.cfg),
        annotation: createAnnotation(f.store),
        listens: createListens(f.store),
        clientQueue: createClientQueue(f.store),
        outputs,
        playback,
      });
    },
  });
  const ownOrigin = `http://melofon.home:${f.extraPorts[0]}`;
  const own = async (path: string, method = 'PUT', body?: unknown) => {
    const response = await fetch(ownOrigin + path, {
      method,
      ...(body === undefined ? {} : {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      signal: AbortSignal.timeout(5000),
    });
    assert(response.ok, await response.clone().text());
    await response.body?.cancel();
  };
  const rest = async (op: string, extra: Record<string, string>) => {
    const response = await f.get(`/rest/${op}?${new URLSearchParams({
      u: 'admin',
      p: 'password-admin',
      c: 'Phone',
      v: '1.16.1',
      f: 'json',
      ...extra,
    })}`);
    assertEquals(response.status, 200);
    const body = (await response.json())['subsonic-response'];
    assertEquals(body.status, 'ok');
    return body;
  };
  const songs = await createLibrary(f.store).listSongs({ size: 2, offset: 0 });
  const observers: (Awaited<ReturnType<typeof f.login>> & {
    socket: ReturnType<typeof socket>;
  })[] = [];
  for (
    const [name, mode] of [
      ['alice', 'cookie'],
      ['bob', 'bearer'],
      ['admin', 'bearer'],
    ] as const
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
    const s = socket(f.origin.replace('http:', 'ws:') + '/api/v1/events', {
      ...(mode === 'cookie'
        ? { Cookie: login.credential }
        : { Authorization: `Bearer ${login.credential}` }),
      Origin: f.origin,
    });
    await waitFor(() => s.frames.some((frame) => frame.type === 'hello'));
    s.frames.length = 0;
    observers.push({ ...login, socket: s });
  }
  const ownSocket = socket(ownOrigin.replace('http:', 'ws:') + '/');
  await waitFor(() => ownSocket.ws.readyState === WebSocket.OPEN);
  ownSocket.ws.send(JSON.stringify({ notify: ['player', 'queue'] }));
  // A real engine change is the positive control and subscription barrier.
  for (let attempt = 0; ownSocket.frames.length === 0; attempt++) {
    assert(attempt < 30, 'OwnTone subscription did not land');
    await own('/api/player/pause');
    await sleep(10);
  }
  assert(ownSocket.frames.some((frame) => frame.notify?.includes('player')));
  ownSocket.frames.length = 0;
  let marker = 0;
  const drain = async () => {
    const id = String(++marker);
    f.notify.emit(['library'], { library: [id] }, 'all');
    for (const observer of observers) {
      await waitFor(() =>
        observer.socket.frames.some((frame) =>
          frame.events?.library?.includes(id)
        )
      );
    }
  };
  await drain();
  for (const observer of observers) observer.socket.frames.length = 0;
  const read = async (
    observer = observers[0],
    path = '/api/v1/now-playing',
  ) => {
    const response = await f.get(path, observer.credential);
    assertEquals(response.status, 200, await response.clone().text());
    assertEquals(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert(Number.isSafeInteger(body.observedAtMs));
    const text = JSON.stringify(body);
    for (
      const privateValue of [
        dir,
        'test-secret',
        'password-admin',
        'password-member',
        'private-peer',
        'private-agent',
        ...songs.map((s) => s.path),
        ...observers.flatMap((o) => [o.credential, o.body.session.id]),
      ]
    ) {
      assert(
        !text.includes(privateValue),
        `private fact escaped: ${privateValue}`,
      );
    }
    for (const row of body.nowPlaying) {
      assert(!('path' in row.song));
      assert(!('source' in row));
      assert(!('sessionId' in row));
    }
    return body;
  };
  const changed = async () => {
    for (const observer of observers) {
      await waitFor(() =>
        observer.socket.frames.some((frame) => frame.events?.nowPlaying)
      );
      assertEquals(
        observer.socket.frames.find((frame) => frame.events?.nowPlaying)?.events
          ?.nowPlaying,
        [],
      );
    }
    await drain();
  };
  const clear = () => {
    for (const observer of observers) observer.socket.frames.length = 0;
    ownSocket.frames.length = 0;
  };
  return {
    f,
    playback,
    outputs,
    songs,
    observers,
    ownSocket,
    own,
    rest,
    read,
    changed,
    clear,
    drain,
    async close() {
      for (const observer of observers) await observer.socket.close();
      await ownSocket.close();
      await playback.close();
      await f.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('household now-playing: scheduled expiry notifies before observer reads and never counts a listen', async () => {
  let clock = Date.now();
  const t = await setup(() => clock);
  try {
    assert(
      (await Deno.resolveDns('melofon.home', 'A')).every((ip) =>
        !ip.startsWith('127.')
      ),
    );
    await t.f.state.set('playback.sessionGraceMinutes', '0.001');
    await t.f.state.set('playback.pausedSessionMinutes', '0.002');
    await t.f.state.set('playback.sessionSweepSeconds', '0.02');
    await t.playback.startReportExpiry(t.f.state);
    await t.playback.startReportExpiry(t.f.state); // idempotent lifecycle start
    const duration = t.songs[0].durationMs!;
    assert(duration >= 100);
    for (
      const [client, state] of [
        ['Phone', 'playing'],
        ['Starting', 'starting'],
        ['Tablet', 'paused'],
      ]
    ) {
      await t.rest('reportPlayback', {
        c: client,
        mediaId: t.songs[0].id,
        mediaType: 'song',
        state,
        positionMs: String(duration - 100),
        playbackRate: '2',
      });
    }
    await t.changed();
    const before = (await t.read()).nowPlaying;
    assertEquals(before.length, 3);
    const phoneId = before.find((r: { client: string }) =>
      r.client === 'Phone'
    ).appPlayerId;
    t.clear();
    clock += 109; // planned end in 50 ms + 60 ms grace; paused idle is 120 ms
    assertEquals(await t.playback.expireReports(), false);
    await t.drain();
    for (const o of t.observers) {
      assert(!o.socket.frames.some((f) => f.events?.nowPlaying));
    }
    t.clear();
    clock++;
    // No GET, report or explicit sweep here: the production lifecycle does the removal.
    await t.changed();
    assertEquals((await t.f.store.nowPlaying.list()).map((r) => r.client), [
      'Tablet',
    ]);
    for (const o of t.observers) {
      assertEquals(
        (await t.read(o)).nowPlaying.map((r: { client: string }) => r.client),
        ['Tablet'],
      );
      assert(!o.socket.frames.some((f) => f.events?.player));
    }
    assertEquals(t.ownSocket.frames, []);
    t.clear();
    clock += 10;
    await t.changed();
    assertEquals(
      await t.f.store.nowPlaying.list(),
      [],
      'removal committed before invalidation/refetch',
    );
    for (const o of t.observers) assertEquals((await t.read(o)).nowPlaying, []);
    assertEquals(await rawSql(t.f.store).all('SELECT * FROM listens'), []);
    t.clear();
    assertEquals(
      await Promise.all([
        t.playback.expireReports(),
        t.playback.expireReports(),
      ]),
      [false, false],
    );
    await t.drain();
    for (const o of t.observers) {
      assert(!o.socket.frames.some((f) => f.events?.nowPlaying));
    }
    assertEquals(t.ownSocket.frames, []);
    await t.rest('scrobble', { id: t.songs[0].id, submission: 'false' });
    await t.changed();
    assertEquals((await t.read()).nowPlaying[0].appPlayerId, phoneId);
    // Stop lifecycle, then move beyond expiry: no background work survives close.
    await t.playback.close();
    t.clear();
    clock += duration + 60000;
    await sleep(80);
    await t.drain();
    assertEquals((await t.f.store.nowPlaying.list()).length, 1);
    for (const o of t.observers) {
      assert(!o.socket.frames.some((f) => f.events?.nowPlaying));
    }
    assertEquals(await rawSql(t.f.store).all('SELECT * FROM listens'), []);
  } finally {
    await t.close();
  }
});

Deno.test('household now-playing: Subsonic reports invalidate every native member, not the OwnTone engine', async () => {
  const t = await setup();
  try {
    const addresses = await Deno.resolveDns('melofon.home', 'A');
    assert(
      addresses.length > 0 && addresses.every((ip) => !ip.startsWith('127.')),
    );
    await error(await t.f.get('/api/v1/now-playing'), 401, 'unauthenticated');
    await error(
      await t.f.get('/_melofon/api/v1/now-playing'),
      401,
      'unauthenticated',
    );
    for (const observer of t.observers) {
      assertEquals((await t.read(observer)).nowPlaying, []);
    }
    await t.rest('scrobble', { id: t.songs[0].id, submission: 'false' });
    await t.changed();
    for (const observer of t.observers) {
      const { nowPlaying } = await t.read(observer);
      assertEquals(nowPlaying.length, 1);
      const row = nowPlaying[0];
      assertEquals(row.kind, 'app');
      assertEquals(row.username, 'admin');
      assertEquals(row.client, 'Phone');
      assert(row.appPlayerId > 0);
      assertEquals(row.song.id, t.songs[0].id);
      assertEquals(row.song.title, t.songs[0].title);
      assertEquals(row.state, 'playing');
      assertEquals(row.playbackRate, 1);
      assert(!observer.socket.frames.some((frame) => frame.events?.player));
    }
    assertEquals(t.ownSocket.frames, []);
    t.clear();
    await t.rest('reportPlayback', {
      mediaId: t.songs[1].id,
      mediaType: 'song',
      positionMs: '100',
      state: 'paused',
      playbackRate: '1.5',
    });
    await t.changed();
    const paused = (await t.read()).nowPlaying[0];
    assertEquals(paused.song.id, t.songs[1].id);
    assertEquals(paused.state, 'paused');
    assertEquals(paused.positionMs, Math.min(100, t.songs[1].durationMs!));
    assertEquals(paused.playbackRate, 1.5);
    assertEquals(
      (await t.read(t.observers[1], '/_melofon/api/v1/now-playing')).nowPlaying,
      [paused],
    );
    assertEquals(t.ownSocket.frames, []);
    t.clear();
    await t.rest('reportPlayback', {
      mediaId: t.songs[1].id,
      mediaType: 'song',
      positionMs: '0',
      state: 'stopped',
    });
    await t.changed();
    for (const observer of t.observers) {
      assertEquals((await t.read(observer)).nowPlaying, []);
    }
    assertEquals(t.ownSocket.frames, []);
  } finally {
    await t.close();
  }
});

Deno.test('household now-playing: OwnTone commands, selected speakers and commander changes invalidate the server row', async () => {
  const t = await setup();
  try {
    t.outputs.register({
      id: 'living',
      name: 'Living room',
      type: 'AirPlay',
      selected: true,
      volume: 50,
      host: '192.0.2.1',
    });
    await t.own(
      `/api/queue/items/add?uris=library:track:${
        wireInt(t.songs[0].id)
      }&playback=start&clear=true`,
      'POST',
    );
    await t.changed();
    for (const observer of t.observers) {
      const row = (await t.read(observer)).nowPlaying[0];
      assertEquals(row.kind, 'server');
      assertEquals(row.label, 'melofon');
      assertEquals(row.commander, null);
      assertEquals(row.speakers, [{ id: 'living', name: 'Living room' }]);
      assertEquals(row.song.id, t.songs[0].id);
      assertEquals(row.state, 'playing');
      assert(!('username' in row));
      assert(!('appPlayerId' in row));
    }
    for (
      const [path, state] of [['pause', 'paused'], ['play', 'playing'], [
        'seek?position_ms=100',
        'playing',
      ]] as const
    ) {
      t.clear();
      await t.own(`/api/player/${path}`);
      await t.changed();
      assertEquals((await t.read()).nowPlaying[0].state, state);
    }
    t.clear();
    await t.own('/api/player/pause');
    await t.changed();
    const paused = (await t.read()).nowPlaying[0];
    assertEquals((await t.read()).nowPlaying[0], paused);
    t.clear();
    t.outputs.register({
      id: 'living',
      name: 'Renamed room',
      type: 'AirPlay',
      selected: true,
      volume: 50,
    });
    await t.changed();
    assertEquals((await t.read()).nowPlaying[0].speakers, [{
      id: 'living',
      name: 'Renamed room',
    }]);
    t.clear();
    await t.own('/api/outputs/set', 'PUT', { outputs: [] });
    await t.changed();
    assertEquals((await t.read()).nowPlaying[0].speakers, []);
    t.clear();
    t.playback.setRepeat('all', {
      kind: 'http',
      user: 'alice',
      peer: 'private-peer',
      userAgent: 'private-agent',
    });
    await t.changed();
    assertEquals((await t.read()).nowPlaying[0].commander, 'alice');
    t.clear();
    await t.own('/api/player/volume?volume=42');
    await t.changed();
    assertEquals((await t.read()).nowPlaying[0].commander, null);
    t.clear();
    await t.own('/api/player/stop');
    await t.changed();
    for (const observer of t.observers) {
      const rows = (await t.read(observer)).nowPlaying;
      assertEquals(rows.length, 1);
      assertEquals(rows[0].state, 'paused');
    }
  } finally {
    await t.close();
  }
});

Deno.test('household now-playing: legacy scrobbles and competing reported stops keep count and provenance over HTTP', async () => {
  let clock = Date.now();
  const t = await setup(() => clock);
  try {
    const ips = await Deno.resolveDns('melofon.home', 'A');
    assert(ips.length > 0 && ips.every((ip) => !ip.startsWith('127.')));
    const song = t.songs[0];
    const duration = song.durationMs!;
    await t.own(
      `/api/queue/items/add?uris=library:track:${
        wireInt(song.id)
      }&playback=start&clear=true`,
      'POST',
    );
    await t.own('/api/player/pause');
    await t.changed();
    const server = (await t.read()).nowPlaying[0];
    t.clear();
    await t.rest('scrobble', {
      id: song.id,
      source: 'melofon',
      time: String(clock),
    });
    assertEquals((await t.rest('getSong', { id: song.id })).song.playCount, 1);
    assertEquals(
      (await t.read()).nowPlaying,
      [server],
      'submission never reports playback',
    );
    await t.rest('scrobble', {
      id: song.id,
      submission: 'false',
      source: 'melofon',
    });
    await t.changed();
    assertEquals((await t.read()).nowPlaying.length, 2);
    t.clear();
    const stop = {
      mediaId: song.id,
      mediaType: 'song',
      state: 'stopped',
      positionMs: String(duration),
      source: 'melofon',
    };
    await Promise.all([
      t.rest('reportPlayback', stop),
      t.rest('reportPlayback', stop),
    ]);
    await t.changed();
    for (const o of t.observers) {
      assertEquals((await t.read(o)).nowPlaying, [server]);
    }
    assertEquals((await t.rest('getSong', { id: song.id })).song.playCount, 2);
    const expected = [
      { source: 'opensubsonic', duration_ms: null },
      { source: 'opensubsonic', duration_ms: duration },
    ];
    assertEquals(
      await rawSql(t.f.store).all(
        'SELECT source, duration_ms FROM listens ORDER BY duration_ms NULLS FIRST',
      ),
      expected,
    );
    for (
      const extra of [
        { positionMs: String(Math.ceil(duration / 2) - 1) },
        { ignoreScrobble: 'true' },
        { mediaId: t.songs[1].id },
      ] as Record<string, string>[]
    ) {
      await t.rest('reportPlayback', {
        ...stop,
        state: 'playing',
        positionMs: '0',
      });
      await t.rest('reportPlayback', { ...stop, ...extra });
    }
    await t.rest('reportPlayback', { ...stop, state: 'paused' });
    clock += 30 * 60000;
    await t.rest('reportPlayback', stop);
    await t.rest('reportPlayback', stop);
    assertEquals((await t.rest('getSong', { id: song.id })).song.playCount, 2);
    assertEquals(
      await rawSql(t.f.store).all(
        'SELECT source, duration_ms FROM listens ORDER BY duration_ms NULLS FIRST',
      ),
      expected,
    );
    assertEquals(
      (await t.read()).nowPlaying,
      [server],
      'engine stays independent',
    );
  } finally {
    await t.close();
  }
});

Deno.test('household now-playing: native sessions separate same-name devices and guard same-song runs', async () => {
  let clock = Date.now();
  const t = await setup(() => clock);
  try {
    const ips = await Deno.resolveDns('melofon.home', 'A');
    assert(ips.length > 0 && ips.every((ip) => !ip.startsWith('127.')));
    const a = await t.f.login('cookie', 'admin', 'password-admin', 'Phone');
    const b = await t.f.login('bearer', 'admin', 'password-admin', 'Phone');
    const c = await t.f.login('bearer', 'alice', 'password-member', 'Phone');
    const song = t.songs[0];
    const base = {
      userId: a.body.user.id,
      sessionId: a.body.session.id,
      run: 1,
      sequence: 0,
      trackId: song.id,
      positionMs: 10,
      state: 'starting' as const,
      playbackRate: 1,
      ignoreScrobble: false,
    };
    const send = (
      extra: Partial<Parameters<Playback['reportSessionPlayback']>[0]> = {},
    ) => t.playback.reportSessionPlayback({ ...base, ...extra });
    const engine = t.playback.playerView();
    const queue = await t.f.get('/api/v1/me/queue', a.credential);
    assertEquals(queue.status, 200);
    const savedQueue = await queue.json();
    assertEquals(await send(), true);
    assertEquals(
      await send({ sessionId: b.body.session.id, state: 'paused' }),
      true,
    );
    assertEquals(
      await send({
        userId: c.body.user.id,
        sessionId: c.body.session.id,
        state: 'paused',
      }),
      true,
    );
    await t.rest('reportPlayback', {
      mediaId: song.id,
      mediaType: 'song',
      state: 'paused',
      positionMs: '100',
    });
    await t.changed();
    const before = (await t.read()).nowPlaying;
    assertEquals(before.length, 4);
    assertEquals(
      new Set(before.map((r: { appPlayerId: number }) => r.appPlayerId)).size,
      4,
    );
    assert(before.every((r: { client: string }) => r.client === 'Phone'));
    assertEquals(before.map((r: { username: string }) => r.username).sort(), [
      'admin',
      'admin',
      'admin',
      'alice',
    ]);
    const nativeId = (await t.f.store.nowPlaying.list()).find((r) =>
      r.state === 'starting'
    )!.playerId;
    for (const observer of t.observers) {
      assertEquals((await t.read(observer)).nowPlaying, before);
    }
    for (const login of [a, b, c]) {
      assert(!JSON.stringify(before).includes(login.body.session.id));
      assert(!JSON.stringify(before).includes(login.credential));
    }
    t.clear();
    for (
      const extra of [
        {},
        { run: 0 },
        { sequence: -1 },
        { positionMs: NaN },
        { playbackRate: 0 },
      ]
    ) {
      if (Object.keys(extra).length === 0) assertEquals(await send(), false);
      else {await assertRejects(
          () => send(extra),
          Error,
          'Invalid session playback report',
        );}
    }
    assertEquals(await send({ userId: c.body.user.id, sequence: 1 }), false);
    assertEquals(await send({ sequence: 1, trackId: 'missing' }), false);
    assertEquals(await send({ sequence: 1, trackId: t.songs[1].id }), false);
    await t.drain();
    assert(
      t.observers.every((o) =>
        !o.socket.frames.some((f) => f.events?.nowPlaying)
      ),
    );
    assertEquals((await t.read()).nowPlaying, before);
    clock += 1000;
    assertEquals(
      await send({ run: 2, state: 'paused', positionMs: 200 }),
      true,
    );
    await t.changed();
    const current = (await t.read()).nowPlaying;
    const row = current.find((r: { appPlayerId: number }) =>
      r.appPlayerId === nativeId
    )!;
    assertEquals(row.startedAtMs, clock);
    assertEquals(row.positionMs, 200);
    t.clear();
    assertEquals(
      await send({
        sequence: 100,
        state: 'stopped',
        positionMs: song.durationMs!,
      }),
      false,
    );
    assertEquals(await send({ sequence: 101, state: 'starting' }), false);
    assertEquals((await t.read()).nowPlaying, current);
    assertEquals(
      await send({ run: 2, sequence: 2, state: 'paused', positionMs: 250 }),
      true,
    );
    assertEquals(await send({ run: 2, sequence: 1, state: 'playing' }), false);
    assertEquals(
      (await t.read()).nowPlaying.find((r: { appPlayerId: number }) =>
        r.appPlayerId === nativeId
      ).positionMs,
      250,
    );
    assertEquals(
      await Promise.all([
        send({
          run: 2,
          sequence: 3,
          state: 'stopped',
          positionMs: song.durationMs!,
        }),
        send({
          run: 2,
          sequence: 3,
          state: 'stopped',
          positionMs: song.durationMs!,
        }),
      ]),
      [true, false],
    );
    await t.changed();
    for (const observer of t.observers) {
      assertEquals((await t.read(observer)).nowPlaying.length, 3);
    }
    assertEquals(await send({ run: 2, sequence: 4, state: 'playing' }), false);
    assertEquals(
      await rawSql(t.f.store).all('SELECT source, duration_ms FROM listens'),
      [
        { source: 'melofon', duration_ms: song.durationMs },
      ],
    );
    assertEquals(t.playback.playerView(), engine);
    const afterQueue = await t.f.get('/api/v1/me/queue', a.credential);
    assertEquals(afterQueue.status, 200);
    assertEquals(await afterQueue.json(), savedQueue);
    assertEquals(t.ownSocket.frames, []);
  } finally {
    await t.close();
  }
});

Deno.test('household now-playing: logout revoke-all password and observed idle end native reports without listens', async () => {
  const t = await setup();
  try {
    const login = () => t.f.login('bearer', 'admin', 'password-admin', 'Phone');
    let a = await login();
    const seed = (signed: typeof a, run = 1) =>
      t.playback.reportSessionPlayback({
        userId: signed.body.user.id,
        sessionId: signed.body.session.id,
        run,
        sequence: 0,
        trackId: t.songs[0].id,
        positionMs: 0,
        state: 'paused',
        playbackRate: 1,
        ignoreScrobble: false,
      });
    const ended = async () => {
      await t.changed();
      for (const observer of t.observers) {
        assertEquals((await t.read(observer)).nowPlaying, []);
      }
      assertEquals(
        await rawSql(t.f.store).all('SELECT * FROM now_playing'),
        [],
      );
      assertEquals(await rawSql(t.f.store).all('SELECT * FROM listens'), []);
      t.clear();
    };
    assertEquals(await seed(a), true);
    await t.changed();
    t.clear();
    const revoked = await t.f.json(
      `/api/v1/me/sessions/${a.body.session.id}`,
      'DELETE',
      undefined,
      t.observers[2].credential,
    );
    assertEquals(revoked.status, 200);
    await revoked.body?.cancel();
    await ended();
    assertEquals(await seed(a, 2), false);
    assertEquals(await t.playback.expireReports(), false);
    a = await login();
    const b = await login();
    await seed(a);
    await seed(b);
    await t.changed();
    t.clear();
    const all = await t.f.json(
      '/api/v1/me/sessions',
      'DELETE',
      undefined,
      a.credential,
    );
    assertEquals(all.status, 200);
    await all.body?.cancel();
    // The admin observer was also signed out; ordinary household observers remain.
    await waitFor(() =>
      t.observers[2].socket.ws.readyState === WebSocket.CLOSED
    );
    t.observers.pop();
    await ended();
    assertEquals(await seed(a, 2), false);
    assertEquals(await seed(b, 2), false);
    a = await login();
    await seed(a);
    await t.changed();
    t.clear();
    t.f.advance(86400);
    // Keep observers active while only the reporting device goes idle.
    for (const observer of t.observers) await t.read(observer);
    await t.f.state.set('auth.sessionIdleDays', '0.001');
    await error(
      await t.f.get('/api/v1/me', a.credential),
      401,
      'unauthenticated',
    );
    await ended();
    await t.f.state.set('auth.sessionIdleDays', '0');
    assertEquals(await seed(a, 2), false);
    a = await login();
    await seed(a);
    await t.changed();
    t.clear();
    const password = await t.f.json('/api/v1/me/password', 'PUT', {
      current: 'password-admin',
      new: 'password-reset',
    }, a.credential);
    assertEquals(password.status, 200);
    await password.body?.cancel();
    await ended();
    assertEquals(await seed(a, 2), false);
    assertEquals(t.ownSocket.frames, []);
  } finally {
    await t.close();
  }
});
