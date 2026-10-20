import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { seedFirstUser } from '../src/users.ts';
import { createLibraries } from '../src/libraries.ts';
import { scanLibrary } from '../src/scan.ts';
import { createUserService } from '../src/user.ts';
import { createLibrary } from '../src/library.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createPlayer } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';
import { createState } from '../src/state.ts';
import { createStream } from '../src/stream.ts';
import { createMedia } from '../src/media.ts';
import { loadLayers } from '../src/layers.ts';
import { facade } from '../src/facade.ts';

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-playback-report-' });
  let store = await openStore(dir);
  const cfg = {
    listen: undefined,
    dataDir: dir,
    user: 'admin',
    password: 'test',
    secret: 'g2-secret',
    version: 'test',
  };
  await seedFirstUser(store, cfg);
  await createLibraries(store).add('Music', 'tests/fixtures/library');
  await scanLibrary(store);
  let clock = Date.now();
  let state = createState(store);
  let player = createPlayer();
  let lookupBarrier: Promise<void> | undefined;
  let releaseLookup: (() => void) | undefined;
  let pendingLookup:
    | ReturnType<ReturnType<typeof createLibrary>['getSong']>
    | undefined;
  const router = async () => {
    const library = createLibrary(store);
    const listens = createListens(store);
    const nowPlaying = createNowPlaying(store, {
      state,
      listens,
      now: () => clock,
    });
    const playback = createPlayback({
      player,
      library: {
        ...library,
        getSong(id) {
          pendingLookup = (async () => {
            await lookupBarrier;
            return library.getSong(id);
          })();
          return pendingLookup;
        },
      },
      nowPlaying,
      cfg,
    });
    const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
    return facade(
      core,
      await loadLayers({
        app: {
          cfg,
          state,
          library,
          annotation: createAnnotation(store),
          listens,
          playback,
          stream: createStream(createMedia(), playback, cfg),
          user: createUserService(store, cfg),
        },
      }),
    );
  };
  let app = await router();
  async function call(
    op: string,
    extra: Record<string, string> = {},
    method = 'GET',
    client = 'g2-phone',
    user = 'admin',
  ) {
    const params = new URLSearchParams({
      u: user,
      p: 'test',
      v: '1.16.1',
      c: client,
      f: 'json',
      ...extra,
    });
    const response = await app(
      new Request(
        `http://x/rest/${op}.view${method === 'GET' ? `?${params}` : ''}`,
        method === 'POST' ? { method, body: params } : { method },
      ),
    );
    assertEquals(response.status, 200);
    return (await response.json())['subsonic-response'];
  }
  const songs = (await call('search3', { query: '' })).searchResult3.song as {
    id: string;
  }[];
  const song = (await createLibrary(store).getSong(songs[0].id))!;
  assert(song.durationMs !== null && song.durationMs > 0);
  return {
    song,
    other: songs[1].id,
    call,
    get store() {
      return store;
    },
    get state() {
      return state;
    },
    get player() {
      return player;
    },
    get clock() {
      return clock;
    },
    advance(ms: number) {
      clock += ms;
    },
    holdPlaybackLookup() {
      lookupBarrier = new Promise<void>((resolve) => {
        releaseLookup = resolve;
      });
      pendingLookup = undefined;
    },
    async releasePlaybackLookup() {
      releaseLookup?.();
      await pendingLookup;
      lookupBarrier = undefined;
    },
    async report(
      playState: string,
      positionMs = 0,
      extra: Record<string, string> = {},
      client = 'g2-phone',
      method = 'GET',
    ) {
      const response = await call(
        'reportPlayback',
        {
          mediaId: song.id,
          mediaType: 'song',
          positionMs: String(positionMs),
          state: playState,
          ...extra,
        },
        method,
        client,
      );
      assertEquals(response.status, 'ok');
      return response;
    },
    async entries() {
      return (await call('getNowPlaying')).nowPlaying.entry;
    },
    async count(id = song.id) {
      const wire = (await call('getSong', { id })).song.playCount;
      const count =
        (await createListens(store).facts('admin', { songs: [id] })).songs[id]
          .playCount;
      assertEquals(wire, count > 0 ? count : undefined);
      return count;
    },
    async reopen() {
      await store.close();
      store = await openStore(dir);
      state = createState(store);
      player = createPlayer();
      app = await router();
    },
    async xml() {
      const response = await app(
        new Request(
          'http://x/rest/getNowPlaying?u=admin&p=test&v=1.16.1&c=g2-phone',
        ),
      );
      return response.text();
    },
    async stream() {
      const controller = new AbortController();
      const response = await app(
        new Request(
          `http://x/rest/stream?u=admin&p=test&v=1.16.1&c=g2-phone&id=${song.id}&format=raw`,
          { signal: controller.signal },
        ),
      );
      assertEquals(response.status, 200);
      assert((await response.arrayBuffer()).byteLength > 0);
      return controller;
    },
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('G2 HTTP lifecycle advances only playing, caps duration and counts one stopped listen', async () => {
  const t = await setup();
  try {
    const duration = t.song.durationMs!;
    await t.report('starting');
    const id = (await t.entries())[0].playerId;
    t.advance(100);
    assertEquals((await t.entries())[0].positionMs, 0);
    await t.report('playing', 0, { playbackRate: '1.5' });
    t.advance(100);
    assertEquals((await t.entries())[0].positionMs, Math.min(150, duration));
    await t.report('paused', 150);
    t.advance(100);
    assertEquals((await t.entries())[0].positionMs, Math.min(150, duration));
    assertEquals((await t.entries())[0].state, 'paused');
    await t.report('playing', Math.ceil(duration / 2), {}, 'g2-phone', 'POST');
    t.advance(duration);
    assertEquals((await t.entries())[0].positionMs, duration);
    assertEquals((await t.entries())[0].playerId, id);
    assertEquals(await t.count(), 0, 'calculated end alone never counts');
    const xml = await t.xml();
    assert(xml.includes('state="playing"'));
    assert(xml.includes(`positionMs="${duration}"`));
    assert(xml.includes('playbackRate="1"'));
    await Promise.all([
      t.report('stopped', duration),
      t.report('stopped', duration),
    ]);
    assertEquals(await t.count(), 1);
    assertEquals(await t.entries(), []);
    const listens = await rawSql(t.store).all(
      'SELECT source, duration_ms FROM listens',
    );
    assertEquals(listens, [{ source: 'opensubsonic', duration_ms: duration }]);
  } finally {
    await t.close();
  }
});

Deno.test('G2 below-threshold and ignoreScrobble stops do not count; starting resets same-song state', async () => {
  const t = await setup();
  try {
    const half = Math.ceil(t.song.durationMs! / 2);
    await t.report('playing', half);
    const before = await rawSql(t.store).all<{ started: number }>(
      'SELECT epoch_ms(started_at) AS started FROM now_playing',
    );
    t.advance(100);
    await t.report('starting');
    const after = await rawSql(t.store).all<{ started: number }>(
      'SELECT epoch_ms(started_at) AS started FROM now_playing',
    );
    assertEquals(Number(after[0].started) - Number(before[0].started), 100);
    t.advance(100);
    assertEquals((await t.entries())[0].positionMs, 0);
    await t.report('stopped', half - 1);
    assertEquals(await t.count(), 0);
    await t.report('playing');
    await t.report('stopped', half, { ignoreScrobble: 'true' });
    assertEquals(await t.count(), 0);
    assertEquals(await t.entries(), []);
  } finally {
    await t.close();
  }
});

Deno.test('G2 different-song late stop is ignored, player identities survive reports stops and restart', async () => {
  const t = await setup();
  try {
    await t.report('playing');
    const phone = (await t.entries())[0].playerId;
    assert(Number.isInteger(phone) && phone > 0);
    t.advance(1);
    await t.report('paused', 12, { mediaId: t.other });
    await t.report('stopped', t.song.durationMs!);
    let rows = await t.entries();
    assertEquals(rows.length, 1);
    assertEquals(rows[0].id, t.other);
    assertEquals(rows[0].playerId, phone);
    assertEquals(await t.count(), 0);
    t.advance(1);
    await t.report('playing', 0, {}, 'g2-desktop');
    rows = await t.entries();
    assertEquals(rows.map((r: { playerName: string }) => r.playerName), [
      'g2-desktop',
      'g2-phone',
    ]);
    const desktop = rows[0].playerId;
    assert(desktop !== phone);
    await t.reopen();
    assertEquals(
      (await t.entries()).map((r: { playerId: number }) => r.playerId),
      [desktop, phone],
    );
    await t.report('stopped', 0, {}, 'g2-desktop');
    await t.report('starting', 0, {}, 'g2-desktop');
    assertEquals((await t.entries())[0].playerId, desktop);
    await rawSql(t.store).run(
      `INSERT INTO users (id, name, password_enc, created_at, role)
      SELECT 'g2-other-user', 'bob', password_enc, now(), 'user' FROM users WHERE name = 'admin'`,
    );
    t.advance(1);
    assertEquals(
      (await t.call(
        'reportPlayback',
        {
          mediaId: t.song.id,
          mediaType: 'song',
          positionMs: '0',
          state: 'starting',
        },
        'POST',
        'g2-phone',
        'bob',
      )).status,
      'ok',
    );
    const allUsers = await t.entries();
    assertEquals(allUsers[0].username, 'bob');
    assert(allUsers[0].playerId !== phone);
    assertEquals(allUsers.length, 3);
    t.player.queueAdd([t.song]);
    t.player.pause();
    // Engine state is independent and remains the first, reserved player zero.
    t.player.play();
    t.player.pause();
    assertEquals((await t.entries())[0].playerId, 0);
    assertEquals((await t.entries())[0].state, 'paused');
  } finally {
    await t.close();
  }
});

Deno.test('G2 playing and starting expire at planned end plus grace, never count or revive on reopen', async () => {
  const t = await setup();
  try {
    for (const state of ['starting', 'playing']) {
      await t.report(state, 0, { playbackRate: '2' });
      const remaining = t.song.durationMs! / 2 + 30 * 60000;
      t.advance(remaining - 1);
      assertEquals((await t.entries()).length, 1);
      t.advance(1);
      // First read after restart must enforce the original deadline too.
      await t.reopen();
      assertEquals(await t.entries(), []);
      assertEquals(await rawSql(t.store).all('SELECT * FROM now_playing'), []);
      await t.report('stopped', t.song.durationMs!);
      assertEquals(await t.count(), 0);
      await t.reopen();
      assertEquals(await t.entries(), []);
    }
  } finally {
    await t.close();
  }
});

Deno.test('G2 paused expiry uses last report and live owner settings, no listen at expiry', async () => {
  const t = await setup();
  try {
    assertEquals(await t.state.getTyped('playback.sessionGraceMinutes'), 30);
    assertEquals(await t.state.getTyped('playback.pausedSessionMinutes'), 30);
    await t.state.set('playback.pausedSessionMinutes', '1');
    await t.report('paused', Math.ceil(t.song.durationMs! / 2));
    t.advance(59999);
    assertEquals((await t.entries()).length, 1);
    t.advance(1);
    assertEquals(await t.entries(), []);
    assertEquals(await t.count(), 0);
    await t.state.set('playback.sessionGraceMinutes', '0');
    await t.report('playing', t.song.durationMs!);
    assertEquals(await t.entries(), []);
    await t.reopen();
    assertEquals(await t.entries(), []);
  } finally {
    await t.close();
  }
});

Deno.test('G2 HTTP parameter errors preserve session and discovery advertises playbackReport v1', async () => {
  const t = await setup();
  try {
    const valid = {
      mediaId: t.song.id,
      mediaType: 'song',
      positionMs: '0',
      state: 'starting',
    };
    await t.report('starting');
    for (const method of ['GET', 'POST']) {
      for (const key of Object.keys(valid)) {
        for (const empty of [false, true]) {
          const params: Record<string, string> = { ...valid };
          if (empty) params[key] = '';
          else delete params[key];
          assertEquals(
            (await t.call('reportPlayback', params, method)).error.code,
            10,
          );
        }
      }
      for (
        const [extra, code] of [
          [{ positionMs: '-1' }, 0],
          [{ positionMs: '0.5' }, 10],
          [{ positionMs: '1e-1000' }, 10],
          [{ positionMs: '9007199254740992' }, 10],
          [{ positionMs: 'Infinity' }, 10],
          [{ positionMs: 'NaN' }, 10],
          [{ positionMs: 'abc' }, 10],
          [{ positionMs: ' ' }, 10],
          [{ state: 'buffering' }, 0],
          [{ playbackRate: '0' }, 0],
          [{ playbackRate: '-1' }, 0],
          [{ playbackRate: 'NaN' }, 0],
          [{ playbackRate: 'Infinity' }, 0],
          [{ playbackRate: '1e999' }, 0],
          [{ playbackRate: '' }, 10],
          [{ playbackRate: 'abc' }, 10],
          [{ mediaType: 'podcast' }, 70],
          [{ mediaId: 'unknown' }, 70],
        ] as [Record<string, string>, number][]
      ) {
        const response = await t.call(
          'reportPlayback',
          { ...valid, ...extra },
          method,
        );
        assertEquals(response.status, 'failed', JSON.stringify(extra));
        assertEquals(response.error.code, code, JSON.stringify(extra));
      }
    }
    assertEquals((await t.entries())[0].state, 'starting');
    assertEquals(await t.count(), 0);
    const extensions =
      (await t.call('getOpenSubsonicExtensions')).openSubsonicExtensions;
    assertEquals(
      extensions.filter((c: { name: string }) => c.name === 'playbackReport'),
      [{ name: 'playbackReport', versions: [1] }],
    );
  } finally {
    await t.close();
  }
});

Deno.test('G2 scrobble notification and stream-style open/abort share expiring sessions without listens', async () => {
  const t = await setup();
  try {
    await t.call('scrobble', {
      id: t.song.id,
      submission: 'false',
      position: '0.25',
    });
    const first = (await t.entries())[0];
    assertEquals(first.state, 'playing');
    assertEquals(first.playbackRate, 1);
    assertEquals(first.positionMs, Math.min(250, t.song.durationMs!));
    t.advance(t.song.durationMs! + 30 * 60000);
    assertEquals(await t.entries(), []);
    assertEquals(await t.count(), 0);
    await t.call('scrobble', { id: t.song.id, submission: 'true' });
    assertEquals(await t.count(), 1);
    assertEquals(await t.entries(), []);
    const firstStream = await t.stream();
    const playerId = (await t.entries())[0].playerId;
    const newerStream = await t.stream();
    firstStream.abort();
    assertEquals((await t.entries())[0].playerId, playerId);
    newerStream.abort();
    assertEquals(await t.entries(), []);
    // An abort must not overtake a fire-and-forget stream-open report while
    // unrelated catalog work is delayed. No waits: hold/release the dependency.
    t.holdPlaybackLookup();
    const abortedStream = await t.stream();
    abortedStream.abort();
    await t.releasePlaybackLookup();
    assertEquals(await t.entries(), []);
    await t.stream();
    assertEquals((await t.entries()).length, 1);
    t.advance(t.song.durationMs! + 30 * 60000);
    assertEquals(await t.entries(), []);
    assertEquals(
      await t.count(),
      1,
      'stream expiry/abort never creates a listen',
    );
  } finally {
    await t.close();
  }
});

Deno.test('G2 production pre-report schema migrates timestamps positions and stable identities', async () => {
  const t = await setup();
  try {
    const user = (await rawSql(t.store).all<{ id: string }>(
      "SELECT id FROM users WHERE name = 'admin'",
    ))[0].id;
    await rawSql(t.store).run('DROP TABLE now_playing');
    await rawSql(t.store).run(`CREATE TABLE now_playing (
      user_id VARCHAR NOT NULL, client VARCHAR NOT NULL, track_id VARCHAR NOT NULL,
      position_ms BIGINT, started_at TIMESTAMPTZ NOT NULL, stream_id VARCHAR,
      PRIMARY KEY (user_id, client))`);
    await rawSql(t.store).run(`INSERT INTO now_playing VALUES
      ('${user}', 'g2-phone', '${t.song.id}', 10, epoch_ms(${t.clock}::BIGINT), 'old-stream'),
      ('${user}', 'stale', '${t.song.id}', NULL, '2000-01-01T00:00:00Z', NULL)`);
    await t.reopen();
    const rows = await t.entries();
    assertEquals(rows.length, 1);
    assertEquals(rows[0].positionMs, Math.min(10, t.song.durationMs!));
    assertEquals(rows[0].state, 'playing');
    assertEquals(rows[0].playbackRate, 1);
    const playerId = rows[0].playerId;
    assert(playerId > 0);
    await t.reopen();
    assertEquals((await t.entries())[0].playerId, playerId);
    assertEquals(await t.count(), 0);
    assertEquals(
      (await rawSql(t.store).all('SELECT * FROM now_playing')).length,
      1,
    );
  } finally {
    await t.close();
  }
});
