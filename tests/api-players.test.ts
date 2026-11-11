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
            getStation: f.store.radio.get,
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
    persistence,
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

Deno.test('queue HTTP pages whole and upcoming snapshots across edits with independent player versions', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login(
      'cookie',
      'member',
      'password-member',
    );
    const path = '/api/v1/players/1';
    const kitchen = await t.players.create('Kitchen');
    const other = t.players.get(kitchen.id);
    await other.queueAdd([t.songs[1]]);
    const otherBefore = await t.read(
      `/api/v1/players/${kitchen.id}/queue`,
      credential,
    );
    const home = t.players.get(1);
    const entries = await home.queueAdd([
      t.songs[0],
      t.songs[1],
      t.songs[0],
      t.songs[1],
    ]);
    const ids = entries.map((entry) => entry.id);
    assertEquals(new Set(ids).size, 4);
    assert(!ids.includes(otherBefore.items[0].entryId));
    const page1 = await t.read(`${path}/queue?view=all&limit=2`, credential);
    assertEquals([
      page1.view,
      page1.startIndex,
      page1.total,
      page1.offset,
      page1.limit,
      page1.currentEntryId,
    ], ['all', 0, 4, 0, 2, null]);
    assertEquals(
      page1.items.map((item: { entryId: number }) => item.entryId),
      ids.slice(0, 2),
    );
    assertEquals(
      page1.items.map((item: { position: number }) => item.position),
      [0, 1],
    );
    assertEquals(page1.items[0].reference, { kind: 'song', id: t.songs[0].id });
    assertEquals(page1.items[0].song.id, t.songs[0].id);
    const page2 = await t.read(
      `${path}/queue?view=all&offset=2&limit=2`,
      credential,
    );
    assertEquals(page2.version, page1.version);
    assertEquals(
      page2.items.map((item: { entryId: number }) => item.entryId),
      ids.slice(2),
    );
    assertEquals(
      (await t.read(path, credential)).player.queueVersion,
      page1.version,
    );
    const added = await home.queueAdd([t.songs[0]], { position: 1 });
    const edited = await t.read(
      `${path}/queue?view=all&offset=2&limit=2`,
      credential,
    );
    assert(edited.version > page1.version);
    assertEquals(edited.total, 5);
    assertEquals(
      edited.items.map((item: { entryId: number }) => item.entryId),
      ids.slice(1, 3),
    );
    assertEquals(
      (await t.read(path, credential)).player.queueVersion,
      edited.version,
    );
    assertEquals(
      await t.read(`/api/v1/players/${kitchen.id}/queue`, credential),
      otherBefore,
    );
    const all = await t.read(`${path}/queue?view=all`, credential);
    assertEquals(all.items.map((item: { entryId: number }) => item.entryId), [
      ids[0],
      added[0].id,
      ...ids.slice(1),
    ]);
    for (const offset of [5, 999, 9007199254740991]) {
      const beyond = await t.read(`${path}/queue?offset=${offset}`, credential);
      assertEquals([beyond.total, beyond.items, beyond.version], [
        5,
        [],
        edited.version,
      ]);
    }
    await t.persistence.drain();
    assertEquals(
      (await t.f.store.playback.loadQueue(1)).version,
      edited.version,
    );
  } finally {
    await t.close();
  }
});

