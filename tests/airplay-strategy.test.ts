// Behavioral intent/strategy regressions, no devices, DB or native library.
import { assert, assertEquals } from '@std/assert';
import { createNotify } from '../src/notify.ts';
import { createOutputs, createPlayer } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';
import { createSpeakers } from '../src/speakers.ts';
import { apiFixture } from './helpers/api.ts';
import type { Library, SongRow } from '../src/library.ts';
import type { NowPlaying } from '../src/nowplaying.ts';
import type { Media } from '../src/media.ts';
import type { State } from '../src/state.ts';
import { createAirplayDevices } from '../src/boots/airplay-device.ts';
import type { MdnsResolver } from '../src/mdns-resolver.ts';
import type { MdnsService } from '../src/mdns.ts';
import {
  createTestAirplayDevices,
  recordingSpawn,
} from './helpers/airplay-devices.ts';
import {
  type AirplayTransport,
  createAirplayBoot,
  type HelperEventFn,
  parseRetryBackoff,
} from '../src/boots/airplay.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn: () => boolean, timeout = 2000) {
  const end = performance.now() + timeout;
  while (!fn()) {
    assert(performance.now() < end, 'condition reached within bound');
    await sleep(2);
  }
}
function song(id = 'song'): SongRow {
  return {
    id,
    path: `/fixture/${id}`,
    fileName: id,
    title: id,
    durationMs: 3_600_000,
    libraryId: null,
    libraryPath: null,
    albumId: null,
    albumName: null,
    albumFolderName: null,
    artistId: null,
    artistName: null,
    track: 1,
    disc: 1,
    size: 1,
    genre: null,
    year: null,
    firstSeenMs: null,
    isVideo: false,
    suffix: 'mp3',
    contentType: 'audio/mpeg',
  };
}
class Transport implements AirplayTransport {
  static feed: Transport | null = null;
  commands: Record<string, unknown>[] = [];
  writes: number[] = [];
  dropped = 0;
  generation = 0;
  closed = false;
  closeGate: Promise<void> | null = null;
  pcmGate: Promise<void> | null = null;
  pcmEntered = 0;
  afterClose: (() => Promise<void>) | null = null;
  sendError: string | null = null;
  constructor(readonly event: HelperEventFn) {}
  send(c: Record<string, unknown>) {
    this.commands.push(c);
    if (c.cmd === this.sendError) {
      return Promise.reject(new Error('injected enqueue failure'));
    }
    return Promise.resolve();
  }
  ownsSharedFeed() {
    return Transport.feed === this;
  }
  cancelPcm() {
    this.generation++;
  }
  async pcm(data: Uint8Array) {
    const generation = this.generation;
    this.pcmEntered++;
    if (this.pcmGate) await this.pcmGate;
    if (this.closed || generation !== this.generation) return;
    if (!Transport.feed) Transport.feed = this;
    if (Transport.feed === this) this.writes.push(data[0]);
    else this.dropped++;
    return Promise.resolve();
  }
  async close() {
    if (this.closeGate) await this.closeGate;
    this.closed = true;
    if (Transport.feed === this) Transport.feed = null;
    if (this.afterClose) await this.afterClose();
  }
}
function setup(backoff = [0, 20], finite = false, opts: {
  state?: State;
  decode?: Media['decodePcm'];
  spawnFailure?: boolean;
  resolver?: MdnsResolver;
} = {}) {
  Transport.feed = null;
  const notify = createNotify();
  const outputs = createOutputs({ notify });
  const player = createPlayer();
  const playback = createPlayback({
    player,
    notify,
    library: {} as Library,
    nowPlaying: {} as NowPlaying,
    cfg: {},
  });
  const decoded: { path: string; start?: number }[] = [];
  const media = {
    decodePcm: opts.decode ?? ((path: string, opts?: { startMs?: number }) => {
      decoded.push({ path, start: opts?.startMs });
      const tag = decoded.length;
      return Promise.resolve({
        async *[Symbol.asyncIterator]() {
          for (let n = 0; n < (finite ? 2 : 100000); n++) {
            await sleep(2);
            yield new Uint8Array(64).fill(tag);
          }
        },
      });
    }),
  } as unknown as Media;
  const transports: Transport[] = [];
  const spawn = recordingSpawn((event) => {
    const t = new Transport(event);
    transports.push(t);
    if (opts.spawnFailure) throw new Error('injected spawn failure');
    return t;
  });
  const devices = opts.resolver
    ? createAirplayDevices({ outputs, spawn, resolver: opts.resolver })
    : createTestAirplayDevices(outputs, spawn);
  const boot = createAirplayBoot({
    outputs,
    playback,
    notify,
    media,
    ...(opts.state ? { state: opts.state } : { retryBackoffMs: backoff }),
    devices,
  });
  const register = (
    id: string,
    connectionStrategy: 'melofon' | 'owntone' | 'audiostation' = 'melofon',
  ) =>
    outputs.register({
      id,
      connectionStrategy,
      type: 'AirPlay',
      host: `192.0.2.${id}`,
      name: id,
      selected: true,
      volume: 100,
    });
  return {
    outputs,
    notify,
    playback,
    transports,
    decoded,
    register,
    speakers: createSpeakers({
      outputs,
      playback,
      adapterView: devices.describe,
      retry: boot.retry,
    }),
    close: async () => {
      await boot.close();
      devices.close();
      playback.close();
    },
  };
}

