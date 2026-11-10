import { assert, assertEquals, assertStrictEquals } from '@std/assert';
import { apiFixture } from './helpers/api.ts';
import { restored } from './helpers/prepared.ts';
import { openStore } from '../src/store/index.ts';
import { seedFirstUser } from '../src/users.ts';
import { createLibraries } from '../src/libraries.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibrary } from '../src/library.ts';
import { createNowPlaying, type NowPlaying } from '../src/nowplaying.ts';
import { createPlayer } from '../src/player.ts';
import { createPlayback, type Playback } from '../src/playback.ts';
import {
  createPlaybackReports,
  type PlaybackReports,
} from '../src/playback-reports.ts';
import { createNotify } from '../src/notify.ts';
import type { State } from '../src/state.ts';
import type { Sessions, SessionsEnded } from '../src/sessions.ts';
import { rawSql } from '../src/store/testing.ts';

function emptyReports(): NowPlaying {
  return {
    set: () => Promise.resolve(),
    report: () => Promise.resolve(),
    reportSession: () => Promise.resolve(false),
    clearByStreamId: () => Promise.resolve(false),
    list: () => Promise.resolve([]),
    expire: () => Promise.resolve(false),
  };
}

Deno.test('household reports share one session subscription and expiry lifecycle across engine facades', async () => {
  let listener!: (event: SessionsEnded) => void;
  let subscriptions = 0, unsubscribes = 0, calls = 0, declarations = 0;
  const sessions: Pick<Sessions, 'onSessionsEnded'> = {
    onSessionsEnded(fn) {
      subscriptions++;
      listener = fn;
      return () => {
        unsubscribes++;
      };
    },
  };
  const pending: ((changed: boolean) => void)[] = [];
  const entered: (() => void)[] = [];
  const firstEntered = new Promise<void>((resolve) => entered.push(resolve));
  const secondEntered = new Promise<void>((resolve) => entered.push(resolve));
  const nowPlaying = {
    ...emptyReports(),
    expire() {
      calls++;
      return new Promise<boolean>((resolve) => {
        pending.push(resolve);
        entered.shift()!();
      });
    },
  };
  const notify = createNotify();
  const events: string[][] = [];
  notify.subscribe((names) => events.push(names));
  const library = { getSong: () => Promise.resolve(null) };
  const reports = createPlaybackReports({
    nowPlaying,
    library,
    sessions,
    notify,
    serverRows: () => [],
  });
  const engines = [0, 1].map(() =>
    createPlayback({
      player: createPlayer(),
      nowPlaying,
      library,
      sessions,
      notify,
      reports,
      cfg: {},
    })
  );
  const policy = {
    declare() {
      declarations++;
    },
    getTyped: () => Promise.resolve(3600),
  } as unknown as State;
  try {
    const start = engines[0].startReportExpiry(policy);
    await engines[1].startReportExpiry(policy);
    await firstEntered;
    assertEquals(subscriptions, 1);
    assertEquals(declarations, 1);
    assertEquals(calls, 1);
    const a = engines[0].expireReports();
    const b = engines[1].expireReports();
    assertStrictEquals(
      a,
      b,
      'all callers share the one pending household sweep',
    );
    await engines[0].close();
    assertEquals(
      unsubscribes,
      0,
      'closing a borrower cannot close household reports',
    );
    listener({ userId: 'user', sessionIds: ['ended'] });
    let closed = false;
    const closing = reports.close().then(() => {
      closed = true;
    });
    assertEquals(unsubscribes, 1);
    assertEquals(closed, false);
    pending.shift()!(true);
    await start;
    await secondEntered;
    assertEquals(
      calls,
      2,
      'session revocation follows, rather than duplicates, the pending sweep',
    );
    assertEquals(
      closed,
      false,
      'household close drains queued session cleanup',
    );
    pending.shift()!(false);
    assertEquals(await a, true);
    await closing;
    assertEquals(events, [['nowPlaying']]);
    assertEquals(await engines[1].expireReports(), false);
    await reports.close();
    assertEquals(unsubscribes, 1);
  } finally {
    for (const release of pending) release(false);
    await Promise.all(engines.map((engine) => engine.close()));
    await reports.close();
  }
});