Deno.test('queue HTTP up next includes current across navigation pause stop exhaustion and clear', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login(
      'bearer',
      'member',
      'password-member',
    );
    const path = '/_melofon/api/v1/players/1';
    const empty = await t.read(`${path}/queue`, credential);
    assertEquals([
      empty.view,
      empty.total,
      empty.startIndex,
      empty.currentEntryId,
      empty.items,
    ], ['upNext', 0, 0, null, []]);
    const home = t.players.get(1);
    const entries = await home.queueAdd([t.songs[0], t.songs[1], t.songs[0]]);
    await t.addSpeaker('queue');
    await t.players.join(1, 'queue');
    await t.command(`${path}/play`, 'POST', credential, {});
    const first = await t.read(`${path}/queue?limit=1`, credential);
    assertEquals(first.items[0].entryId, entries[0].id);
    await t.command(`${path}/next`, 'POST', credential, {});
    const next = await t.read(`${path}/queue?limit=1`, credential);
    assertEquals([
      next.version,
      next.currentEntryId,
      next.startIndex,
      next.total,
    ], [first.version, entries[1].id, 1, 2]);
    assertEquals(next.items[0].entryId, entries[1].id);
    const page2 = await t.read(`${path}/queue?offset=1&limit=1`, credential);
    assertEquals([page2.items[0].entryId, page2.items[0].position], [
      entries[2].id,
      2,
    ]);
    const all = await t.read(`${path}/queue?view=all`, credential);
    assertEquals([all.total, all.startIndex, all.currentEntryId], [
      3,
      0,
      entries[1].id,
    ]);
    for (const command of ['pause', 'stop', 'restart']) {
      await t.command(`${path}/${command}`, 'POST', credential, {});
      assertEquals(await t.read(`${path}/queue?limit=1`, credential), next);
    }
    await t.command(
      path,
      'PATCH',
      credential,
      { repeat: 'all', consume: true },
      200,
    );
    assertEquals(
      (await t.read(`${path}/queue`, credential)).version,
      first.version,
    );
    await t.command(`${path}/next`, 'POST', credential, {});
    await t.command(`${path}/next`, 'POST', credential, {});
    const exhausted = await t.read(`${path}/queue`, credential);
    assertEquals([
      exhausted.total,
      exhausted.startIndex,
      exhausted.currentEntryId,
    ], [3, 0, null]);
    assertEquals(exhausted.version, first.version);
    home.queueClear();
    const cleared = await t.read(`${path}/queue`, credential);
    assertEquals([cleared.total, cleared.items, cleared.currentEntryId], [
      0,
      [],
      null,
    ]);
    assert(cleared.version > exhausted.version);
    assertEquals(
      (await t.read(path, credential)).player.queueVersion,
      cleared.version,
    );
  } finally {
    await t.close();
  }
});

Deno.test('queue HTTP encodes original web references and refreshed facts without private source details', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login(
      'cookie',
      'member',
      'password-member',
    );
    const path = '/api/v1/players/1';
    const home = t.players.get(1);
    const facts = {
      kind: 'web' as const,
      url: 'http://private-source.home/resolved',
      title: 'Radio',
      artistName: null,
      durationMs: null,
      mode: 'live' as const,
      seekable: false,
      streamTitle: 'On air',
      streamUrl: 'http://private-source.home/metadata',
    };
    const station = await t.f.store.radio.create({
      name: 'Radio',
      streamUrl: facts.url,
      homePageUrl: null,
    });
    const entries = await home.queueAddSources([
      { reference: { kind: 'station', id: station.id }, facts },
      { reference: { kind: 'url', url: 'http://entered.home/radio' }, facts },
    ]);
    await t.addSpeaker('radio');
    await t.players.join(1, 'radio');
    const before = await t.read(`${path}/queue`, credential);
    assertEquals(
      before.items.map((item: { reference: unknown }) => item.reference),
      [
        { kind: 'station', id: station.id },
        { kind: 'url', url: 'http://entered.home/radio' },
      ],
    );
    assertEquals(before.items[0].media, {
      kind: 'web',
      title: 'Radio',
      artistName: null,
      durationMs: null,
      mode: 'live',
      seekable: false,
      streamTitle: 'On air',
    });
    assert(!JSON.stringify(before).includes('private-source'));
    assert(!JSON.stringify(before).includes('path'));
    await t.command(`${path}/play`, 'POST', credential, {});
    const activated = await t.read(`${path}/queue`, credential);
    const status = home.playerView();
    const token = home.openSource(entries[0].id, status.generation)!;
    assert(token);
    assert(home.reportSourceMetadata(token, { streamTitle: 'New title' }));
    const after = await t.read(`${path}/queue`, credential);
    assert(after.version > activated.version);
    assertEquals(after.items[0].entryId, entries[0].id);
    assertEquals(after.items[0].media.streamTitle, 'New title');
    assertEquals(
      (await t.read(path, credential)).player.queueVersion,
      after.version,
    );
    home.cancelSource(token);
  } finally {
    await t.close();
  }
});