Deno.test('strategy retry units: tokens are seconds, boot table is milliseconds', () => {
  assertEquals(parseRetryBackoff(null), [
    0,
    2000,
    5000,
    10000,
    20000,
    30000,
    60000,
  ]);
  assertEquals(parseRetryBackoff('2,70'), [2000, 60000]);
});

Deno.test('boot close awaits late PCM acquisition and returns its unstarted iterator without delivering bytes', async () => {
  let release!: (stream: AsyncIterable<Uint8Array>) => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => entered = resolve);
  const held = new Promise<AsyncIterable<Uint8Array>>((resolve) =>
    release = resolve
  );
  let returned = false, next = 0, closed = false;
  const stream = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          next++;
          return Promise.resolve({
            done: false as const,
            value: new Uint8Array(4),
          });
        },
        return() {
          returned = true;
          return Promise.resolve({ done: true as const, value: undefined });
        },
      };
    },
  };
  const s = setup([], false, {
    decode: () => {
      entered();
      return held;
    },
  });
  try {
    s.register('1');
    s.playback.queueAdd([song()], { play: true });
    await until(() => s.transports.length === 1);
    s.transports[0].event('state', 'connected');
    await ready;
    const closing = s.close().then(() => {
      closed = true;
    });
    await sleep(10);
    assert(!closed, 'Boot closed before its decoder acquisition settled');
    release(stream);
    await closing;
    assert(returned, 'Revoked acquisition was not released');
    assertEquals(next, 0, 'Revoked decoder was advanced');
    assertEquals(s.transports[0].writes.length, 0);
  } finally {
    release(stream);
    await s.close();
  }
});

Deno.test('source election precedes acquisition: two connected outputs open only one decoder', async () => {
  let release!: (stream: AsyncIterable<Uint8Array>) => void;
  const held = new Promise<AsyncIterable<Uint8Array>>((resolve) =>
    release = resolve
  );
  let acquisitions = 0, returns = 0;
  const stream = {
    [Symbol.asyncIterator]() {
      return {
        next: () => Promise.resolve({ done: true as const, value: undefined }),
        return() {
          returns++;
          return Promise.resolve({ done: true as const, value: undefined });
        },
      };
    },
  };
  const s = setup([], false, {
    decode: () => {
      acquisitions++;
      return held;
    },
  });
  try {
    s.register('1');
    s.register('2');
    s.playback.queueAdd([song()], { play: true });
    await until(() => s.transports.length === 2);
    for (const t of s.transports) t.event('state', 'connected');
    await until(() => acquisitions > 0);
    assertEquals(
      acquisitions,
      1,
      'election happens before the first PCM/feed token',
    );
    s.playback.pause();
    release(stream);
    await s.close();
    assertEquals(
      returns,
      1,
      'the canceled acquisition is released without next',
    );
    assertEquals(s.transports.reduce((n, t) => n + t.pcmEntered, 0), 0);
  } finally {
    release(stream);
    await s.close();
  }
});