Deno.test('household aggregate reads each engine and app once over HTTP and survives a borrower closing', async () => {
  const dir = await restored('playback-household', async (dir) => {
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
  }, 'melofon-household-');
  const engines: Playback[] = [];
  let reports!: PlaybackReports;
  let subscriptions = 0, unsubscribes = 0, lists = 0, expiries = 0;
  let expired!: () => void;
  const sessionExpired = new Promise<void>((resolve) => expired = resolve);
  const f = await apiFixture({
    storeDir: dir,
    services: async (f) => {
      const library = createLibrary(f.store);
      const real = createNowPlaying(f.store, { state: f.state });
      const nowPlaying: NowPlaying = {
        ...real,
        list() {
          lists++;
          return real.list();
        },
        async expire() {
          expiries++;
          const changed = await real.expire();
          if (changed) expired();
          return changed;
        },
      };
      const sessions = {
        onSessionsEnded(fn: Parameters<Sessions['onSessionsEnded']>[0]) {
          subscriptions++;
          const unsubscribe = f.auth.sessions.onSessionsEnded(fn);
          return () => {
            unsubscribes++;
            unsubscribe();
          };
        },
      };
      reports = createPlaybackReports({
        nowPlaying,
        library,
        sessions,
        notify: f.notify,
        serverRows: () =>
          engines.flatMap((engine) => {
            const row = engine.serverNowPlayingView();
            return row ? [row] : [];
          }),
      });
      for (let i = 0; i < 2; i++) {
        engines.push(createPlayback({
          player: createPlayer(),
          nowPlaying,
          library,
          sessions,
          reports,
          cfg: f.cfg,
          notify: f.notify,
        }));
      }
      const songs = await library.listSongs({ offset: 0, size: 2 });
      await engines[0].queueAdd([songs[0]], { play: true });
      await engines[1].queueAdd([songs[1]], { play: true });
      engines[1].pause();
      return { library, playback: engines[0] };
    },
  });
  try {
    assertEquals(subscriptions, 1);
    const app = await f.login('cookie');
    const observer = await f.login('bearer');
    const song =
      (await createLibrary(f.store).listSongs({ offset: 0, size: 1 }))[0];
    const response = await f.json('/api/v1/me/playback', 'POST', {
      songId: song.id,
      run: 1,
      sequence: 0,
      state: 'playing',
      positionMs: 0,
    }, app.credential);
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { accepted: true });
    const read = async () => {
      const before = lists;
      const response = await f.get('/api/v1/now-playing', observer.credential);
      assertEquals(response.status, 200);
      const rows = (await response.json()).nowPlaying as {
        kind: string;
        state: string;
        song: { id: string };
      }[];
      assertEquals(
        lists,
        before + 1,
        'one household app read, not one per engine',
      );
      return rows;
    };
    const rows = await read();
    assertEquals(rows.map((row) => row.kind), ['server', 'server', 'app']);
    assertEquals(rows.slice(0, 2).map((row) => row.state), [
      'playing',
      'paused',
    ]);
    assertEquals(rows[2].song.id, song.id);
    const removed = engines.shift()!;
    await removed.close();
    assertEquals(unsubscribes, 0);
    assertEquals((await read()).map((row) => row.kind), ['server', 'app']);
    const revoked = await f.json(
      `/api/v1/me/sessions/${app.body.session.id}`,
      'DELETE',
      undefined,
      observer.credential,
    );
    assertEquals(revoked.status, 200);
    await revoked.body?.cancel();
    await sessionExpired;
    assertEquals(expiries, 1, 'one cleanup sweep for the ended session');
    assertEquals((await read()).map((row) => row.kind), ['server']);
    assertEquals(await rawSql(f.store).all('SELECT * FROM listens'), []);
    engines[0].stop();
    const stopped = await read();
    assertEquals(stopped.map((row) => row.kind), ['server']);
    assertEquals(stopped[0].state, 'paused');
    assert(subscriptions === 1 && unsubscribes === 0);
  } finally {
    await Promise.all(engines.map((engine) => engine.close()));
    await reports.close();
    assertEquals(unsubscribes, 1);
    await f.close();
    await Deno.remove(dir, { recursive: true });
  }
});