Deno.test('queue HTTP validates paging and settings and requires auth but not Origin on reads', async () => {
  const t = await setup();
  try {
    await t.players.get(1).queueAdd([t.songs[0], t.songs[1], t.songs[0]]);
    await t.f.state.set('melofon.queueMaxPageRecords', '2');
    await t.f.state.set('melofon.queuePageRecords', '3');
    for (const mode of ['cookie', 'bearer'] as const) {
      const { credential } = await t.f.login(mode, 'member', 'password-member');
      const path = `${
        mode === 'cookie' ? '' : '/_melofon'
      }/api/v1/players/1/queue`;
      const page = await t.read(path, credential);
      assertEquals([page.limit, page.items.length, page.total], [2, 2, 3]);
      const read = await t.f.get(path, credential);
      assertEquals(read.status, 200);
      await read.body?.cancel();
      for (
        const query of [
          'view=bad',
          'view=',
          'view=all&view=upNext',
          'offset=-1',
          'offset=1.5',
          'offset=1e1',
          'offset=',
          'offset=9007199254740992',
          'offset=0&offset=1',
          'limit=0',
          'limit=-1',
          'limit=1.5',
          'limit=3',
          'limit=',
          'limit=1&limit=2',
          'unknown=1',
        ]
      ) {
        await error(
          await t.f.get(`${path}?${query}`, credential),
          400,
          'invalid_field',
        );
      }
      for (const id of ['0', '01', '-1', '1.5', '9007199254740992', '99999']) {
        await error(
          await t.f.get(`/api/v1/players/${id}/queue`, credential),
          404,
          'not_found',
        );
      }
    }
    await error(
      await t.f.get('/api/v1/players/1/queue'),
      401,
      'unauthenticated',
    );
  } finally {
    await t.close();
  }
});

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

Deno.test('player commands HTTP preserve per-player bookmarks, previous/restart semantics and authenticated provenance', async () => {
  const t = await setup();
  try {
    const kitchen = await t.players.create('Kitchen');
    for (const mode of ['cookie', 'bearer'] as const) {
      const { credential } = await t.f.login(mode, 'member', 'password-member');
      const base = mode === 'cookie' ? '/api/v1' : '/_melofon/api/v1';
      const id = mode === 'cookie' ? 1 : kitchen.id;
      const path = `${base}/players/${id}`;
      await t.addSpeaker(`speaker-${id}`);
      await t.players.join(id, `speaker-${id}`);
      const entries = await t.players.get(id).queueAdd(t.songs);
      const other = t.players.get(id === 1 ? kitchen.id : 1);
      const otherBefore = other.playerView();
      const otherCommand = other.lastCommand();
      const state = async () => (await t.read(path, credential)).player;
      const command = (name: string, body: unknown = {}) =>
        t.command(`${path}/${name}`, 'POST', credential, body);
      await command('play');
      assertEquals((await state()).state, 'play');
      assertEquals((await state()).current.entryId, entries[0].id);
      await command('seek', { positionMs: 100 });
      assertEquals((await state()).positionMs, 100);
      await command('seek', { seekMs: 25 });
      assertEquals((await state()).positionMs, 125);
      await command('seek', { seekMs: -50 });
      assertEquals((await state()).positionMs, 75);
      await command('pause');
      assertEquals([(await state()).state, (await state()).positionMs], [
        'pause',
        75,
      ]);
      await command('restart');
      assertEquals([(await state()).state, (await state()).positionMs], [
        'pause',
        0,
      ]);
      await command('play');
      await t.command(path, 'PATCH', credential, { repeat: 'single' }, 200);
      await command('next');
      assertEquals((await state()).current.entryId, entries[1].id);
      await command('seek', { positionMs: 150 });
      await command('restart');
      assertEquals((await state()).current.entryId, entries[1].id);
      assertEquals([(await state()).state, (await state()).positionMs], [
        'play',
        0,
      ]);
      await command('previous');
      assertEquals((await state()).current.entryId, entries[0].id);
      await command('seek', { positionMs: 100 });
      await command('previous');
      assertEquals((await state()).current.entryId, entries[0].id);
      assertEquals((await state()).positionMs, 0);
      await command('seek', { positionMs: 100 });
      await command('stop');
      assertEquals([(await state()).state, (await state()).positionMs], [
        'pause',
        100,
      ]);
      assertEquals((await state()).current.entryId, entries[0].id);
      assertEquals((await state()).speakers[0].id, `speaker-${id}`);
      await command('play');
      assertEquals([(await state()).state, (await state()).positionMs], [
        'play',
        100,
      ]);
      assertEquals((await state()).current.commander, 'member');
      const provenance = t.players.get(id).lastCommand()!.source;
      assertEquals(provenance.kind, 'http');
      assertEquals(provenance.via, 'melofon');
      assertEquals(provenance.user, 'member');
      assertEquals(provenance.userAgent, 'Melofon API test');
      assert(provenance.peer);
      assertEquals(other.playerView(), otherBefore);
      assertEquals(other.lastCommand(), otherCommand);
    }
  } finally {
    await t.close();
  }
});