Deno.test('one shared source failure retires both outputs without reopening or speaker retries', async () => {
  let fail!: (error: Error) => void;
  let acquisitions = 0;
  const held = new Promise<AsyncIterable<Uint8Array>>((_, reject) =>
    fail = reject
  );
  const s = setup([0], false, {
    decode: () => {
      acquisitions++;
      return held;
    },
  });
  try {
    s.register('1');
    s.register('2');
    s.playback.queueAdd([song()], { play: true });
    await until(() => s.transports.length === 2);
    for (const t of s.transports) t.event('state', 'connected');
    assertEquals(acquisitions, 1);
    fail(new Error('shared source failed'));
    await until(() => s.transports.every((t) => t.closed));
    await sleep(30);
    assertEquals(acquisitions, 1);
    assertEquals(
      s.transports.length,
      2,
      'content failure is not speaker recovery',
    );
    assertEquals(s.playback.playerView().state, 'pause');
    assertEquals(s.playback.queueView().items.length, 1);
  } finally {
    fail?.(new Error('cleanup'));
    await s.close();
  }
});

Deno.test('failed feed release cannot elect a peer or reopen the shared source', async () => {
  const s = setup([]);
  try {
    s.register('1');
    s.register('2', 'owntone');
    s.playback.queueAdd([song()], { play: true });
    await until(() => s.transports.length === 2);
    const [a, b] = s.transports;
    a.event('state', 'connected');
    await until(() => a.ownsSharedFeed());
    b.event('state', 'connected');
    a.close = () => Promise.reject(new Error('native release not proven'));
    s.outputs.update('1', { selected: false });
    await sleep(30);
    s.playback.seek({ positionMs: 60000 });
    await sleep(30);
    assertEquals(
      s.decoded.length,
      1,
      'no source open through a poisoned native feed',
    );
    assertEquals(b.pcmEntered, 0);
    assertEquals(
      s.playback.playerView().state,
      'play',
      'retirement failure does not invent intent',
    );
  } finally {
    await s.close();
  }
});

Deno.test('forget awaits retirement, fences late events and pauses the last target at its bookmark', async () => {
  const s = setup();
  let api: Awaited<ReturnType<typeof apiFixture>> | undefined;
  let release = () => {};
  try {
    s.register('1', 'owntone');
    await s.outputs.adopt('1');
    s.playback.queueAdd([song()], { play: true });
    await until(() => s.transports.length === 1);
    const transport = s.transports[0];
    transport.event('state', 'connected');
    await until(() => transport.writes.length > 0);
    transport.closeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const speakers = createSpeakers({
      outputs: s.outputs,
      playback: s.playback,
      adapterView: () => ({
        preparation: { state: 'unresolved', targetRevision: 1 },
      }),
    });
    api = await apiFixture({
      services: () => Promise.resolve({ speakers, outputs: s.outputs }),
    });
    const { credential } = await api.login('cookie');
    let finished = false;
    const forgotten = api.json(
      '/api/v1/speakers/1',
      'DELETE',
      undefined,
      credential,
    ).then(async (response) => {
      assertEquals(response.status, 204, await response.text());
      finished = true;
    });
    await until(() => s.playback.playerView().state === 'pause');
    assertEquals(finished, false);
    assertEquals(s.playback.playerView().state, 'pause');
    const bookmark = s.playback.playerView().itemProgressMs;
    const writes = transport.writes.length;
    transport.event('state', 'connected');
    transport.event('state', 'failed');
    await sleep(30);
    assertEquals(transport.writes.length, writes);
    assertEquals(s.playback.playerView().itemProgressMs, bookmark);
    assertEquals(s.playback.queueView().items.length, 1);
    release();
    await forgotten;
    assertEquals(transport.closed, true);
    s.outputs.register({
      id: '1',
      type: 'AirPlay',
      name: 'rediscovered',
      host: '192.0.2.1',
      selected: false,
      volume: 100,
    });
    await sleep(80);
    assertEquals(s.outputs.lifetime('1').adopted, false);
    assertEquals(s.transports.length, 1);
    assertEquals(s.playback.playerView().state, 'pause');
  } finally {
    release();
    await api?.close();
    await s.close();
  }
});

