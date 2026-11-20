import { assert, assertEquals } from '@std/assert';
import { crossfadeHttp } from './helpers/crossfade-http.ts';
import { crossfadeReference } from './helpers/crossfade-proof.ts';
import { nativeHttpFixture } from './helpers/playback-native-http.ts';
import {
  concatenate,
  timelineControl,
  timelineLibraryProof,
  timelinePcm,
  timelineUntil,
} from './helpers/timeline-proof.ts';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';

function test(name: string, fn: () => Promise<void>) {
  Deno.test({
    name: `player crossfade: ${name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn,
  });
}
const parts = [timelinePcm(22050 + 137), timelinePcm(22050 + 19, 2)];

test('fresh and upgrade default to zero without refreshing saved playback', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'crossfade-upgrade-' });
  let store = await openStore(directory);
  try {
    assertEquals((await store.players.list())[0].crossfadeMs, 0);
    const q = rawSql(store);
    await q.run(
      `INSERT INTO player_state VALUES (1, 'play', NULL, 4321, 'all', false, true, TIMESTAMPTZ '2020-01-02 03:04:05.678+00')`,
    );
    const before = await store.playback.loadPlayerState(1);
    await q.run('ALTER TABLE players DROP COLUMN crossfade_ms');
    await q.run("DELETE FROM migrations WHERE id = 'players-crossfade-001'");
    await store.close();
    store = await openStore(directory);
    assertEquals((await store.players.list())[0].crossfadeMs, 0);
    assertEquals(await store.playback.loadPlayerState(1), before);
  } finally {
    await store.close();
    await Deno.remove(directory, { recursive: true });
  }
});

test('authenticated PATCH, restart and independent players reach rendered mixed PCM', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'crossfade-restart-' });
  let t = await crossfadeHttp({ parts, directory });
  try {
    assertEquals((await t.current()).crossfadeMs, 0);
    const { player: kitchen } = await t.json('/players', 'POST', {
      name: 'Kitchen',
    }, 201);
    await t.add();
    await t.add(kitchen.id);
    const snapshot = await t.f.store.playback.loadPlayerState(1);
    const events: { types: string[]; keys: unknown }[] = [];
    const off = t.f.notify!.subscribe((types, keys) =>
      events.push({ types, keys })
    );
    await t.patch({ crossfadeMs: 100 });
    off();
    assertEquals((await t.current()).crossfadeMs, 100);
    assertEquals((await t.current(kitchen.id)).crossfadeMs, 0);
    assertEquals(
      await t.f.store.playback.loadPlayerState(1),
      snapshot,
      'setting does not make a bookmark fresh',
    );
    assertEquals(t.players.get(1).lastCommand()?.source.kind, 'http');
    assert(
      events.some((e) =>
        e.types.includes('options') && JSON.stringify(e.keys).includes('"1"')
      ),
    );
    await t.close();
    t = await crossfadeHttp({ parts, directory });
    assertEquals((await t.current()).crossfadeMs, 100);
    assertEquals((await t.current(kitchen.id)).crossfadeMs, 0);
    await t.command('play');
    await timelineUntil(
      'Home drain',
      () => t.players.get(1).playerView().state === 'stop',
    );
    const expected = crossfadeReference(parts, 4410).pcm;
    const session = t.receivers[0].sessions[0], trace = t.traces.get(1)!;
    assertEquals(trace.realAudio(session), expected);
    assertEquals(
      trace.scheduledRealAudio(session, t.receivers[0].nowMs()),
      expected,
    );
    assertEquals(
      t.records.filter((r) => r.playerId === 1).map((r) => r.appliedFrames),
      [4410n],
    );
    await t.players.setSpeakers(kitchen.id, ['2']);
    await timelineUntil(
      'Home transport released',
      () => session.closedAtMs !== null,
    );
    await t.command('play', kitchen.id);
    await timelineUntil(
      'Kitchen drain',
      () => t.players.get(kitchen.id).playerView().state === 'stop',
    );
    const peer = t.receivers[1].sessions[0], other = t.traces.get(kitchen.id)!;
    assertEquals(
      other.scheduledRealAudio(peer, t.receivers[1].nowMs()),
      concatenate(parts),
    );
    assertEquals(t.records.filter((r) => r.playerId === kitchen.id), []);
    assertEquals((await t.current()).crossfadeMs, 100);
    // The destination retains its own setting across both kinds of copy.
    await t.patch({ crossfadeMs: 25 }, kitchen.id);
    for (const kind of ['add', 'replace']) {
      await t.json(`/players/1/queue/copy/${kind}`, 'POST', {
        targetPlayerId: kitchen.id,
      }, 204);
      assertEquals((await t.current(kitchen.id)).crossfadeMs, 25);
    }
    const own = await t.own();
    assert(!('crossfadeMs' in own) && !('crossfade' in own));
    await timelineLibraryProof();
  } finally {
    await t.close();
    await Deno.remove(directory, { recursive: true });
  }
});

test('invalid whole bodies and rejected auth/Origin never mutate settings or modes', async () => {
  const t = await crossfadeHttp({ parts });
  try {
    for (
      const crossfadeMs of [
        -1,
        1.5,
        null,
        '100',
        false,
        {},
        Number.MAX_SAFE_INTEGER,
        2 ** 53,
      ]
    ) {
      const response = await t.f.json('/api/v1/players/1', 'PATCH', {
        name: 'Should not rename',
        repeat: 'all',
        consume: true,
        crossfadeMs,
      }, t.credential);
      assertEquals(response.status, 400, await response.text());
      const current = await t.current();
      assertEquals([
        current.name,
        current.repeat,
        current.consume,
        current.crossfadeMs,
      ], ['Home', 'off', false, 0]);
    }
    const denied = await t.f.json('/api/v1/players/1', 'PATCH', {
      crossfadeMs: 100,
    });
    assertEquals(denied.status, 401, await denied.text());
    const origin = await t.f.json(
      '/api/v1/players/1',
      'PATCH',
      { crossfadeMs: 100 },
      t.credential,
      'http://other.home',
    );
    assertEquals(origin.status, 403, await origin.text());
    assertEquals((await t.current()).crossfadeMs, 0);
    const cookie = await t.f.login('cookie');
    const accepted = await t.f.json('/api/v1/players/1', 'PATCH', {
      crossfadeMs: 1_000_000_000,
    }, cookie.credential);
    assertEquals(accepted.status, 200, await accepted.text());
    assertEquals(
      (await t.current()).crossfadeMs,
      1_000_000_000,
      'no arbitrary duration cap',
    );
  } finally {
    await t.close();
  }
});

test('published setting has one command and a retained exact C4 save batch', async () => {
  const t = await crossfadeHttp({ parts });
  const original = t.f.store.players.saveChanges;
  const attempts: Parameters<typeof original>[0][] = [];
  let fail = true;
  try {
    await t.persistence.drain();
    t.f.store.players.saveChanges = async (batch) => {
      attempts.push(structuredClone(batch));
      if (fail) throw new Error('crossfade save unavailable');
      await original(batch);
    };
    await t.patch({ crossfadeMs: 100 });
    const command = t.players.get(1).lastCommand();
    assertEquals((await t.current()).crossfadeMs, 100);
    assertEquals((await t.f.store.players.list())[0].crossfadeMs, 0);
    const unhealthy = await t.f.request('/_/health');
    assertEquals(unhealthy.status, 503);
    assertEquals((await unhealthy.json()).persistence.pendingWrites, 1);
    assertEquals(attempts[0].players?.[0].crossfadeMs, 100);
    assert(
      !attempts[0].players?.[0].state,
      'setting save is not a fresh playback snapshot',
    );
    fail = false;
    await t.persistence.drain();
    assertEquals(attempts.at(-1), attempts[0]);
    assertEquals((await t.f.store.players.list())[0].crossfadeMs, 100);
    assertEquals(
      t.players.get(1).lastCommand(),
      command,
      'save never replays the command',
    );
    const healthy = await t.f.request('/_/health');
    assertEquals(healthy.status, 200);
    await healthy.body?.cancel();
  } finally {
    fail = false;
    await t.close();
  }
});

test('accepted overlap keeps its setting, scheduled current, position and metadata origin', async () => {
  const bytes = [
    timelinePcm(44100 + 137),
    timelinePcm(44100 + 19, 2),
    timelinePcm(44100 + 73, 3),
  ];
  const held = Promise.withResolvers<void>();
  let blocked = false;
  const f = await nativeHttpFixture({
    pcm: bytes[0],
    additionalPcm: bytes.slice(1),
    metadata: true,
    titles: ['Fade A', 'Fade B', 'Fade C'],
    async append(request, append) {
      const result = await append(request);
      if (request.source === 2n && result.acceptedFrames && !blocked) {
        blocked = true;
        await held.promise;
      }
      return result;
    },
  });
  const published: { id: number; position: number; completedA: boolean }[] = [];
  const off = f.fixture.notify!.subscribe(() => {
    const view = f.playback.playerView();
    if (view.current) {
      published.push({
        id: view.current.id,
        position: view.itemProgressMs,
        completedA: f.completions.some((r) =>
          r.source === 1n && r.status === 'complete'
        ),
      });
    }
  });
  try {
    const c = await timelineControl(f);
    await c.add();
    await c.modes({ crossfadeMs: 100 });
    const entries = f.playback.queueView().items;
    await c.command('play');
    await timelineUntil('B accepted after its mixed head', () => blocked);
    await c.modes({ crossfadeMs: 0 });
    assertEquals((await c.current()).current.entryId, entries[0].id);
    held.resolve();
    await timelineUntil(
      'B scheduled with its head already played',
      async () => (await c.current()).current?.entryId === entries[1].id,
    );
    assert((await c.current()).positionMs >= 100);
    assertEquals((await f.own('/player')).item_id, entries[1].id);
    const session = f.receiver.sessions[0];
    await timelineUntil(
      'B timed metadata sent',
      () =>
        session.parameters.some((p) =>
          new TextDecoder().decode(p.body).includes('Fade B')
        ),
    );
    const marker = session.parameters.find((p) =>
      new TextDecoder().decode(p.body).includes('Fade B')
    )!;
    const record = session.wire.find((e) => e.kind === 'record');
    assert(record?.kind === 'record');
    const anchor = Number(/rtptime=(\d+)/.exec(record.rtpInfo)![1]);
    assertEquals(
      Number(/rtptime=(\d+)/.exec(marker.rtpInfo!)![1]),
      (anchor + bytes[0].length / 4) % 2 ** 32,
    );
    const firstB = published.find((p) => p.id === entries[1].id)!;
    assertEquals(firstB.position, 100, 'B is never published at zero');
    assert(
      firstB.completedA,
      'A stays current through its final contributing frame',
    );
    const progressFrames = session.parameters.flatMap((p) => {
      const body = new TextDecoder().decode(p.body);
      const value = /progress: (\d+)\/(\d+)\/(\d+)/.exec(body);
      return value
        ? [(Number(value[2]) - Number(value[1]) + 2 ** 32) % 2 ** 32]
        : [];
    });
    assert(
      progressFrames.includes(4410),
      'receiver progress begins B at its mixed head offset',
    );
    await timelineUntil(
      'all real tails rendered',
      () => f.playback.playerView().state === 'stop',
    );
    const actual = f.audio.scheduledRealAudio(session, f.receiver.nowMs());
    const first = crossfadeReference(bytes.slice(0, 2), 4410).pcm;
    assertEquals(
      actual,
      concatenate([first, bytes[2]]),
      'A/B retains 100 ms; uncommitted B/C uses zero',
    );
    await timelineLibraryProof();
  } finally {
    held.resolve();
    off();
    await f.close();
  }
});

for (const phase of ['first head', 'next chunk'] as const) {
  test(`enabled setting never waits for incoming ${phase} to finish A`, async () => {
    const held = Promise.withResolvers<void>();
    const incoming = Promise.withResolvers<void>();
    let blocked = false;
    const bytes = [timelinePcm(22050 + 137), timelinePcm(22050 + 19, 2)];
    const f = await nativeHttpFixture({
      pcm: bytes[0],
      additionalPcm: [bytes[1]],
      async beforeDecode(path) {
        if (phase === 'first head' && path.endsWith('next-0.wav')) {
          blocked = true;
          incoming.resolve();
          await held.promise;
        }
      },
      async afterDecodedChunk(path) {
        if (path.endsWith('source.wav')) await incoming.promise;
        else if (phase === 'next chunk') {
          blocked = true;
          incoming.resolve();
          await held.promise;
        }
      },
    });
    try {
      const c = await timelineControl(f);
      await c.add();
      await c.modes({ crossfadeMs: 1 });
      await c.command('play');
      await timelineUntil('incoming decoder is parked', () => blocked);
      await timelineUntil(
        'A tail completes despite parked incoming input',
        () =>
          f.completions.some((r) => r.source === 1n && r.status === 'complete'),
      );
      const expected = phase === 'first head'
        ? concatenate(bytes)
        : crossfadeReference(bytes, 44).pcm;
      assertEquals(
        f.audio.scheduledRealAudio(
          f.receiver.sessions[0],
          f.receiver.nowMs(),
          0,
          true,
        ),
        expected.subarray(0, bytes[0].length),
      );
      held.resolve();
      await timelineUntil(
        'incoming source drains',
        () => f.playback.playerView().state === 'stop',
      );
      assertEquals(
        f.audio.scheduledRealAudio(f.receiver.sessions[0], f.receiver.nowMs()),
        expected,
      );
    } finally {
      held.resolve();
      incoming.resolve();
      await f.close();
    }
  });
}