Deno.test('player command HTTP validates bodies, methods, authentication and Origin before mutation', async () => {
  const t = await setup();
  try {
    const base = '/api/v1/players/1';
    for (const mode of ['cookie', 'bearer'] as const) {
      const { credential } = await t.f.login(mode, 'member', 'password-member');
      const before = t.players.get(1).lastCommand();
      for (
        const action of [
          'play',
          'pause',
          'stop',
          'next',
          'previous',
          'restart',
          'seek',
        ]
      ) {
        const body = action === 'seek' ? { positionMs: 0 } : {};
        await error(
          await t.f.json(`${base}/${action}`, 'POST', body),
          401,
          'unauthenticated',
        );
        await error(
          await t.f.json(
            `${base}/${action}`,
            'POST',
            body,
            credential,
            'http://other.home',
          ),
          403,
          'origin',
        );
        await error(
          await t.f.json(
            `${base}/${action}`,
            'POST',
            { ...body, extra: true },
            credential,
          ),
          400,
          'unknown_field',
        );
        await error(
          await t.f.json(
            `/api/v1/players/999/${action}`,
            'POST',
            body,
            credential,
          ),
          404,
          'not_found',
        );
        await error(
          await t.f.json(
            `/api/v1/players/01/${action}`,
            'POST',
            body,
            credential,
          ),
          404,
          'not_found',
        );
        const read = await t.f.get(`${base}/${action}`, credential);
        assertEquals(read.status, 405);
        await read.body?.cancel();
      }
      for (
        const body of [
          {},
          { positionMs: 1, seekMs: 2 },
          { positionMs: -1 },
          { positionMs: 0.5 },
          { positionMs: '2' },
          { seekMs: null },
          { seekMs: 0.5 },
          { seekMs: 9007199254740992 },
        ]
      ) {
        await error(
          await t.f.json(`${base}/seek`, 'POST', body, credential),
          400,
          'invalid_field',
        );
      }
      const noOrigin = await t.f.json(
        `${base}/pause`,
        'POST',
        {},
        credential,
        null,
      );
      if (mode === 'cookie') await error(noOrigin, 403, 'origin');
      else {
        assertEquals(noOrigin.status, 204);
        await noOrigin.body?.cancel();
      }
      if (mode === 'cookie') {
        assertEquals(t.players.get(1).lastCommand(), before);
      }
    }
  } finally {
    await t.close();
  }
});