Deno.test('forget of one playing target preserves its healthy peer and queue', async () => {
  const s = setup();
  try {
    s.register('1');
    s.register('2');
    await s.outputs.adopt('1');
    s.playback.queueAdd([song()], { play: true });
    await until(() => s.transports.length === 2);
    for (const transport of s.transports) transport.event('state', 'connected');
    await until(() => s.transports.some((t) => t.writes.length > 0));
    const removed = s.transports.find((t) =>
      t.commands.some((c) => c.host === '192.0.2.1')
    )!;
    const peer = s.transports.find((t) =>
      t.commands.some((c) => c.host === '192.0.2.2')
    )!;
    const speakers = createSpeakers({
      outputs: s.outputs,
      playback: s.playback,
      adapterView: () => ({
        preparation: { state: 'unresolved', targetRevision: 1 },
      }),
    });
    await speakers.forget('1');
    assertEquals(removed.closed, true);
    assertEquals(peer.closed, false);
    assertEquals(s.outputs.get('2')?.selected, true);
    assertEquals(s.playback.playerView().state, 'play');
    const delivered = peer.writes.length;
    await until(() => peer.writes.length > delivered);
    assertEquals(s.playback.queueView().items.length, 1);
  } finally {
    await s.close();
  }
});
Deno.test('default and AudioStation retire unknown-model sessions on Pause and reconnect at latest position', async () => {
  for (const choice of ['melofon', 'audiostation'] as const) {
    const s = setup();
    try {
      s.register('1', choice);
      s.playback.queueAdd([song()], { play: true });
      await until(() => s.transports.length === 1);
      const old = s.transports[0];
      old.event('state', 'connected');
      await until(() => old.writes.length > 0);
      s.playback.pause();
      await until(() => old.closed);
      assertEquals(old.commands.filter((c) => c.cmd === 'flush').length, 0);
      s.playback.play();
      await until(() => s.transports.length === 2);
      const t = s.transports[1];
      assertEquals(t.writes.length, 0);
      t.event('state', 'connected');
      await until(() => t.writes.length > 0);
      assertEquals(s.playback.queueView().items.length, 1);
      assertEquals(s.outputs.get('1')?.selected, true);
    } finally {
      await s.close();
    }
  }
});
Deno.test('failure → explicit no-op Pause revokes the retry resume lease', async () => {
  const s = setup([50]);
  try {
    s.register('1');
    s.playback.queueAdd([song()], { play: true });
    await until(() => s.transports.length === 1);
    const t = s.transports[0];
    t.event('state', 'failed');
    assertEquals(s.playback.playerView().state, 'pause');
    s.playback.pause();
    s.playback.setVolume({ volume: 60 });
    await sleep(100);
    assertEquals(s.playback.playerView().state, 'pause');
    assertEquals(s.transports.length, 1);
  } finally {
    await s.close();
  }
});
Deno.test('connected/failed flaps exhaust one epoch and preserve selection; explicit repeated Play rearms', async () => {
  const s = setup([0]);
  try {
    s.register('1');
    s.playback.queueAdd([song()], { play: true });
    await until(() => s.transports.length === 1);
    s.transports[0].event('state', 'connected');
    s.transports[0].event('state', 'failed');
    await until(() => s.transports.length === 2);
    s.transports[1].event('state', 'connected');
    s.transports[1].event('state', 'failed');
    await sleep(100);
    assertEquals(s.transports.length, 2);
    assertEquals(s.outputs.get('1')?.selected, true);
    s.playback.play();
    await until(() => s.transports.length === 3);
  } finally {
    await s.close();
  }
});
Deno.test('retry-owned Play authorizes only its target, not an exhausted/down selected peer', async () => {
  const s = setup([20]);
  try {
    s.register('1');
    s.register('2');
    s.playback.queueAdd([song()], { play: true });
    await until(() => s.transports.length === 2);
    const [a, b] = s.transports;
    a.event('state', 'connected');
    b.event('state', 'connected');
    b.event('state', 'failed');
    await until(() => s.transports.length === 3);
    s.transports[2].event('state', 'connected');
    s.transports[2].event('state', 'failed');
    await sleep(60);
    a.event('state', 'failed');
    await until(() => s.transports.length === 4);
    await sleep(60);
    assertEquals(
      s.transports.filter((t) => t.commands.some((c) => c.host === '192.0.2.2'))
        .length,
      2,
    );
    s.playback.pause();
    await sleep(120);
    assertEquals(s.playback.playerView().state, 'pause');
    assertEquals(s.transports.length, 4);
  } finally {
    await s.close();
  }
});
Deno.test('core speaker retry renews only its failed demand with another bounded budget', async () => {
  const s = setup([0]);
  const forId = (id: string) =>
    s.transports.filter((t) =>
      t.commands.some((c) => c.host === `192.0.2.${id}`)
    );
  try {
    s.register('1');
    s.register('2');
    s.playback.queueAdd([song()], { play: true });
    await until(() => s.transports.length === 2);
    for (const transport of s.transports) transport.event('state', 'connected');
    for (const id of ['1', '2']) {
      forId(id)[0].event('state', 'failed');
      await until(() => forId(id).length === 2);
      forId(id)[1].event('state', 'connected');
      forId(id)[1].event('state', 'failed');
    }
    await sleep(50);
    assertEquals(s.playback.playerView().state, 'pause');
    assertEquals(s.transports.length, 4);
    const row = await s.speakers.retry('1');
    assertEquals(row.adopted, false);
    assert(row.state.connection !== 'connected');
    await until(() => forId('1').length === 3);
    forId('1')[2].event('state', 'failed');
    await until(() => forId('1').length === 4);
    forId('1')[3].event('state', 'failed');
    for (let i = 0; i < 3; i++) {
      s.register('1');
      s.speakers.get('1');
    }
    await sleep(100);
    assertEquals(forId('1').length, 4);
    assertEquals(
      forId('2').length,
      2,
      'retry does not grant authority to exhausted peers',
    );
    assertEquals(s.playback.playerView().state, 'pause');
    assertEquals(s.playback.queueView().items.length, 1);
  } finally {
    await s.close();
  }
});

