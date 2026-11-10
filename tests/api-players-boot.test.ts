// Step F acceptance: released storage -> cold main.ts -> HTTP -> receiver audio.
// Simultaneous fixed-player starts are covered by playback-capacity.test.ts and
// household-capacity.test.ts; their HTTP counterpart belongs to Step G/g07.
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
  const json = async (
    base: string,
    path: string,
    method = 'GET',
    body?: unknown,
  ) => {
    const response = await fetch(`${base}${path}`, {
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
    const text = await response.text();
    assert(response.ok, `${method} ${path}: ${response.status} ${text}`);
    return text ? JSON.parse(text) : undefined;
  };
  const native = (path: string, method = 'GET', body?: unknown) =>
    json(origin, `/api/v1${path}`, method, body);
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
      deviceName: 'Step F acceptance',
    })).key;
    return { native, own, stop };
  } catch (error) {
    await stop();
    throw error;
  }
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
            instance: `${
              BigInt(speakerIds[i]).toString(16)
            }@Room ${i}._raop._tcp.local`,
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
  } finally {
    await server?.stop();
    dns.close();
    for (const receiver of receivers) receiver.close();
    await Deno.remove(dir, { recursive: true });
  }
});