Deno.test('player modes HTTP validates the whole PATCH, persists modes per player and notifies another user', async () => {
  const t = await setup();
  let ws: WebSocket | undefined;
  try {
    const actor = await t.f.login('cookie', 'member', 'password-member');
    const observer = await t.f.login('bearer');
    const kitchen = await t.players.create('Kitchen');
    const frames: { type: string; events?: Record<string, string[]> }[] = [];
    ws = new WebSocket(t.f.origin.replace('http:', 'ws:') + '/api/v1/events', {
      headers: {
        Authorization: `Bearer ${observer.credential}`,
        Origin: t.f.origin,
      },
    });
    ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
    await waitFor(() => frames.some((f) => f.type === 'hello'));
    const path = `/api/v1/players/${kitchen.id}`;
    for (
      const body of [
        { repeat: true },
        { repeat: 'one' },
        { repeat: null },
        { consume: 1 },
        { consume: null },
        { name: 'Changed', repeat: 'all', consume: 'yes' },
        { repeat: 'all', shuffle: true },
      ]
    ) {
      await error(
        await t.f.json(path, 'PATCH', body, actor.credential),
        400,
        'shuffle' in body ? 'unknown_field' : 'invalid_field',
      );
    }
    await error(
      await t.f.json(
        path,
        'PATCH',
        { name: 'Home', consume: true },
        actor.credential,
      ),
      409,
      'name_conflict',
    );
    assertEquals(t.players.list()[1].name, 'Kitchen');
    assertEquals(t.players.get(kitchen.id).playerView().repeat, 'off');
    assertEquals(t.players.get(kitchen.id).playerView().consume, false);
    await error(
      await t.f.json(path, 'PATCH', { repeat: 'all' }),
      401,
      'unauthenticated',
    );
    await error(
      await t.f.json(
        path,
        'PATCH',
        { repeat: 'all' },
        actor.credential,
        'http://other.home',
      ),
      403,
      'origin',
    );
    for (const repeat of ['all', 'single', 'off']) {
      const { player } = await t.command(path, 'PATCH', actor.credential, {
        repeat,
      }, 200);
      assertEquals(player.repeat, repeat);
    }
    const { player } = await t.command(path, 'PATCH', actor.credential, {
      name: 'Study',
      repeat: 'single',
      consume: true,
    }, 200);
    assertEquals([player.name, player.repeat, player.consume], [
      'Study',
      'single',
      true,
    ]);
    await waitFor(() =>
      frames.some((f) => f.events?.options?.includes(String(kitchen.id)))
    );
    const visible = (await t.read(path, observer.credential)).player;
    assertEquals([visible.repeat, visible.consume], ['single', true]);
    await t.persistence.drain();
    const saved = await t.f.store.playback.loadPlayerState(kitchen.id);
    assertEquals([saved?.repeat, saved?.consume], ['single', true]);
    assertEquals(t.players.get(1).playerView().repeat, 'off');
    assertEquals(t.players.get(1).playerView().consume, false);
    assertEquals(
      t.players.get(kitchen.id).lastCommand()?.source.user,
      'member',
    );
    await t.command(
      path,
      'PATCH',
      observer.credential,
      { consume: false },
      200,
    );
    assertEquals((await t.read(path, actor.credential)).player.consume, false);
  } finally {
    if (ws && ws.readyState < WebSocket.CLOSING) ws.close();
    if (ws) await waitFor(() => ws!.readyState === WebSocket.CLOSED);
    await t.close();
  }
});

Deno.test('player command HTTP returns no_target and airplay_busy without mutating either player', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login(
      'bearer',
      'member',
      'password-member',
    );
    const kitchen = await t.players.create('Kitchen');
    const playback = t.players.get(kitchen.id);
    await playback.queueAdd(t.songs);
    for (
      const [action, body] of [['play', {}], ['next', {}], ['previous', {}], [
        'seek',
        { positionMs: 100 },
      ]] as const
    ) {
      await error(
        await t.f.json(
          `/api/v1/players/${kitchen.id}/${action}`,
          'POST',
          body,
          credential,
        ),
        409,
        'no_target',
      );
      assertEquals(playback.playerView().state, 'stop');
      assertEquals(playback.playerView().current, null);
    }
    for (const id of [1, kitchen.id]) {
      await t.addSpeaker(`air-${id}`, 'AirPlay');
      await t.players.join(id, `air-${id}`);
    }
    await t.players.get(1).queueAdd(t.songs);
    await t.command('/api/v1/players/1/play', 'POST', credential, {});
    await t.command('/api/v1/players/1', 'PATCH', credential, {
      name: 'Living room',
    }, 200);
    const before = playback.playerView();
    const queue = playback.queueView();
    const last = playback.lastCommand();
    for (
      const [action, body] of [['play', {}], ['next', {}], ['previous', {}], [
        'seek',
        { seekMs: 100 },
      ]] as const
    ) {
      const response = await t.f.json(
        `/api/v1/players/${kitchen.id}/${action}`,
        'POST',
        body,
        credential,
      );
      assertEquals(response.status, 409);
      assertEquals(await response.json(), {
        code: 'airplay_busy',
        message: 'AirPlay is busy in Living room',
        owner: { id: 1, name: 'Living room' },
      });
      assertEquals(playback.playerView(), before);
      assertEquals(playback.queueView(), queue);
      assertEquals(playback.lastCommand(), last);
      assertEquals(t.players.get(1).playerView().state, 'play');
    }
    await t.command('/api/v1/players/1/stop', 'POST', credential, {});
    await t.command(
      `/api/v1/players/${kitchen.id}/play`,
      'POST',
      credential,
      {},
    );
    assertEquals(
      (await t.read(`/api/v1/players/${kitchen.id}`, credential)).player.state,
      'play',
    );
  } finally {
    await t.close();
  }
});