Deno.test('pause, stop, forget, deselect and endpoint replacement defeat retry preparation and late activation', async () => {
  for (
    const change of ['pause', 'stop', 'forget', 'deselect', 'endpoint'] as const
  ) {
    let hold = false, complete!: (row: MdnsService) => void;
    let signal: AbortSignal | undefined;
    const receiver: MdnsService = {
      name: '001122334455@Retry._raop._tcp.local',
      host: 'fixture.local',
      address: '192.0.2.1',
      port: 7000,
      ttlMs: 60000,
      txt: { tp: 'UDP', sr: '44100', ss: '16', ch: '2' },
    };
    const s = setup([], true, {
      resolver: {
        resolve(_host, _port, abort) {
          if (!hold) return Promise.resolve(receiver);
          signal = abort;
          return new Promise<MdnsService>((yes) => complete = yes);
        },
        close() {},
      },
    });
    try {
      s.register('1');
      await s.outputs.adopt('1');
      s.playback.queueAdd([song()], { play: true });
      await until(() => s.transports.length === 1);
      s.transports[0].event('state', 'failed');
      await until(() => s.transports[0].closed);
      hold = true;
      await s.speakers.retry('1');
      await until(() => signal !== undefined);
      if (change === 'pause') s.playback.pause();
      if (change === 'stop') s.playback.stop();
      if (change === 'forget') await s.speakers.forget('1');
      if (change === 'deselect') s.outputs.setEnabled([]);
      if (change === 'endpoint') {
        s.outputs.register({ ...s.outputs.get('1')!, host: '192.0.2.2' });
      }
      assert(signal!.aborted, `${change} cancels the pending lookup`);
      complete(receiver); // A resolver ignoring abort cannot resurrect authority.
      await sleep(50);
      assertEquals(s.transports.length, 1, change);
      assertEquals(s.transports[0].writes.length, 0);
      assertEquals(s.playback.queueView().items.length, 1);
      if (change === 'pause' || change === 'forget') {
        assertEquals(s.playback.playerView().state, 'pause');
      }
      if (change === 'stop') {
        assertEquals(s.playback.playerView().state, 'pause');
      }
    } finally {
      complete?.(receiver);
      await s.close();
    }
  }
});
Deno.test('compound clear+play retires OwnTone held/active session before one replacement', async () => {
  const s = setup();
  let release!: () => void;
  try {
    s.register('1', 'owntone');
    s.playback.queueAdd([song()], { play: true });
    await until(() => s.transports.length === 1);
    const old = s.transports[0];
    old.event('state', 'connected');
    await until(() => old.writes.length > 0);
    s.playback.pause();
    assert(!old.closed);
    old.closeGate = new Promise<void>((resolve) => release = resolve);
    s.playback.queueAdd([song('new')], { clear: true, play: true });
    await sleep(20);
    assertEquals(s.transports.length, 1);
    release();
    await until(() => old.closed && s.transports.length === 2);
    s.transports[1].event('state', 'connected');
    await until(() => s.decoded.some((d) => d.path === '/fixture/new'));
  } finally {
    release?.();
    await s.close();
  }
});
Deno.test('OwnTone Stop retains current but releases transport; Play creates a new session', async () => {
  const s = setup();
  try {
    s.register('1', 'owntone');
    s.playback.queueAdd([song(), song('b')], { play: true });
    await until(() => s.transports.length === 1);
    const t = s.transports[0];
    t.event('state', 'connected');
    await until(() => t.writes.length > 0);
    s.playback.stop();
    assert(s.playback.playerView().current !== null);
    assertEquals(s.playback.playerView().state, 'pause');
    await until(() => t.closed);
    assertEquals(t.commands.filter((c) => c.cmd === 'teardown').length, 1);
    s.playback.play();
    await until(() => s.transports.length === 2);
    s.transports[1].event('state', 'connected');
    await until(() => s.decoded.length === 2);
    assertEquals(s.transports.length, 2);
  } finally {
    await s.close();
  }
});
Deno.test('OwnTone idle hold expires at ten seconds without repeated events extending it', async () => {
  const s = setup();
  try {
    s.register('1', 'owntone');
    s.playback.queueAdd([song()], { play: true });
    await until(() => s.transports.length === 1);
    const t = s.transports[0];
    t.event('state', 'connected');
    const send = t.send.bind(t);
    t.send = (command) => {
      if (command.cmd === 'flush') {
        // Native enqueue can synchronously wait for its queue lock. The
        // idle-entry deadline must not be restarted after that wait.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
      }
      return send(command);
    };
    const entered = performance.now();
    s.playback.pause();
    await sleep(6000);
    s.playback.pause();
    s.outputs.update('1', { volume: 50 });
    await until(
      () => t.closed,
      Math.max(1, 10350 - (performance.now() - entered)),
    );
    assertEquals(s.transports.length, 1);
    assertEquals(t.commands.filter((c) => c.cmd === 'flush').length, 1);
  } finally {
    await s.close();
  }
});
Deno.test('finite source transfers to a peer from current position after feed loss, both iteration orders', async () => {
  for (const reverse of [false, true]) {
    const s = setup([0], true);
    try {
      for (const id of reverse ? ['2', '1'] : ['1', '2']) {
        s.register(id, id === '2' ? 'owntone' : 'melofon');
      }
      s.playback.queueAdd([song()], { play: true });
      await until(() => s.transports.length === 2);
      const a = s.transports.find((t) =>
        t.commands.some((c) => c.host === '192.0.2.1')
      )!;
      const b = s.transports.find((t) =>
        t.commands.some((c) => c.host === '192.0.2.2')
      )!;
      a.event('state', 'connected');
      await until(() => a.ownsSharedFeed());
      b.event('state', 'connected');
      await until(() => a.writes.length === 2);
      await sleep(20);
      assertEquals(
        s.decoded.length,
        1,
        'one source even after its nonempty EOF',
      );
      assertEquals(b.dropped, 0, 'no redundant peer decoder');
      assertEquals(b.writes.length, 0);
      const before = s.decoded.length;
      s.outputs.update('1', { selected: false });
      await until(() => b.writes.length > 0);
      assert(
        s.decoded.length > before,
        'fresh current-position decode after finite dropped EOF',
      );
    } finally {
      await s.close();
    }
  }
});
Deno.test('ordinary nonempty decoder EOF remains live for buffered audio', async () => {
  const s = setup([0], true);
  try {
    s.register('1');
    s.playback.queueAdd([song()], { play: true });
    await until(() => s.transports.length === 1);
    s.transports[0].event('state', 'connected');
    await until(() => s.transports[0].writes.length === 2);
    await sleep(30);
    assert(!s.transports[0].closed, 'buffered tail survives normal EOF');
  } finally {
    await s.close();
  }
});

