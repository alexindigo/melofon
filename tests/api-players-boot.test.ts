// Steps F/G/H acceptance: cold production main.ts -> HTTP -> receiver audio.
import { assert, assertEquals } from '@std/assert';
import dgram from 'node:dgram';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { scanLibrary } from '../src/scan.ts';
import { dnsQuestions } from '../src/mdns.ts';
import { airplayAnswer } from './mdns-builder.ts';
import { legacyPlayerStorage } from './helpers/legacy-players.ts';
import { reservePorts } from './helpers/ports.ts';
import { startFakeRaop } from './helpers/fake-raop.ts';
import { decodeReceiverAudio } from './helpers/raop-audio-consumer.ts';
import { sleep, speakerMedia, until } from './helpers/speaker-consumer.ts';

const password = 'players-boot-password';
const speakerIds = ['73588229205', '73588229206'];

async function eventually(check: () => Promise<boolean>) {
  const end = performance.now() + 30000;
  while (!await check()) {
    assert(performance.now() < end, 'cold player HTTP outcome timed out');
    await sleep(20);
  }
}

/** Same production entry point and isolated environment as the cold smoke tests. */
async function boot(data: string) {
  using ports = reservePorts(2);
  const [port, ownPort] = ports.ports;
  const origin = `http://melofon.home:${port}`;
  const ownOrigin = `http://melofon.home:${ownPort}`;
  const env: Record<string, string> = {};
  for (
    const key of ['HOME', 'PATH', 'DENO_DIR', 'TMPDIR', 'MELOFON_RAOP_LIB']
  ) {
    const value = Deno.env.get(key);
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    MELOFON_DATA: data,
    MELOFON_USER: 'admin',
    MELOFON_PASSWORD: password,
    MELOFON_SECRET: 'players-boot-secret',
    MELOFON_LISTEN: `0.0.0.0:${port}`,
    MELOFON_LISTEN_owntone: `${ownPort},${ownPort}`,
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
  const logs = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  let stopped = false, credential = '';
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      child.kill('SIGTERM');
    } catch {
      // Early exit is checked below, together with captured diagnostics.
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const status = await Promise.race([
      child.status,
      new Promise<null>((done) => timer = setTimeout(() => done(null), 10000)),
    ]);
    clearTimeout(timer);
    if (!status) {
      child.kill('SIGKILL');
      await child.status;
    }
    assert(status?.success, (await logs).join('\n'));
  };
  const request = (
    base: string,
    path: string,
    method = 'GET',
    body?: unknown,
  ) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        ...(base === origin && credential
          ? { Authorization: `Bearer ${credential}` }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
  const json = async (
    base: string,
    path: string,
    method = 'GET',
    body?: unknown,
  ) => {
    const response = await request(base, path, method, body);
    const text = await response.text();
    assert(response.ok, `${method} ${path}: ${response.status} ${text}`);
    return text ? JSON.parse(text) : undefined;
  };
  const native = (path: string, method = 'GET', body?: unknown) =>
    json(origin, `/api/v1${path}`, method, body);
  const nativeResponse = (path: string, method = 'GET', body?: unknown) =>
    request(origin, `/api/v1${path}`, method, body);
  const own = (path: string, method = 'GET', body?: unknown) =>
    json(ownOrigin, `/api${path}`, method, body);
  try {
    await eventually(async () => {
      try {
        const response = await fetch(`${origin}/_/health`, {
          signal: AbortSignal.timeout(500),
        });
        return (await response.json()).ok === true;
      } catch {
        return false;
      }
    });
    credential = (await native('/session', 'POST', {
      username: 'admin',
      password,
      use: 'bearer',
      deviceName: 'Players acceptance',
    })).key;
    return { native, nativeResponse, own, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function advertise(
  dns: ReturnType<typeof dgram.createSocket>,
  receivers: Awaited<ReturnType<typeof startFakeRaop>>[],
  ids = speakerIds,
) {
  await new Promise<void>((done, reject) => {
    dns.once('error', reject);
    dns.bind(5353, '127.0.0.1', done);
  });
  dns.on('message', (message, peer) => {
    const questions = dnsQuestions(message);
    if (!questions || (message[2] & 0x80) !== 0) return;
    for (const [i, receiver] of receivers.entries()) {
      dns.send(
        airplayAnswer({
          instance: `${BigInt(ids[i]).toString(16)}@Room ${i}._raop._tcp.local`,
          host: `room-${i}.local`,
          address: [127, 0, 0, 1],
          port: receiver.port,
          txt: ['tp=UDP', 'am=AppleTV3,1', 'sr=44100', 'ss=16', 'ch=2'],
          id: new DataView(message.buffer, message.byteOffset).getUint16(0),
          questions,
        }),
        peer.port,
        peer.address,
      );
    }
  });
}

Deno.test('players cold HTTP: v0.2.0 upgrade, Kitchen membership survives restart and OwnTone still plays Home', async () => {
  assert(
    (await Deno.resolveDns('melofon.home', 'A')).every((ip) =>
      !ip.startsWith('127.')
    ),
  );
  const dir = await Deno.makeTempDir({ prefix: 'melofon-players-boot-' });
  const receivers = [
    await startFakeRaop({ captureAudio: true }),
    await startFakeRaop({ captureAudio: true }),
  ];
  // Production preparation uses target-only DNS-SD even with browsing off.
  // Reuse the real DNS parser and existing wire advertisement fixture.
  const dns = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let server: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    await advertise(dns, receivers);
    await speakerMedia(dir);
    const store = await openStore(`${dir}/db`);
    try {
      await createLibraries(store).add('Music', `${dir}/media`);
      await scanLibrary(store);
      const [song] = await createLibrary(store).listSongs({
        offset: 0,
        size: 1,
      });
      assert(song);
      for (const [i, receiver] of receivers.entries()) {
        await store.speakers.saveAdopted({
          id: speakerIds[i],
          name: `Room ${i}`,
          type: 'AirPlay',
          host: '127.0.0.1',
          port: receiver.port,
          receiverIdentity: speakerIds[i],
          selected: true,
          volume: 100,
          connectionStrategy: 'owntone',
        });
      }
      await legacyPlayerStorage(store, false, true);
      const q = rawSql(store);
      // Seed only the released singleton shape, then close it before main boots.
      await q.run(`INSERT INTO server_queue VALUES
        (0, 4, 'song', '${song.id}'), (1, 9, 'song', '${song.id}')`);
      await q.run(
        "UPDATE player_state SET state = 'pause', repeat = 'all', consume = false",
      );
    } finally {
      await store.close();
    }

    server = await boot(`${dir}/db`);
    const home = { id: 1, name: 'Home', isDefault: true };
    assertEquals((await server.native('/players')).players, [home]);
    const initial = (await server.native('/players/1')).player;
    assertEquals(
      [
        initial.state,
        initial.positionMs,
        initial.repeat,
        initial.shuffle,
        initial.consume,
        initial.current.entryId,
      ],
      ['pause', 4321, 'all', true, false, 9],
    );
    assertEquals(
      initial.speakers.map((s: { id: string }) => s.id).sort(),
      speakerIds,
    );
    assert(initial.speakers.every((s: { linked: boolean }) => s.linked));
    const queue = await server.own('/queue');
    assertEquals([queue.version, queue.count], [29, 2]);
    assertEquals(queue.items.map((item: { id: number }) => item.id), [4, 9]);
    const { player: kitchen } = await server.native('/players', 'POST', {
      name: 'Kitchen',
    });
    await server.native(
      `/players/${kitchen.id}/speakers/${speakerIds[1]}`,
      'PUT',
      {},
    );
    await server.stop();

    server = await boot(`${dir}/db`);
    assertEquals((await server.native('/players')).players, [home, kitchen]);
    const restoredHome = (await server.native('/players/1')).player;
    const restoredKitchen =
      (await server.native(`/players/${kitchen.id}`)).player;
    assertEquals(restoredHome.speakers, [{
      id: speakerIds[0],
      name: 'Room 0',
      linked: true,
    }]);
    assertEquals(restoredKitchen.speakers, [{
      id: speakerIds[1],
      name: 'Room 1',
      linked: true,
    }]);
    assertEquals([
      restoredHome.state,
      restoredHome.positionMs,
      restoredHome.current.entryId,
    ], ['pause', 4321, 9]);
    assertEquals(
      await server.own('/queue'),
      queue,
      'OwnTone still lists the original Home queue',
    );
    const outputs = (await server.own('/outputs')).outputs;
    assertEquals(
      outputs.map((o: { id: string; selected: boolean }) => [o.id, o.selected])
        .sort(),
      [
        [speakerIds[0], true],
        [speakerIds[1], false],
      ],
    );
    assertEquals((await server.own('/player')).item_id, 9);
    await server.own('/player/play', 'PUT');
    await until(() =>
      receivers[0].sessions.some((s) => s.audioPayloads.length >= 8)
    );
    assertEquals((await server.native('/players/1')).player.state, 'play');
    assertEquals(
      (await server.native(`/players/${kitchen.id}`)).player.state,
      'stop',
    );
    assertEquals(
      receivers[1].sessions.length,
      0,
      'OwnTone never activates Kitchen',
    );
    const session = receivers[0].sessions.find((s) =>
      s.audioPayloads.length >= 8
    )!;
    const pcm = decodeReceiverAudio(
      session.sdp,
      session.audioPayloads.slice(0, 8),
    );
    assert(
      pcm.length > 0 && pcm.some((sample) => sample !== 0),
      'Home audio decodes at its receiver',
    );
    await server.own('/player/pause', 'PUT');
    assertEquals((await server.native('/players/1')).player.state, 'pause');
    assertEquals(
      (await server.native(`/players/${kitchen.id}`)).player.state,
      'stop',
    );
    // Native commands reach the same physical consumer, not just an engine DTO.
    await server.native('/players/1/stop', 'POST', {});
    await until(() =>
      receivers[0].sessions.every((s) => s.closedAtMs !== null)
    );
    assert(receivers[0].sessions.some((s) => s.teardowns > 0));
    const stopped = (await server.native('/players/1')).player;
    const oldSessions = receivers[0].sessions.length;
    await server.native('/players/1/play', 'POST', {});
    await until(() =>
      receivers[0].sessions.slice(oldSessions).some((s) =>
        s.audioPayloads.length >= 8
      )
    );
    const resumed = receivers[0].sessions.slice(oldSessions).find((s) =>
      s.audioPayloads.length >= 8
    )!;
    assert(
      decodeReceiverAudio(resumed.sdp, resumed.audioPayloads.slice(0, 8)).some((
        sample,
      ) => sample !== 0),
    );
    const playing = (await server.native('/players/1')).player;
    assertEquals(playing.current.entryId, stopped.current.entryId);
    assert(playing.positionMs >= stopped.positionMs);
    await server.native('/players/1/seek', 'POST', { positionMs: 6000 });
    assert((await server.native('/players/1')).player.positionMs >= 6000);
    await server.native('/players/1/restart', 'POST', {});
    const restarted = (await server.native('/players/1')).player;
    assertEquals(restarted.current.entryId, stopped.current.entryId);
    assertEquals(restarted.state, 'play');
    assert(restarted.positionMs < 3000);
    await server.native('/players/1/pause', 'POST', {});
    assertEquals((await server.native('/players/1')).player.state, 'pause');
    await server.native('/players/1', 'PATCH', {
      repeat: 'single',
      consume: true,
    });
    await server.stop();
    server = await boot(`${dir}/db`);
    const modes = (await server.native('/players/1')).player;
    assertEquals([modes.repeat, modes.consume, modes.state], [
      'single',
      true,
      'pause',
    ]);
    // Core expands a native collection and starts its first new occurrence all
    // the way through production composition to decoded receiver audio.
    const sessionsBeforeAdd = receivers[0].sessions.length;
    const added = await server.native('/players/1/queue/items', 'POST', {
      references: [{ kind: 'album', id: modes.current.song.albumId }],
      clear: true,
      where: 'next',
      startPlaying: true,
    });
    assert(added.count > 0);
    const addedState = (await server.native('/players/1')).player;
    assertEquals(addedState.current.entryId, added.items[0].entryId);
    assertEquals(addedState.state, 'play');
    await until(() =>
      receivers[0].sessions.slice(sessionsBeforeAdd).some((s) =>
        s.audioPayloads.length >= 8
      )
    );
    const addedSession = receivers[0].sessions.slice(sessionsBeforeAdd).find((
      s,
    ) => s.audioPayloads.length >= 8)!;
    assert(
      decodeReceiverAudio(
        addedSession.sdp,
        addedSession.audioPayloads.slice(0, 8),
      ).some((sample) => sample !== 0),
    );
    // Removing the playing occurrence must deliver the successor's audio, not
    // merely update the HTTP state. Duplicate media still has distinct leases.
    const more = await server.native('/players/1/queue/items', 'POST', {
      references: [added.items[0].reference],
    });
    const nextId = more.items[0].entryId;
    const priorPayloads = addedSession.audioPayloads.length;
    const priorFlushes = addedSession.flushes;
    const priorSessionCount = receivers[0].sessions.length;
    await server.native(
      `/players/1/queue/items/${added.items[0].entryId}`,
      'DELETE',
    );
    const afterRemove = (await server.native('/players/1')).player;
    assertEquals([afterRemove.current.entryId, afterRemove.state], [
      nextId,
      'play',
    ]);
    await until(() =>
      addedSession.flushes > priorFlushes &&
        addedSession.audioPayloads.length >= priorPayloads + 8 ||
      receivers[0].sessions.slice(priorSessionCount).some((s) =>
        s.audioPayloads.length >= 8
      )
    );
    const successorSession = receivers[0].sessions.at(-1)!;
    const payloads = successorSession === addedSession
      ? addedSession.audioPayloads.slice(priorPayloads, priorPayloads + 8)
      : successorSession.audioPayloads.slice(0, 8);
    assert(
      decodeReceiverAudio(successorSession.sdp, payloads).some((sample) =>
        sample !== 0
      ),
    );
    // Both copy forms leave Home's live lease and receiver stream alone.
    const sourceQueue = await server.native('/players/1/queue?view=all');
    const copyPayloads = successorSession.audioPayloads.length;
    const copyFlushes = successorSession.flushes;
    for (const mode of ['replace', 'add']) {
      await server.native(`/players/1/queue/copy/${mode}`, 'POST', {
        targetPlayerId: kitchen.id,
      });
      assertEquals(
        await server.native('/players/1/queue?view=all'),
        sourceQueue,
      );
      assertEquals((await server.native('/players/1')).player.state, 'play');
    }
    const kitchenQueue = await server.native(
      `/players/${kitchen.id}/queue?view=all`,
    );
    assertEquals(kitchenQueue.total, sourceQueue.total * 2);
    assert(
      kitchenQueue.items.every((item: { entryId: number }) =>
        item.entryId !== nextId
      ),
    );
    assertEquals(
      (await server.native(`/players/${kitchen.id}`)).player.state,
      'pause',
    );
    await until(() =>
      successorSession.audioPayloads.length >= copyPayloads + 8
    );
    assertEquals(successorSession.flushes, copyFlushes);
    assert(
      decodeReceiverAudio(
        successorSession.sdp,
        successorSession.audioPayloads.slice(copyPayloads, copyPayloads + 8),
      ).some((sample) => sample !== 0),
    );
    await server.native('/players/1/stop', 'POST', {});
    await until(() =>
      receivers[0].sessions.every((s) => s.closedAtMs !== null)
    );
    const kitchenSessions = receivers[1].sessions.length;
    await server.native('/players/1/queue/copy/replace', 'POST', {
      targetPlayerId: kitchen.id,
      startPlaying: true,
    });
    await until(() =>
      receivers[1].sessions.slice(kitchenSessions).some((s) =>
        s.audioPayloads.length >= 8
      )
    );
    const copiedAudio = receivers[1].sessions.slice(kitchenSessions).find((s) =>
      s.audioPayloads.length >= 8
    )!;
    assert(
      decodeReceiverAudio(
        copiedAudio.sdp,
        copiedAudio.audioPayloads.slice(0, 8),
      ).some((sample) => sample !== 0),
    );
    assertEquals((await server.native('/players/1')).player.state, 'pause');
    assertEquals(
      (await server.native(`/players/${kitchen.id}`)).player.state,
      'play',
    );
  } finally {
    await server?.stop();
    dns.close();
    for (const receiver of receivers) receiver.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('controls cold HTTP: edit up next, resume stopped bookmark after restart, copy without interruption and race AirPlay starts', async () => {
  assert(
    (await Deno.resolveDns('melofon.home', 'A')).every((ip) =>
      !ip.startsWith('127.')
    ),
  );
  const dir = await Deno.makeTempDir({ prefix: 'melofon-controls-boot-' });
  const receivers = [
    await startFakeRaop({ captureAudio: true }),
    await startFakeRaop({ captureAudio: true }),
  ];
  const dns = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let server: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    await advertise(dns, receivers);
    await speakerMedia(dir);
    const store = await openStore(`${dir}/db`);
    let songId = '', albumId = '', stationId = '';
    try {
      await createLibraries(store).add('Music', `${dir}/media`);
      await scanLibrary(store);
      const [song] = await createLibrary(store).listSongs({
        offset: 0,
        size: 1,
      });
      assert(song);
      songId = song.id;
      assert(song.albumId, 'scanned fixture belongs to an album');
      albumId = song.albumId;
      stationId = (await store.radio.create({
        name: 'Acceptance radio',
        streamUrl: 'http://melofon.home:9/radio',
        homePageUrl: null,
      })).id;
      for (const [i, receiver] of receivers.entries()) {
        await store.speakers.saveAdopted({
          id: speakerIds[i],
          name: `Room ${i}`,
          type: 'AirPlay',
          host: '127.0.0.1',
          port: receiver.port,
          receiverIdentity: speakerIds[i],
          selected: true,
          volume: 100,
          connectionStrategy: 'owntone',
        });
      }
    } finally {
      await store.close();
    }
    server = await boot(`${dir}/db`);
    const home = '/players/1';
    const { player: kitchen } = await server.native('/players', 'POST', {
      name: 'Kitchen',
    });
    const destination = `/players/${kitchen.id}`;
    await server.native(`${destination}/speakers/${speakerIds[1]}`, 'PUT', {});
    const initial = await server.native(`${home}/queue/items`, 'POST', {
      references: [{ kind: 'song', id: songId }, { kind: 'song', id: songId }],
      startPlaying: true,
    });
    await server.native(`${home}/next`, 'POST', {});
    const currentId = initial.items[1].entryId;
    const album = await server.native(`${home}/queue/items`, 'POST', {
      references: [{ kind: 'album', id: albumId }],
      where: 'next',
    });
    const station = await server.native(`${home}/queue/items`, 'POST', {
      references: [{ kind: 'station', id: stationId }],
      where: 'end',
    });
    assertEquals(album.count, 1);
    assertEquals(station.count, 1);
    const first = await server.native(`${home}/queue?limit=2`);
    const second = await server.native(`${home}/queue?limit=2&offset=2`);
    assertEquals([first.startIndex, first.total, first.currentEntryId], [
      1,
      3,
      currentId,
    ]);
    assertEquals([second.version, second.currentEntryId], [
      first.version,
      currentId,
    ]);
    assertEquals(
      [...first.items, ...second.items].map(
        (item: { entryId: number }) => item.entryId,
      ),
      [currentId, album.items[0].entryId, station.items[0].entryId],
    );
    assertEquals(second.items[0].reference, { kind: 'station', id: stationId });
    assertEquals(
      (await server.native(home)).player.queueVersion,
      first.version,
    );

    await server.native(
      `${home}/queue/items/${album.items[0].entryId}`,
      'PATCH',
      {
        position: 0,
        expectedVersion: first.version,
      },
    );
    const moved = await server.native(`${home}/queue?view=all`);
    assert(moved.version > first.version);
    assertEquals(moved.items.map((item: { entryId: number }) => item.entryId), [
      album.items[0].entryId,
      initial.items[0].entryId,
      currentId,
      station.items[0].entryId,
    ]);
    const stale = await server.nativeResponse(
      `${home}/queue/items/${
        initial.items[0].entryId
      }?expectedVersion=${first.version}`,
      'DELETE',
    );
    assertEquals(stale.status, 409);
    const conflict = await stale.json();
    assertEquals([conflict.code, conflict.version], [
      'queue_conflict',
      moved.version,
    ]);
    assertEquals(await server.native(`${home}/queue?view=all`), moved);
    await server.native(
      `${home}/queue/items/${
        initial.items[0].entryId
      }?expectedVersion=${moved.version}`,
      'DELETE',
    );
    const edited = await server.native(`${home}/queue?view=all`);
    assert(edited.version > moved.version);
    assertEquals(
      edited.items.map((item: { entryId: number }) => item.entryId),
      [
        album.items[0].entryId,
        currentId,
        station.items[0].entryId,
      ],
    );

    await server.native(`${home}/seek`, 'POST', { positionMs: 7000 });
    await until(() =>
      receivers[0].sessions.some((s) => s.audioPayloads.length >= 8)
    );
    await server.native(`${home}/stop`, 'POST', {});
    const stopped = (await server.native(home)).player;
    assertEquals([stopped.state, stopped.current.entryId], [
      'pause',
      currentId,
    ]);
    assert(stopped.positionMs >= 7000);
    await until(() =>
      receivers[0].sessions.every((s) => s.closedAtMs !== null)
    );
    assert(receivers[0].sessions.some((s) => s.teardowns > 0));
    await server.stop();
    server = await boot(`${dir}/db`);
    const restored = (await server.native(home)).player;
    assertEquals([
      restored.state,
      restored.current.entryId,
      restored.positionMs,
    ], [
      'pause',
      currentId,
      stopped.positionMs,
    ]);
    assertEquals(await server.native(`${home}/queue?view=all`), edited);
    const beforeResume = receivers[0].sessions.length;
    const resumedAt = performance.now();
    await server.native(`${home}/play`, 'POST', {});
    await until(() =>
      receivers[0].sessions.slice(beforeResume).some((s) =>
        s.audioPayloads.length >= 8
      )
    );
    const resumed = receivers[0].sessions.slice(beforeResume).find((s) =>
      s.audioPayloads.length >= 8
    )!;
    assert(
      decodeReceiverAudio(resumed.sdp, resumed.audioPayloads.slice(0, 8)).some(
        (sample) => sample !== 0,
      ),
    );
    const playing = (await server.native(home)).player;
    assertEquals([playing.state, playing.current.entryId], ['play', currentId]);
    assert(playing.positionMs >= stopped.positionMs);
    assert(
      playing.positionMs <=
        stopped.positionMs + performance.now() - resumedAt + 1000,
    );

    // Each copy must reach its destination without restarting Home's transport.
    for (const mode of ['replace', 'add']) {
      const packets = resumed.audioPayloads.length;
      const flushes = resumed.flushes;
      const sessions = receivers[0].sessions.length;
      await server.native(`${home}/queue/copy/${mode}`, 'POST', {
        targetPlayerId: kitchen.id,
      });
      const copied = await server.native(`${destination}/queue?view=all`);
      assertEquals(
        copied.items.map((item: { reference: unknown }) => item.reference),
        Array.from(
          { length: mode === 'replace' ? 1 : 2 },
          () =>
            edited.items.map((item: { reference: unknown }) => item.reference),
        ).flat(),
      );
      assertEquals(await server.native(`${home}/queue?view=all`), edited);
      assertEquals((await server.native(home)).player.state, 'play');
      assertEquals((await server.native(destination)).player.state, 'pause');
      await until(() => resumed.audioPayloads.length >= packets + 8);
      assertEquals([
        receivers[0].sessions.length,
        resumed.flushes,
        resumed.closedAtMs,
      ], [
        sessions,
        flushes,
        null,
      ]);
      assert(
        decodeReceiverAudio(
          resumed.sdp,
          resumed.audioPayloads.slice(packets, packets + 8),
        )
          .some((sample) => sample !== 0),
      );
    }

    // Same-turn HTTP requests cross the real production start/admission boundary.
    await server.native(`${home}/stop`, 'POST', {});
    await until(() =>
      receivers[0].sessions.every((s) => s.closedAtMs !== null)
    );
    const sessionCounts = receivers.map((receiver) => receiver.sessions.length);
    const paths = [home, destination];
    const starts = await Promise.all(
      paths.map((path) => server!.nativeResponse(`${path}/play`, 'POST', {})),
    );
    assertEquals(starts.map((response) => response.status).sort(), [204, 409]);
    const winner = starts.findIndex((response) => response.status === 204);
    const loser = 1 - winner;
    await starts[winner].body?.cancel();
    const busy = await starts[loser].json();
    assertEquals(busy.code, 'airplay_busy');
    assertEquals(busy.owner, {
      id: winner === 0 ? 1 : kitchen.id,
      name: winner === 0 ? 'Home' : 'Kitchen',
    });
    await until(() =>
      receivers[winner].sessions.slice(sessionCounts[winner]).some(
        (s) => s.audioPayloads.length >= 8,
      )
    );
    const winningSession = receivers[winner].sessions.slice(
      sessionCounts[winner],
    ).find(
      (s) => s.audioPayloads.length >= 8,
    )!;
    assert(
      decodeReceiverAudio(
        winningSession.sdp,
        winningSession.audioPayloads.slice(0, 8),
      )
        .some((sample) => sample !== 0),
    );
    assertEquals(receivers[loser].sessions.length, sessionCounts[loser]);
    assertEquals((await server.native(paths[winner])).player.state, 'play');
    assertEquals((await server.native(paths[loser])).player.state, 'pause');
    await server.native(`${paths[winner]}/stop`, 'POST', {});
    await until(() =>
      receivers.every((receiver) =>
        receiver.sessions.every(
          (s) => s.closedAtMs !== null,
        )
      )
    );
  } finally {
    await server?.stop();
    dns.close();
    for (const receiver of receivers) receiver.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('volume cold HTTP: linked deltas, clipping and OwnTone master reach absolute receivers across restart', async () => {
  assert(
    (await Deno.resolveDns('melofon.home', 'A')).every((ip) =>
      !ip.startsWith('127.')
    ),
  );
  const dir = await Deno.makeTempDir({ prefix: 'melofon-volume-boot-' });
  const ids = [...speakerIds, '73588229207'];
  const receivers: Awaited<ReturnType<typeof startFakeRaop>>[] = [];
  let dns: ReturnType<typeof dgram.createSocket> | undefined;
  let server: Awaited<ReturnType<typeof boot>> | undefined;
  // Observe the real SET_PARAMETER consumer. The unchanged native adapter maps
  // each absolute 0-100 number to -30..0 dB; no player multiplier belongs here.
  const received = async (volumes: number[]) => {
    await until(() =>
      receivers.every((receiver, i) => {
        const text = receiver.sessions.at(-1)?.volumeParams.at(-1);
        return text !== undefined &&
          Math.abs(Number(text.split(':')[1]) - (volumes[i] * 0.3 - 30)) <
            0.001;
      })
    );
  };
  const levels = async () => {
    const { speakers } = await server!.native('/speakers');
    return ids.map((id) =>
      speakers.find((speaker: { id: string }) => speaker.id === id).volume
    );
  };
  const check = async (slider: number, volumes: number[]) => {
    assertEquals((await server!.native('/players/1')).player.volume, slider);
    assertEquals(await levels(), volumes);
    assertEquals((await server!.own('/player')).volume, Math.max(...volumes));
    await received(volumes);
  };
  try {
    for (const _id of ids) {
      receivers.push(await startFakeRaop({ captureAudio: true }));
    }
    dns = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    await advertise(dns, receivers, ids);
    await speakerMedia(dir);
    const store = await openStore(`${dir}/db`);
    let songId = '';
    try {
      await createLibraries(store).add('Music', `${dir}/media`);
      await scanLibrary(store);
      const [song] = await createLibrary(store).listSongs({
        offset: 0,
        size: 1,
      });
      assert(song);
      songId = song.id;
      for (const [i, receiver] of receivers.entries()) {
        await store.speakers.saveAdopted({
          id: ids[i],
          name: `Room ${i}`,
          type: 'AirPlay',
          host: '127.0.0.1',
          port: receiver.port,
          receiverIdentity: ids[i],
          selected: true,
          volume: 100,
          connectionStrategy: 'owntone',
        });
      }
    } finally {
      await store.close();
    }
    server = await boot(`${dir}/db`);
    await server.native('/players/1/volume', 'PUT', { volume: 40 });
    for (const [i, volume] of [40, 20, 75].entries()) {
      await server.native(`/speakers/${ids[i]}/volume`, 'PUT', { volume });
    }
    await server.native(`/players/1/speakers/${ids[2]}`, 'PATCH', {
      linked: false,
    });
    await server.native('/players/1/queue/items', 'POST', {
      references: [{ kind: 'song', id: songId }],
      startPlaying: true,
    });
    await check(40, [40, 20, 75]);
    await until(() =>
      receivers.every((receiver) =>
        receiver.sessions.at(-1)!.audioPayloads.length >= 8
      )
    );
    for (const receiver of receivers) {
      const session = receiver.sessions.at(-1)!;
      assert(
        decodeReceiverAudio(session.sdp, session.audioPayloads.slice(0, 8))
          .some((sample) => sample !== 0),
      );
    }
    await server.native('/players/1/volume', 'PUT', { volume: 60 });
    await check(60, [60, 40, 75]);

    // Leave headroom on the slider but not on the speakers. Clipping destroys
    // their 20-point balance; a reverse gesture must not secretly restore it.
    for (const [i, volume] of [90, 70].entries()) {
      await server.native(`/speakers/${ids[i]}/volume`, 'PUT', { volume });
    }
    await check(60, [90, 70, 75]);
    await server.native('/players/1/volume', 'PUT', { volume: 90 });
    await check(90, [100, 100, 75]);
    await server.native('/players/1/volume', 'PUT', { volume: 70 });
    await check(70, [80, 80, 75]);

    await server.native('/players/1/stop', 'POST', {});
    await until(() =>
      receivers.every((receiver) =>
        receiver.sessions.every((session) => session.closedAtMs !== null)
      )
    );
    await server.stop();
    const sessionCounts = receivers.map((receiver) => receiver.sessions.length);
    server = await boot(`${dir}/db`);
    const restored = (await server.native('/players/1')).player;
    assertEquals(restored.volume, 70);
    assertEquals(
      ids.map((id) =>
        restored.speakers.find((speaker: { id: string }) => speaker.id === id)
          .linked
      ),
      [true, true, false],
    );
    assertEquals(await levels(), [80, 80, 75]);
    assertEquals((await server.own('/player')).volume, 80);
    await server.native('/players/1/play', 'POST', {});
    await until(() =>
      receivers.every((receiver, i) =>
        receiver.sessions.slice(sessionCounts[i]).some((session) =>
          session.audioPayloads.length >= 8
        )
      )
    );
    await check(70, [80, 80, 75]);
    for (const [i, receiver] of receivers.entries()) {
      const session = receiver.sessions.slice(sessionCounts[i]).find((
        session,
      ) => session.audioPayloads.length >= 8)!;
      assert(
        decodeReceiverAudio(session.sdp, session.audioPayloads.slice(0, 8))
          .some((sample) => sample !== 0),
      );
    }
    // OwnTone translates from the loudest 80, not the saved slider's 70.
    await server.own('/player/volume?volume=85', 'PUT');
    await check(75, [85, 85, 75]);
    await server.native('/players/1/stop', 'POST', {});
    await until(() =>
      receivers.every((receiver) =>
        receiver.sessions.every((session) => session.closedAtMs !== null)
      )
    );
  } finally {
    await server?.stop();
    dns?.close();
    for (const receiver of receivers) receiver.close();
    await Deno.remove(dir, { recursive: true });
  }
});
