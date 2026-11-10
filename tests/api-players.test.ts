import { assert, assertEquals } from '@std/assert';
import { apiFixture, error } from './helpers/api.ts';
import { restored } from './helpers/prepared.ts';
import { openStore } from '../src/store/index.ts';
import { seedFirstUser } from '../src/users.ts';
import { createLibraries } from '../src/libraries.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibrary } from '../src/library.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createPlayers } from '../src/players.ts';
import { createPlaybackReports } from '../src/playback-reports.ts';
import { createPersistence } from '../src/persistence.ts';
import { createOutputs } from '../src/player.ts';
import { outputPlayerId } from '../src/player-outputs.ts';
import { createSpeakers } from '../src/speakers.ts';
import { createPlaybackCapacity } from '../src/playback-capacity.ts';
import { PlaybackError } from '../src/playback-errors.ts';
import { createQueueResolver } from '../src/queue-source.ts';
import { createUserService } from '../src/user.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';

async function setup() {
  const dir = await restored('api-players', async (dir) => {
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
  }, 'melofon-api-players-');
  let players!: Awaited<ReturnType<typeof createPlayers>>;
  let reports!: ReturnType<typeof createPlaybackReports>;
  let outputs!: ReturnType<typeof createOutputs>;
  let persistence!: ReturnType<typeof createPersistence>;
  const f = await apiFixture({
    storeDir: dir,
    allLayers: true,
    services: async (f) => {
      const library = createLibrary(f.store);
      const nowPlaying = createNowPlaying(f.store);
      persistence = createPersistence(f.store);
      outputs = createOutputs({ notify: f.notify, persistence });
      const speakers = createSpeakers({
        outputs,
        adapterView: () => ({
          preparation: { state: 'unresolved', targetRevision: 1 },
        }),
        prepare: () => Promise.resolve(true),
      });
      reports = createPlaybackReports({
        nowPlaying,
        library,
        notify: f.notify,
        serverRows: () => players.serverRows(),
      });
      players = await createPlayers({
        store: f.store,
        persistence,
        outputs,
        reports,
        notify: f.notify!,
        clock: { monotonicNow: () => 0 },
        maxResumeAgeMs: 300000,
        capacity: createPlaybackCapacity({
          protocol: 'AirPlay',
          busy: (owner) =>
            new PlaybackError(
              'airplay_busy',
              `AirPlay is busy in ${owner.name}`,
              owner,
            ),
        }),
        playback: {
          library,
          nowPlaying,
          cfg: {},
          resolveQueueReference: createQueueResolver({
            getSong: library.getSong,
            getStation: () => Promise.resolve(null),
          }),
        },
        targets: (id) => ({
          hasPlaybackTarget: () => speakers.hasPlaybackTarget(id),
          preparePlayback: (signal) => speakers.preparePlayback(signal, id),
        }),
      });
      return {
        players,
        speakers,
        library,
        playback: players.playback,
        user: createUserService(f.store, f.cfg),
        annotation: createAnnotation(f.store),
        listens: createListens(f.store),
      };
    },
  });
  await f.auth.users.create(f.admin.id, {
    username: 'member',
    password: 'password-member',
    role: 'user',
  });
  const songs = await createLibrary(f.store).listSongs({ offset: 0, size: 2 });
  const addSpeaker = async (id: string, type = 'Test', adopted = true) => {
    outputs.register({
      id,
      name: `Speaker ${id}`,
      type,
      selected: false,
      volume: 42,
    });
    if (adopted) await outputs.adopt(id);
  };
  const read = async (path: string, credential: string) => {
    const response = await f.get(path, credential, {
      Origin: 'http://other.home',
    });
    assertEquals(response.status, 200, await response.clone().text());
    assertEquals(response.headers.get('cache-control'), 'no-store');
    return await response.json();
  };
  const command = async (
    path: string,
    method: string,
    credential: string,
    body?: unknown,
    status = 204,
  ) => {
    const response = await f.json(path, method, body, credential);
    assertEquals(response.status, status, await response.clone().text());
    return status === 204
      ? (await response.body?.cancel(), undefined)
      : response.json();
  };
  return {
    f,
    dir,
    players,
    outputs,
    songs,
    addSpeaker,
    read,
    command,
    async close() {
      await players.close();
      await reports.close();
      await persistence.drain();
      await f.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('players HTTP lifecycle is shared by cookie and Bearer users on non-loopback plain HTTP', async () => {
  const t = await setup();
  try {
    assert(
      (await Deno.resolveDns('melofon.home', 'A')).every((ip) =>
        !ip.startsWith('127.')
      ),
    );
    for (const mode of ['cookie', 'bearer'] as const) {
      const { credential } = await t.f.login(mode, 'member', 'password-member');
      const base = mode === 'cookie'
        ? '/api/v1/players'
        : '/_melofon/api/v1/players';
      assertEquals(await t.read(base, credential), {
        players: [{ id: 1, name: 'Home', isDefault: true }],
      });
      const created = await t.command(base, 'POST', credential, {
        name: ' Kitchen ',
      }, 201);
      const id = created.player.id;
      assertEquals(created, {
        player: { id, name: 'Kitchen', isDefault: false },
      });
      const initial = (await t.read(`${base}/${id}`, credential)).player;
      assertEquals(initial.state, 'stop');
      assertEquals(initial.current, null);
      assertEquals(initial.speakers, []);
      const renamed = await t.command(`${base}/${id}`, 'PATCH', credential, {
        name: 'Study',
      }, 200);
      assertEquals(renamed.player.name, 'Study');
      await error(
        await t.f.json(`${base}/${id}`, 'PATCH', { name: 'HOME' }, credential),
        409,
        'name_conflict',
      );
      await t.command(`${base}/${id}/default`, 'POST', credential, {});
      assertEquals(
        (await t.read(`${base}/${id}`, credential)).player.isDefault,
        true,
      );
      assertEquals(
        (await t.f.store.players.list()).find((r) => r.id === id)?.isDefault,
        true,
      );
      await error(
        await t.f.json(`${base}/${id}`, 'DELETE', undefined, credential),
        409,
        'default_player',
      );
      await t.command(`${base}/1/default`, 'POST', credential, {});
      await t.command(`${base}/${id}`, 'DELETE', credential);
      await error(await t.f.get(`${base}/${id}`, credential), 404, 'not_found');
      assertEquals((await t.f.store.players.list()).length, 1);
    }
  } finally {
    await t.close();
  }
});

Deno.test('players HTTP rejects unauthenticated, cross-origin, malformed and conflicting changes without mutation', async () => {
  const t = await setup();
  try {
    const base = '/api/v1/players';
    await error(await t.f.get(base), 401, 'unauthenticated');
    await error(await t.f.get(`${base}/1`), 401, 'unauthenticated');
    await error(
      await t.f.json(base, 'POST', { name: 'Denied' }),
      401,
      'unauthenticated',
    );
    for (const mode of ['cookie', 'bearer'] as const) {
      const { credential } = await t.f.login(mode, 'member', 'password-member');
      await error(
        await t.f.json(
          base,
          'POST',
          { name: 'Denied' },
          credential,
          'http://other.home',
        ),
        403,
        'origin',
      );
      await error(
        await t.f.json(base, 'POST', { name: 'home' }, credential),
        409,
        'name_conflict',
      );
      await error(
        await t.f.json(base, 'POST', { name: ' ' }, credential),
        400,
        'invalid_name',
      );
      await error(
        await t.f.json(base, 'POST', { name: 3 }, credential),
        400,
        'invalid_field',
      );
      await error(
        await t.f.json(base, 'POST', { name: 'OK', extra: true }, credential),
        400,
        'unknown_field',
      );
      await error(
        await t.f.json(`${base}/1`, 'PATCH', {}, credential),
        400,
        'invalid_field',
      );
      await error(
        await t.f.json(`${base}/1`, 'DELETE', undefined, credential),
        409,
        'last_player',
      );
      for (const id of ['0', '-1', '01', '1e0', '9007199254740992', '999']) {
        await error(
          await t.f.get(`${base}/${id}`, credential),
          404,
          'not_found',
        );
      }
      await error(
        await t.f.json(`${base}/999/default`, 'POST', {}, credential),
        404,
        'not_found',
      );
    }
    assertEquals(t.players.list().map((r) => r.name), ['Home']);
  } finally {
    await t.close();
  }
});

Deno.test('players HTTP moves and releases adopted and temporary speakers, retaining the old player bookmark', async () => {
  const t = await setup();
  try {
    const a = await t.f.login('cookie');
    const b = await t.f.login('bearer', 'member', 'password-member');
    const kitchen = await t.players.create('Kitchen');
    await t.addSpeaker('one');
    await t.addSpeaker('temporary', 'Test', false);
    const path = (id: number, speaker: string) =>
      `/api/v1/players/${id}/speakers/${speaker}`;
    await t.command(path(1, 'one'), 'PUT', a.credential, {});
    await t.players.get(1).queueAdd(t.songs, { play: true }, {
      kind: 'http',
      user: 'admin',
    });
    await t.players.get(1).seek({ positionMs: 100 });
    const queue = t.players.get(1).queueView();
    await t.command(path(kitchen.id, 'one'), 'PUT', b.credential, {});
    await t.command(path(kitchen.id, 'one'), 'PUT', b.credential, {});
    const home = (await t.read('/api/v1/players/1', a.credential)).player;
    assertEquals(home.state, 'pause');
    assertEquals(home.positionMs, 100);
    assertEquals(home.current.entryId, queue.items[0].id);
    assertEquals(home.current.commander, 'admin');
    assertEquals(t.players.get(1).queueView(), queue);
    let speaker = (await t.read('/api/v1/speakers/one', a.credential)).speaker;
    assertEquals(speaker.playerId, kitchen.id);
    assertEquals(speaker.linked, true);
    assertEquals(
      (await t.f.store.speakers.loadMemberships())[0].playerId,
      kitchen.id,
    );
    await t.command(path(1, 'one'), 'DELETE', a.credential);
    assertEquals(
      t.outputs.get('one')!.playerId,
      kitchen.id,
      'scoped leave never steals another member',
    );
    await t.command(path(kitchen.id, 'one'), 'DELETE', b.credential);
    await t.command(path(kitchen.id, 'one'), 'DELETE', b.credential);
    speaker = (await t.read('/api/v1/speakers/one', b.credential)).speaker;
    assertEquals(speaker.playerId, null);
    await t.command(path(kitchen.id, 'temporary'), 'PUT', b.credential, {});
    assertEquals(
      (await t.f.store.speakers.loadOutputs()).length,
      1,
      'temporary membership is not saved',
    );
    await t.command(`/api/v1/players/${kitchen.id}`, 'DELETE', b.credential);
    assertEquals(t.players.freeSpeakers().map((r) => r.id).sort(), [
      'one',
      'temporary',
    ]);
    await error(
      await t.f.json(path(1, 'missing'), 'PUT', {}, a.credential),
      404,
      'not_found',
    );
    await error(
      await t.f.json(path(999, 'one'), 'DELETE', undefined, a.credential),
      404,
      'not_found',
    );
  } finally {
    await t.close();
  }
});

Deno.test('players HTTP translates AirPlay membership refusal with the live owner id and name', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login(
      'bearer',
      'member',
      'password-member',
    );
    const kitchen = await t.players.create('Kitchen');
    await t.addSpeaker('air', 'AirPlay');
    await t.addSpeaker('free-air', 'AirPlay');
    await t.addSpeaker('other');
    await t.players.join(1, 'air');
    await t.players.join(kitchen.id, 'other');
    await t.players.get(1).queueAdd(t.songs, { play: true });
    await t.players.get(kitchen.id).queueAdd(t.songs, { play: true });
    await t.command('/api/v1/players/1', 'PATCH', credential, {
      name: 'Living room',
    }, 200);
    const response = await t.f.json(
      `/api/v1/players/${kitchen.id}/speakers/free-air`,
      'PUT',
      {},
      credential,
    );
    assertEquals(response.status, 409);
    const body = await response.json();
    assertEquals(body.code, 'airplay_busy');
    assertEquals(body.owner, { id: 1, name: 'Living room' });
    assertEquals(outputPlayerId(t.outputs.get('free-air')!), null);
    assertEquals(t.players.get(1).playerView().state, 'play');
    assertEquals(t.players.get(kitchen.id).playerView().state, 'play');
  } finally {
    await t.close();
  }
});

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert(Date.now() < deadline, 'players event timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

Deno.test('a second user socket sees lifecycle, keyed player queue modes volume and speaker invalidations', async () => {
  const t = await setup();
  let ws: WebSocket | undefined;
  try {
    const actor = await t.f.login('cookie');
    const observer = await t.f.login('bearer', 'member', 'password-member');
    const frames: { type: string; events?: Record<string, string[]> }[] = [];
    ws = new WebSocket(t.f.origin.replace('http:', 'ws:') + '/api/v1/events', {
      headers: {
        Authorization: `Bearer ${observer.credential}`,
        Origin: t.f.origin,
      },
    });
    ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
    await waitFor(() => frames.some((f) => f.type === 'hello'));
    const changed = async (name: string, id?: string) => {
      await waitFor(() =>
        frames.some((f) =>
          f.events?.[name] && (id === undefined || f.events[name].includes(id))
        )
      );
      frames.length = 0;
    };
    const { player } = await t.command(
      '/api/v1/players',
      'POST',
      actor.credential,
      { name: 'Kitchen' },
      201,
    );
    await changed('players', String(player.id));
    await t.addSpeaker('speaker');
    await t.command(
      `/api/v1/players/${player.id}/speakers/speaker`,
      'PUT',
      actor.credential,
      {},
    );
    await changed('speakers');
    const playback = t.players.get(player.id);
    await playback.queueAdd(t.songs, { play: true });
    await waitFor(() =>
      ['player', 'queue'].every((name) =>
        frames.some((f) => f.events?.[name]?.includes(String(player.id)))
      )
    );
    frames.length = 0;
    playback.setRepeat('all');
    await changed('options', String(player.id));
    playback.setVolume({ volume: 30 });
    await changed('volume', String(player.id));
    await t.command(`/api/v1/players/${player.id}`, 'PATCH', actor.credential, {
      name: 'Study',
    }, 200);
    await waitFor(() => frames.some((f) => f.events?.nowPlaying));
    await changed('players', String(player.id));
    assertEquals(
      (await t.read(`/api/v1/players/${player.id}`, observer.credential)).player
        .name,
      'Study',
    );
    await t.command(
      `/api/v1/players/${player.id}/default`,
      'POST',
      actor.credential,
      {},
    );
    await waitFor(() =>
      ['players', 'player', 'queue', 'volume', 'options'].every((name) =>
        frames.some((f) => f.events?.[name]?.includes(String(player.id)))
      )
    );
    frames.length = 0;
    await t.command('/api/v1/players/1/default', 'POST', actor.credential, {});
    await changed('players', '1');
    await t.command(`/api/v1/players/${player.id}`, 'DELETE', actor.credential);
    await changed('players', String(player.id));
    await error(
      await t.f.get(`/api/v1/players/${player.id}`, observer.credential),
      404,
      'not_found',
    );
  } finally {
    if (ws && ws.readyState < WebSocket.CLOSING) ws.close();
    if (ws) await waitFor(() => ws!.readyState === WebSocket.CLOSED);
    await t.close();
  }
});

Deno.test('household HTTP identifies each server player while OpenSubsonic retains its shape and disjoint integer ids', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login(
      'cookie',
      'member',
      'password-member',
    );
    const kitchen = await t.players.create('Kitchen');
    for (const id of [1, kitchen.id]) {
      await t.addSpeaker(`speaker-${id}`);
      await t.players.join(id, `speaker-${id}`);
      await t.players.get(id).queueAdd([t.songs[id === 1 ? 0 : 1]], {
        play: true,
      }, { kind: 'http', user: 'member', peer: 'private-peer' });
    }
    await t.players.playback.reportPlayback({
      username: 'member',
      client: 'Phone',
      trackId: t.songs[0].id,
      state: 'playing',
      positionMs: 0,
      playbackRate: 1,
      source: 'melofon',
      ignoreScrobble: true,
    });
    const before = await t.read('/api/v1/now-playing', credential);
    const rows = before.nowPlaying;
    assertEquals(
      rows.filter((r: { kind: string }) => r.kind === 'server').map((
        r: { playerId: number; playerName: string },
      ) => [r.playerId, r.playerName]),
      [[1, 'Home'], [kitchen.id, 'Kitchen']],
    );
    const app = rows.find((r: { kind: string }) => r.kind === 'app');
    assert(app.appPlayerId > 0);
    for (
      const privateValue of [
        t.dir,
        'private-peer',
        ...t.songs.map((s) => s.path),
      ]
    ) assert(!JSON.stringify(before).includes(privateValue));
    await t.command(`/api/v1/players/${kitchen.id}`, 'PATCH', credential, {
      name: 'Study',
    }, 200);
    assertEquals(
      (await t.read('/api/v1/now-playing', credential)).nowPlaying[1]
        .playerName,
      'Study',
    );
    const response = await t.f.get(
      '/rest/getNowPlaying?' +
        new URLSearchParams({
          u: 'admin',
          p: 'password-admin',
          c: 'Test',
          v: '1.16.1',
          f: 'json',
        }),
    );
    const body = (await response.json())['subsonic-response'];
    assertEquals(body.status, 'ok');
    const entries = body.nowPlaying.entry;
    assertEquals(entries.map((r: { playerId: number }) => r.playerId), [
      0,
      1 - kitchen.id,
      app.appPlayerId,
    ]);
    assertEquals(entries.map((r: { playerName: string }) => r.playerName), [
      'Home',
      'Study',
      'Phone',
    ]);
    for (const entry of entries) {
      assertEquals(typeof entry.id, 'string');
      assertEquals(typeof entry.username, 'string');
      assertEquals(typeof entry.minutesAgo, 'number');
      assert(!('serverPlayerId' in entry));
      assert(!('speakers' in entry));
      assert(!('commander' in entry));
      assert(!('kind' in entry));
    }
  } finally {
    await t.close();
  }
});