Deno.test('current decoder null/empty/creation/iterator errors release without content-error redial', async () => {
  const decoders: Media['decodePcm'][] = [
    () => Promise.resolve(null),
    () => Promise.reject(new Error('decoder creation failed')),
    () => Promise.resolve({ async *[Symbol.asyncIterator]() {} }),
    () =>
      Promise.resolve({
        async *[Symbol.asyncIterator]() {
          yield await Promise.reject(new Error('iterator failed'));
        },
      }),
  ];
  for (const decode of decoders) {
    const s = setup([0], false, { decode });
    try {
      s.register('1');
      s.playback.queueAdd([song()], { play: true });
      await until(() => s.transports.length === 1);
      s.transports[0].event('state', 'connected');
      await until(() => s.transports[0].closed);
      await sleep(30);
      assertEquals(s.transports.length, 1);
      assertEquals(s.playback.playerView().state, 'pause');
      assertEquals(s.outputs.get('1')?.selected, true);
    } finally {
      await s.close();
    }
  }
});

Deno.test('stale decoder rejection cannot pause or retire its replacement', async () => {
  let reject!: (error: Error) => void;
  let calls = 0;
  const s = setup([0], false, {
    decode: () => {
      if (++calls === 1) return new Promise((_, no) => reject = no);
      return Promise.resolve({
        async *[Symbol.asyncIterator]() {
          yield new Uint8Array([9]);
        },
      });
    },
  });
  try {
    s.register('1');
    s.playback.queueAdd([song()], { play: true });
    await until(() => s.transports.length === 1);
    s.transports[0].event('state', 'connected');
    await until(() => calls === 1);
    s.playback.seek({ positionMs: 60000 });
    await until(() => s.transports.length === 2);
    s.transports[1].event('state', 'connected');
    await until(() => s.transports[1].writes.length > 0);
    reject(new Error('obsolete decoder failed'));
    await sleep(20);
    assert(!s.transports[1].closed);
    assertEquals(s.playback.playerView().state, 'play');
  } finally {
    reject?.(new Error('cleanup'));
    await s.close();
  }
});

