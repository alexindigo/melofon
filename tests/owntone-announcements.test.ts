// Original-consumer acceptance: cold main.ts, real OwnTone HTTP/WS and ALAC.
// HA choreography: homeassistant/components/forked_daapd/media_player.py:838-897;
// queue-then-player latch: :343-362. No HA installation or private accounts.
import { assert, assertEquals } from '@std/assert';
import { Buffer } from 'node:buffer';
import dgram from 'node:dgram';
import { dnsQuestions } from '../src/mdns.ts';
import { airplayAnswer } from './mdns-builder.ts';
import { reservePorts } from './helpers/ports.ts';
import { sleep, speakerMedia, until } from './helpers/speaker-consumer.ts';
import { type FakeRaop, startFakeRaop } from './helpers/fake-raop.ts';
import { decodeReceiverAudio } from './helpers/raop-audio-consumer.ts';
import { httpRadio, icyBlock, type RadioReply } from './helpers/http-radio.ts';

interface Item {
  id: number;
  uri: string;
  position: number;
  length_ms: number;
  title: string;
  album?: string;
}
interface Queue {
  version: number;
  count: number;
  items: Item[];
}
interface Player {
  state: string;
  volume: number;
  item_id: number;
  item_progress_ms: number;
  item_length_ms: number;
}
interface Output {
  id: string;
  selected: boolean;
  volume: number;
}

async function eventually(check: () => Promise<boolean>) {
  const end = performance.now() + 30000;
  while (!await check()) {
    assert(performance.now() < end, 'HTTP consumer outcome timed out');
    await sleep(20);
  }
}