Deno.test('user Pause synchronously during retry-owned Play wins, including same-millisecond records', async () => {
  const realNow = Date.now;
  Date.now = () => 123;
  const s = setup([0]);
  const off = s.notify.subscribe(() => {
    const command = s.playback.lastCommand();
    if (command?.kind === 'play' && command.source.via === 'airplay-boot') {
      s.playback.pause();
    }
  });
  try {
    s.register('1');
    s.playback.queueAdd([song()], { play: true });
    await until(() => s.transports.length === 1);
    s.transports[0].event('state', 'failed');
    await sleep(50);
    assertEquals(s.transports.length, 1);
    assertEquals(s.playback.playerView().state, 'pause');
    assertEquals(s.playback.lastCommand()?.source.via, undefined);
  } finally {
    Date.now = realNow;
    off();
    await s.close();
  }
});

Deno.test('switch during Play waits for transition; switch during OwnTone hold retires now', async () => {
  const s = setup();
  try {
    s.register('1', 'owntone');
    s.playback.queueAdd([song()], { play: true });
    await until(() => s.transports.length === 1);
    const t = s.transports[0];
    t.event('state', 'connected');
    await until(() => t.writes.length > 0);
    s.outputs.update('1', { connectionStrategy: 'melofon' });
    await sleep(20);
    assert(!t.closed);
    s.playback.seek({ positionMs: 60000 });
    await until(() => t.closed && s.transports.length === 2);
    const fresh = s.transports[1];
    fresh.event('state', 'connected');
    s.outputs.update('1', { connectionStrategy: 'owntone' });
    s.playback.pause();
    assert(!fresh.closed);
    s.outputs.update('1', { connectionStrategy: 'audiostation' });
    await until(() => fresh.closed);
    s.outputs.update('1', { connectionStrategy: 'owntone' });
    await sleep(20);
    assertEquals(s.transports.length, 2);
  } finally {
    await s.close();
  }
});

Deno.test('canceled owner PCM cannot claim a free token when acquisition precedes the first write', async () => {
  const s = setup([0], true);
  let release!: () => void;
  try {
    s.register('1');
    s.register('2', 'owntone');
    s.playback.queueAdd([song()], { play: true });
    await until(() => s.transports.length === 2);
    const [a, b] = s.transports;
    a.pcmGate = new Promise((resolve) => release = resolve);
    a.event('state', 'connected');
    await until(() => a.pcmEntered === 1);
    b.event('state', 'connected');
    assertEquals(
      b.pcmEntered,
      0,
      'peer never enters PCM before ownership transfer',
    );
    assertEquals(s.decoded.length, 1);
    const oldTag = s.decoded.length;
    a.afterClose = async () => {
      release();
      await sleep(0);
      assertEquals(
        a.writes.length,
        0,
        'canceled write cannot acquire the token',
      );
      assertEquals(b.writes.length, 0);
    };
    s.outputs.update('1', { selected: false });
    await until(() => b.writes.length > 0);
    assert(
      b.writes[0] > oldTag,
      'first effective bytes are fresh decode, never old dropped generation',
    );
  } finally {
    release?.();
    await s.close();
  }
});

Deno.test('reverse snapshot order: all retirement barriers precede sibling transition PCM', async () => {
  for (const ids of [['2', '1'], ['1', '2']]) {
    const s = setup([0]);
    let release!: () => void;
    try {
      for (const id of ids) s.register(id, id === '1' ? 'melofon' : 'owntone');
      // Keep the old implementation's affected-model path active in the
      // negative control, so this exposes ordering, not just the new policy.
      s.outputs.register({ ...s.outputs.get('1')!, model: 'AppleTV3,1' });
      s.playback.queueAdd([song()], { play: true });
      await until(() => s.transports.length === 2);
      const a = s.transports.find((t) =>
        t.commands.some((c) => c.host === '192.0.2.1')
      )!;
      const b = s.transports.find((t) =>
        t.commands.some((c) => c.host === '192.0.2.2')
      )!;
      a.event('state', 'connected');
      await until(() => a.ownsSharedFeed());
      b.event('state', 'connected');
      assertEquals(b.pcmEntered, 0, 'only the elected source writes');
      a.closeGate = new Promise((resolve) => release = resolve);
      const before = b.pcmEntered;
      s.playback.seek({ positionMs: 60000 });
      await sleep(20);
      assertEquals(
        b.pcmEntered,
        before,
        'no sibling transition PCM while any native retirement is pending',
      );
      release();
      await until(() => b.writes.length > 0);
      assert(s.decoded[s.decoded.length - 1].start! >= 60000);
    } finally {
      release?.();
      await s.close();
    }
  }
});

function settings(initial: Promise<string | null>) {
  let listener: (key: string, value: string | null) => void = () => {};
  return {
    state: {
      declare() {},
      get: () => initial,
      onChange: (fn: typeof listener) => {
        listener = fn;
        return () => {};
      },
    } as unknown as State,
    change: (value: string) => listener('airplay.retry', value),
  };
}
Deno.test('retry initial read is a barrier, late reads cannot override live off, and read failure disables retries', async () => {
  for (const failure of [false, true]) {
    let resolve!: (value: string | null) => void,
      reject!: (error: Error) => void;
    const setting = settings(
      new Promise((ok, no) => {
        resolve = ok;
        reject = no;
      }),
    );
    const s = setup([0], false, { state: setting.state });
    try {
      s.register('1');
      s.playback.queueAdd([song()], { play: true });
      await until(() => s.transports.length === 1);
      s.transports[0].event('state', 'failed');
      await sleep(20);
      assertEquals(s.transports.length, 1);
      if (failure) reject(new Error('settings unavailable'));
      else {
        setting.change('off');
        resolve('0');
      }
      await sleep(30);
      assertEquals(s.transports.length, 1);
      setting.change('0');
      await until(() => s.transports.length === 2);
    } finally {
      resolve?.(null);
      await s.close();
    }
  }
});
Deno.test('retry-off cancels a pending retry close grant but preserves planned seek replacement', async () => {
  const setting = settings(Promise.resolve('0'));
  const s = setup([0], false, { state: setting.state });
  let release!: () => void;
  try {
    s.register('1');
    s.playback.queueAdd([song()], { play: true });
    await until(() => s.transports.length === 1);
    const t = s.transports[0];
    t.event('state', 'connected');
    t.closeGate = new Promise((resolve) => release = resolve);
    t.event('state', 'failed');
    await sleep(20);
    setting.change('off');
    release();
    await until(() => t.closed);
    await sleep(20);
    assertEquals(s.transports.length, 1);
    s.playback.play();
    await until(() => s.transports.length === 2);
    const next = s.transports[1];
    next.event('state', 'connected');
    await until(() => next.writes.length > 0);
    s.playback.seek({ positionMs: 60000 });
    await until(() => s.transports.length === 3);
  } finally {
    release?.();
    await s.close();
  }
});
Deno.test('spawn failure consumes the finite epoch instead of catalog-driven infinite attempts', async () => {
  const s = setup([0], false, { spawnFailure: true });
  try {
    s.register('1');
    s.playback.queueAdd([song()], { play: true });
    await until(() => s.transports.length === 2);
    await sleep(20);
    s.outputs.update('1', { volume: 60 });
    s.register('1');
    await sleep(20);
    assertEquals(s.transports.length, 2);
    s.outputs.update('1', { selected: true });
    await until(() => s.transports.length === 4);
  } finally {
    await s.close();
  }
});