/** Each test starts the production composition, not an injected service bag. */
async function boot(dir: string, receiver: FakeRaop) {
  assert(
    (await Deno.resolveDns('melofon.home', 'A')).every((ip) =>
      !ip.startsWith('127.')
    ),
  );
  using ports = reservePorts(2);
  const [port, ownPort] = ports.ports;
  const origin = `http://melofon.home:${port}`;
  const ownOrigin = `http://melofon.home:${ownPort}`;
  // The real adapter acquires receiver facts by legacy-unicast DNS-SD even
  // with automatic browsing off. Supply that wire surface as well as RTSP.
  const dns = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  await new Promise<void>((done, reject) => {
    dns.once('error', reject);
    dns.bind(5353, '127.0.0.1', done);
  });
  dns.on('message', (message, peer) => {
    const questions = dnsQuestions(message);
    if (!questions || (message[2] & 0x80) !== 0) return;
    dns.send(
      airplayAnswer({
        instance: '001122334455@HA Receiver._raop._tcp.local',
        host: 'ha-receiver.local',
        address: [127, 0, 0, 1],
        port: receiver.port,
        ttl: 120,
        txt: ['tp=UDP', 'am=AppleTV3,1', 'sr=44100', 'ss=16', 'ch=2'],
        id: new DataView(message.buffer, message.byteOffset).getUint16(0),
        questions,
      }),
      peer.port,
      peer.address,
    );
  });
  const env: Record<string, string> = {};
  for (
    const key of ['HOME', 'PATH', 'DENO_DIR', 'TMPDIR', 'MELOFON_RAOP_LIB']
  ) {
    const value = Deno.env.get(key);
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    MELOFON_DATA: `${dir}/db`,
    MELOFON_USER: 'admin',
    MELOFON_PASSWORD: 'announcement-password',
    MELOFON_SECRET: 'announcement-test-secret',
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
  let credential = '';
  const json = async (
    base: string,
    path: string,
    method = 'GET',
    body?: unknown,
  ) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        ...(credential && base === origin
          ? { Authorization: `Bearer ${credential}` }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    const text = await r.text();
    assert(r.ok, `${method} ${path}: ${r.status} ${text}`);
    return text ? JSON.parse(text) : undefined;
  };
  const own = (path: string, method = 'GET', body?: unknown) =>
    json(ownOrigin, `/api${path}`, method, body);
  const native = (path: string, method = 'GET', body?: unknown) =>
    json(origin, `/api/v1${path}`, method, body);
  const close = async (diagnostics = false) => {
    child.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([
      child.status.then(() => true),
      new Promise<boolean>((done) =>
        timer = setTimeout(() => done(false), 10000)
      ),
    ]);
    clearTimeout(timer);
    if (!exited) child.kill('SIGKILL');
    const status = await child.status;
    const output = await logs;
    dns.close();
    if (diagnostics) console.error(output.join('\n'));
    assert(exited && status.success, output.join('\n'));
  };
  try {
    await eventually(async () => {
      try {
        const r = await fetch(`${origin}/_/health`, {
          signal: AbortSignal.timeout(500),
        });
        return (await r.json()).ok === true;
      } catch {
        return false;
      }
    });
    credential = (await native('/session', 'POST', {
      username: 'admin',
      password: 'announcement-password',
      use: 'bearer',
      deviceName: 'HA acceptance',
    })).key;
    await native('/admin/libraries', 'POST', {
      name: 'Music',
      path: `${dir}/media`,
    });
    await native('/admin/scans', 'POST', { mode: 'full' });
    await eventually(async () =>
      !(await native('/admin/scans/current')).scan.scanning
    );
    const speaker = (await native('/speakers', 'POST', {
      protocol: 'AirPlay',
      address: '127.0.0.1',
      port: receiver.port,
      name: 'HA receiver',
      connectionStrategy: 'owntone',
    })).speaker;
    await own(`/outputs/${speaker.id}`, 'PUT', { selected: true, volume: 37 });
    const albums = await own('/library/albums');
    assertEquals(albums.items.length, 1);
    const tracks = await own(`/library/albums/${albums.items[0].id}/tracks`);
    assertEquals(tracks.items.length, 1);
    const add = (uris: string, options: Record<string, string> = {}) =>
      own(
        `/queue/items/add?${new URLSearchParams({ uris, ...options })}`,
        'POST',
      );
    return {
      own,
      native,
      add,
      close,
      ownOrigin,
      songUri: tracks.items[0].uri as string,
      queue: (): Promise<Queue> => own('/queue'),
      player: (): Promise<Player> => own('/player'),
      outputs: async (): Promise<Output[]> => (await own('/outputs')).outputs,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
type Server = Awaited<ReturnType<typeof boot>>;

function mark(receiver: FakeRaop) {
  return new Map(receiver.sessions.map((s) => [s.id, s.audioPayloads.length]));
}
function audioSince(receiver: FakeRaop, start: ReturnType<typeof mark>) {
  return receiver.sessions.filter((s) =>
    s.audioPayloads.length > (start.get(s.id) ?? 0)
  )
    .map((s) =>
      decodeReceiverAudio(s.sdp, s.audioPayloads.slice(start.get(s.id) ?? 0))
    );
}
function containsAudio(
  receiver: FakeRaop,
  start: ReturnType<typeof mark>,
  pcm: Uint8Array,
) {
  return audioSince(receiver, start).some((audio) => {
    const at = Buffer.from(audio).indexOf(pcm);
    return at >= 0 && at % 4 === 0;
  });
}

/** Observe notifications by refetching the same queue and player HA consumes. */
async function subscribe(t: Server) {
  const ws = new WebSocket(t.ownOrigin.replace('http:', 'ws:') + '/', [
    'notify',
  ]);
  let work = Promise.resolve();
  let requested = false, queued = false, playing = false;
  let frames = 0;
  let pauseCallbacks = 0;
  let first: Queue | undefined;
  const snapshots: Queue[] = [];
  const trace: unknown[] = [];
  ws.onmessage = (event) => {
    const names: string[] = JSON.parse(String(event.data)).notify;
    frames++;
    work = work.then(async () => {
      if (names.includes('queue')) {
        const q = await t.queue();
        trace.push({ queue: q.items.map((i) => i.uri), requested });
        snapshots.push(q);
        if (requested) {
          first = q;
          requested = false;
          queued = true;
        }
      }
      if (names.includes('player')) {
        const p = await t.player();
        if (p.state !== 'play') pauseCallbacks++;
        trace.push({ player: p, queued, first: first?.items[0]?.id });
        if (queued && p.state === 'play' && p.item_id === first?.items[0]?.id) {
          queued = false;
          playing = true;
        }
      }
    });
  };
  await until(() => ws.readyState === WebSocket.OPEN);
  ws.send(JSON.stringify({ notify: ['queue', 'player', 'outputs'] }));
  // A real command/notification handshake establishes that the filter is active.
  await eventually(async () => {
    await t.own('/player/pause', 'PUT');
    await sleep(20);
    return frames > 0;
  });
  return {
    snapshots,
    async pause() {
      const before = pauseCallbacks;
      await t.own('/player/pause', 'PUT');
      await until(() => pauseCallbacks > before);
      await work;
    },
    request() {
      first = undefined;
      playing = false;
      requested = true;
    },
    async started() {
      try {
        await until(() => playing);
      } catch (error) {
        throw new Error(JSON.stringify(trace), { cause: error });
      }
      await work;
      assert(first);
      return first;
    },
    async close() {
      ws.close();
      await until(() => ws.readyState === WebSocket.CLOSED);
      await work;
    },
  };
}

async function speech(dir: string) {
  const wav = (await Deno.readFile(`${dir}/media/signal.wav`)).slice(
    0,
    44 + 1408 * 150,
  );
  const v = new DataView(wav.buffer);
  v.setUint32(4, wav.length - 8, true);
  v.setUint32(40, wav.length - 44, true);
  // Distinct from library/radio and nonperiodic through the final packet.
  for (let at = 44; at < wav.length; at += 2) {
    v.setInt16(at, 7000 + ((at * 31) % 17000), true);
  }
  return { wav, pcm: wav.subarray(44) };
}

async function announce(
  t: Server,
  receiver: FakeRaop,
  ws: Awaited<ReturnType<typeof subscribe>>,
  url: string,
  pcm: Uint8Array,
) {
  const state = (await t.player()).state;
  const pauseTime = sleep(1000);
  await ws.pause();
  const saved = {
    queue: await t.queue(),
    player: await t.player(),
    outputs: await t.outputs(),
    state,
  };
  const position = saved.queue.items.findIndex((i) =>
    i.id === saved.player.item_id
  );
  assert(position >= 0);
  await t.own('/player/volume?volume=71', 'PUT');
  for (const output of saved.outputs) {
    if (output.selected) {
      await t.own(`/outputs/${output.id}`, 'PUT', { volume: 71 });
    }
  }
  const start = mark(receiver);
  ws.request();
  await pauseTime;
  await t.add(url, { clear: 'true', playback: 'start' });
  const first = await ws.started();
  assertEquals(first.count, 1);
  assertEquals(first.items[0].uri, url);
  const duration = Math.round(pcm.length / 176400 * 1000);
  assertEquals(
    first.items[0].length_ms,
    duration,
    'finite length on first HA-consumable queue callback',
  );
  // HA sleeps length_ms + its configured tts_pause_time, not until a test-only
  // drain signal. Assert the entire tail BEFORE any restoring command.
  await sleep(duration + 1000);
  assert(
    containsAudio(receiver, start, pcm),
    'complete speech including final samples before restore',
  );
  const afterSpeech = mark(receiver);
  await t.own(`/player/volume?volume=${saved.player.volume}`, 'PUT');
  for (const output of saved.outputs) {
    await t.own(`/outputs/${output.id}`, 'PUT', {
      selected: output.selected,
      volume: output.volume,
    });
  }
  await t.add(saved.queue.items.map((i) => i.uri).join(','), {
    clear: 'true',
    playback: 'start',
    playback_from_position: String(position),
  });
  await t.own(
    `/player/seek?position_ms=${saved.player.item_progress_ms}`,
    'PUT',
  );
  if (state === 'pause') await t.own('/player/pause', 'PUT');
  if (state === 'stop') await t.own('/player/stop', 'PUT');
  const restored = await t.queue(), player = await t.player();
  assertEquals(
    restored.items.map((i) => i.uri),
    saved.queue.items.map((i) => i.uri),
  );
  assertEquals(player.item_id, restored.items[position].id);
  assertEquals(player.state, state);
  assertEquals(player.volume, saved.player.volume);
  assertEquals(await t.outputs(), saved.outputs);
  assert(
    restored.items.every((i) =>
      !saved.queue.items.some((old) => old.id === i.id)
    ),
  );
  return { saved, player, restored, afterSpeech };
}

for (const state of ['play', 'pause']) {
  Deno.test(`cold OwnTone HA announcement restores finite queue, bookmark, volumes and ${state} state after complete speech`, async () => {
    const dir = await Deno.makeTempDir({ prefix: 'ha-announcement-' });
    const pcm = await speakerMedia(dir);
    const announcement = await speech(dir);
    const radio = httpRadio(() => ({
      headers: { 'content-type': 'audio/wav' },
      body: (async function* () {
        for (let at = 0; at < announcement.wav.length; at += 8192) {
          yield announcement.wav.subarray(at, at + 8192);
          await sleep(2);
        }
      })(),
    }));
    const receiver = await startFakeRaop({
      captureAudio: true,
      recordDelayMs: 200,
    });
    const t = await boot(dir, receiver);
    const ws = await subscribe(t);
    let completed = false;
    try {
      await t.add(`${t.songUri},${t.songUri}`, {
        clear: 'true',
        playback: 'start',
        playback_from_position: '1',
      });
      await until(() =>
        receiver.sessions.some((s) => s.audioPayloads.length >= 10)
      );
      await t.own('/player/seek?position_ms=1300', 'PUT');
      await sleep(100);
      if (state === 'pause') await t.own('/player/pause', 'PUT');
      const restored = await announce(
        t,
        receiver,
        ws,
        `${radio.origin}/tts.wav?text=hello%20home`,
        announcement.pcm,
      );
      assertEquals(restored.restored.items[1].id, restored.player.item_id);
      assert(
        Math.abs(
          restored.player.item_progress_ms -
            restored.saved.player.item_progress_ms,
        ) < 300,
      );
      if (state === 'pause') {
        const progress = restored.player.item_progress_ms;
        await sleep(200);
        assertEquals((await t.player()).item_progress_ms, progress);
        await t.own('/player/play', 'PUT');
      }
      // A resume opens at the saved bookmark. Compare a sample window after
      // that exact frame; acquisition time must not become a second seek.
      const frame = Math.floor(restored.saved.player.item_progress_ms * 44.1);
      await until(() =>
        containsAudio(
          receiver,
          restored.afterSpeech,
          pcm.subarray(frame * 4, frame * 4 + 1408 * 10),
        )
      );
      await t.own('/player/stop', 'PUT');
      await until(() => radio.closed === radio.requests.length);
      completed = true;
    } finally {
      await ws.close();
      await t.close(!completed);
      receiver.close();
      await radio.close();
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test('cold OwnTone ICY radio announces, restores at live edge with no-op seek, reconnects then advances to receiver audio', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'ha-live-' });
  const libraryPcm = await speakerMedia(dir);
  const announcement = await speech(dir);
  const template = await Deno.readFile(`${dir}/media/signal.wav`);
  let epoch = 0, unavailable = false;
  const channels: { epoch: number; change?: () => void; drop?: () => void }[] =
    [];
  const livePcm = (n: number) => {
    const bytes = libraryPcm.slice();
    const view = new DataView(bytes.buffer);
    for (let at = 0; at < bytes.length; at += 2) {
      view.setInt16(at, -9000 - n * 3000 - at % 2000, true);
    }
    return bytes;
  };
  const radio = httpRadio((request, signal): RadioReply => {
    if (new URL(request.url).pathname === '/tts.wav') {
      return {
        headers: { 'content-type': 'audio/wav' },
        body: [announcement.wav],
      };
    }
    if (unavailable) return { statusLine: 'HTTP/1.1 503 Unavailable' };
    const channel: typeof channels[number] = { epoch };
    channels.push(channel);
    const wav = template.slice();
    const view = new DataView(wav.buffer);
    view.setUint32(4, 0xffffffff, true);
    view.setUint32(40, 0xffffffff, true);
    wav.set(livePcm(epoch), 44);
    const wait = (key: 'change' | 'drop') =>
      new Promise<void>((done) => {
        channel[key] = done;
        if (signal.aborted) done();
        else signal.addEventListener('abort', () => done(), { once: true });
      });
    return {
      headers: {
        'content-type': 'audio/wav',
        'icy-name': 'House radio',
        'icy-metaint': '65536',
      },
      body: (async function* () {
        for (let block = 0; block < 8 && !signal.aborted; block++) {
          yield wav.subarray(block * 65536, (block + 1) * 65536);
          yield icyBlock(
            `StreamTitle='Artist - Epoch ${channel.epoch} ${
              block < 4 ? 'A' : 'B'
            }';`,
          );
          if (block === 3) await wait('change');
        }
        if (!signal.aborted) await wait('drop');
      })(),
    };
  });
  const receiver = await startFakeRaop({ captureAudio: true });
  const t = await boot(dir, receiver);
  const ws = await subscribe(t);
  let completed = false;
  try {
    const settings = (await t.native('/admin/settings')).settings;
    const retry = settings.find((s: { key: string }) =>
      s.key === 'playback.source.retryBackoffMs'
    );
    await t.native('/admin/settings', 'PATCH', {
      changes: [{
        key: retry.key,
        revision: retry.revision,
        value: [100, 100, 100],
      }],
    });
    const url = `${radio.origin}/live`;
    await t.add(`${url},${t.songUri}`, { clear: 'true', playback: 'start' });
    await until(() =>
      ws.snapshots.some((q) => q.items[0]?.album === 'Epoch 0 A')
    );
    const initial = (await t.player()).item_id;
    await until(() =>
      containsAudio(receiver, new Map(), livePcm(0).subarray(0, 1408 * 20))
    );
    await until(() => !!channels.at(-1)?.change);
    channels.at(-1)!.change!();
    await until(() =>
      ws.snapshots.some((q) => q.items[0]?.album === 'Epoch 0 B')
    );
    assertEquals((await t.queue()).items[0].title, 'House radio');
    epoch = 1;
    const restored = await announce(
      t,
      receiver,
      ws,
      `${radio.origin}/tts.wav`,
      announcement.pcm,
    );
    assertEquals(restored.player.item_length_ms, 0);
    assert(
      restored.player.item_progress_ms < restored.saved.player.item_progress_ms,
      'restore resets the live clock',
    );
    await until(() =>
      containsAudio(
        receiver,
        restored.afterSpeech,
        livePcm(1).subarray(0, 1408 * 20),
      )
    );
    await until(() =>
      ws.snapshots.some((q) => q.items[0]?.album === 'Epoch 1 A')
    );
    // Observe no-op seek on an established live source, after asynchronous
    // restoration/acquisition completes. It must neither reopen nor flush.
    const beforeSeek = {
      queue: await t.queue(),
      requests: radio.requests.length,
      sessions: receiver.sessions.length,
      flushes: receiver.sessions.reduce((n, s) => n + s.flushes, 0),
    };
    await t.own(
      `/player/seek?position_ms=${restored.saved.player.item_progress_ms}`,
      'PUT',
    );
    await sleep(100);
    assertEquals(await t.queue(), beforeSeek.queue);
    assertEquals(radio.requests.length, beforeSeek.requests);
    assertEquals(receiver.sessions.length, beforeSeek.sessions);
    assertEquals(
      receiver.sessions.reduce((n, s) => n + s.flushes, 0),
      beforeSeek.flushes,
    );
    assertEquals((await t.queue()).items[0].title, 'House radio');
    assert(restored.player.item_id !== initial);
    const active = channels.at(-1)!;
    await until(() => !!active.change);
    active.change!();
    await until(() => !!active.drop);
    epoch = 2;
    const reconnectMark = mark(receiver);
    active.drop!();
    await until(() => channels.at(-1)!.epoch === 2);
    await until(() =>
      containsAudio(receiver, reconnectMark, livePcm(2).subarray(0, 1408 * 20))
    );
    assertEquals(
      (await t.player()).item_id,
      restored.player.item_id,
      'reconnect retains occurrence',
    );
    await until(() =>
      ws.snapshots.some((q) => q.items[0]?.album === 'Epoch 2 A')
    );
    const reconnected = channels.at(-1)!;
    await until(() => !!reconnected.change);
    reconnected.change!();
    await until(() => !!reconnected.drop);
    unavailable = true;
    const advanceMark = mark(receiver);
    reconnected.drop!();
    await eventually(async () =>
      (await t.player()).item_id === restored.restored.items[1].id
    );
    await until(() =>
      containsAudio(receiver, advanceMark, libraryPcm.subarray(0, 1408 * 20))
    );
    assertEquals(
      (await t.queue()).items.map((i) => i.id),
      restored.restored.items.map((i) => i.id),
    );
    assert(
      !('album' in (await t.queue()).items[0]),
      'old broadcast title clears on exhaustion',
    );
    assertEquals(
      radio.requests.filter((r) => new URL(r.url).pathname === '/live').length,
      7,
      'initial prepare/play, restored prepare/play, then three retries total (one succeeds, two fail)',
    );
    await sleep(400);
    assertEquals(
      (await t.player()).item_id,
      restored.restored.items[1].id,
      'exactly one advance',
    );
    await t.own('/player/stop', 'PUT');
    await until(() => radio.closed === radio.requests.length);
    completed = true;
  } finally {
    await ws.close();
    await t.close(!completed);
    receiver.close();
    await radio.close();
    await Deno.remove(dir, { recursive: true });
  }
});
