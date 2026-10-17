// tests/airplay-boot.test.ts — the AirPlay boot against a FAKE helper
// transport (no helper binary, no device): unselected play spawns nothing,
// selected + play starts the helper, PCM flows only after the helper
// reports connected (real decodePcm on the fixture), pause flushes, resume
// re-decodes from the engine position, stop / deselect / unregister tear
// down, volume and pin reach the helper, and a helper "password" event
// flips needsAuthKey on the output row.
import { assert, assertEquals } from '@std/assert';
import { openStore } from '../src/store/index.ts';
import { createLibrary, type SongRow } from '../src/library.ts';
import { createMedia, type Media } from '../src/media.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createNotify } from '../src/notify.ts';
import { createOutputs, createPlayer } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';
import type { Log } from '../src/logging.ts';
import { captureLogs, parseLogfmt } from './helpers/logging.ts';
import {
  createTestAirplayDevices,
  recordingSpawn,
} from './helpers/airplay-devices.ts';
import {
  airplayOutputId,
  type AirplayTransport,
  createAirplayBoot,
  type HelperEventFn,
  parseRetryBackoff,
} from '../src/boots/airplay.ts';

const FIXTURE_MP3 =
  'tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3';
const FIXTURE_PCM_BYTES = 176400; // 1 s of s16le/44100/stereo

const HOST = '192.0.2.10';
const ID = airplayOutputId(HOST);

function fixtureSong(): SongRow {
  return {
    id: 'fixture-song-1',
    path: FIXTURE_MP3,
    libraryId: null,
    libraryPath: null,
    title: 'First Song',
    albumId: null,
    albumName: 'Fixture Album',
    albumFolderName: 'Fixture Album',
    artistId: null,
    artistName: 'Fixture Artist',
    track: 1,
    disc: 1,
    durationMs: 1000,
    size: 1,
    genre: null,
    year: null,
    firstSeenMs: null,
    isVideo: false,
    suffix: 'mp3',
    contentType: 'audio/mpeg',
  };
}

interface FakeFrame {
  type: 'cmd' | 'pcm';
  cmd?: Record<string, unknown>;
  bytes?: number;
}

class FakeTransport implements AirplayTransport {
  frames: FakeFrame[] = [];
  closed = false;
  /** Test knobs (plan atv3-session-recycle): a close GATE (a promise the
   * test resolves — deterministic, no wall-clock luck) or a failing
   * native close, to expose retirement-barrier races. Defaults resolve
   * immediately, like the pre-recycle fake. */
  closeGate: Promise<void> | null = null;
  closeError: Error | null = null;
  closeCalls = 0;
  constructor(public onEvent: HelperEventFn) {}
  send(cmd: Record<string, unknown>) {
    this.frames.push({ type: 'cmd', cmd });
    return Promise.resolve();
  }
  pcm(chunk: Uint8Array) {
    this.frames.push({ type: 'pcm', bytes: chunk.length });
    return Promise.resolve();
  }
  ownsSharedFeed() {
    return false;
  }
  cancelPcm() {}
  close() {
    this.closeCalls++;
    return (async () => {
      if (this.closeGate !== null) await this.closeGate;
      // An unproven native cleanup: the handle is leaked, never freed.
      if (this.closeError !== null) throw this.closeError;
      this.closed = true;
    })();
  }
  cmds() {
    return this.frames.filter((f) => f.type === 'cmd').map((f) => f.cmd!);
  }
  pcmBytes() {
    return this.frames.reduce((n, f) => n + (f.bytes ?? 0), 0);
  }
}

/** A test-controlled close gate: the transport's close() cannot complete
 * until release() runs — retirement-window assertions become exact. */
function closeGate(): { gate: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

async function setup(
  overrides: {
    retryBackoffMs?: number[];
    media?: Media;
    retryTimer?:
      import('../src/boots/airplay.ts').AirplayBootDeps['retryTimer'];
  } = {},
) {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-ap-' });
  const store = await openStore(dir);
  const db = store;
  const notify = createNotify();
  const outputs = createOutputs({ notify });
  const player = createPlayer();
  const library = createLibrary(store);
  const playback = createPlayback({
    player,
    nowPlaying: createNowPlaying(store),
    library,
    cfg: {},
    notify,
  });
  const spawned: FakeTransport[] = [];
  const decodeRequests: { path: string; startMs?: number }[] = [];
  const sourceMedia = overrides.media ?? createMedia();
  const media: Media = {
    ...sourceMedia,
    decodePcm(path, opts) {
      decodeRequests.push({ path, startMs: opts?.startMs });
      return sourceMedia.decodePcm(path, opts);
    },
  };
  const devices = createTestAirplayDevices(
    outputs,
    recordingSpawn((onEvent) => {
      const t = new FakeTransport(onEvent);
      spawned.push(t);
      return t;
    }),
  );
  const boot = createAirplayBoot({
    outputs,
    playback,
    media,
    notify,
    devices,
    ...(overrides.retryBackoffMs !== undefined &&
      { retryBackoffMs: overrides.retryBackoffMs }),
    ...(overrides.retryTimer === undefined
      ? {}
      : { retryTimer: overrides.retryTimer }),
  });
  return {
    outputs,
    playback,
    spawned,
    devices,
    async referenceBytes() {
      const request = decodeRequests.at(-1)!;
      const reference = await createMedia().decodePcm(
        request.path,
        request.startMs === undefined
          ? undefined
          : { startMs: request.startMs },
      );
      assert(reference);
      let bytes = 0;
      for await (const chunk of reference) bytes += chunk.length;
      return bytes;
    },
    close: async () => {
      await boot.close();
      devices.close();
      await db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('airplay.retry config parse: default, clamp at 60, off', () => {
  assertEquals(parseRetryBackoff(null), [
    0,
    2000,
    5000,
    10000,
    20000,
    30000,
    60000,
  ]);
  assertEquals(parseRetryBackoff(''), [
    0,
    2000,
    5000,
    10000,
    20000,
    30000,
    60000,
  ]);
  assertEquals(parseRetryBackoff('0,2,700,40'), [0, 2000, 60000, 40000]);
  assertEquals(parseRetryBackoff('off'), null);
  assertEquals(parseRetryBackoff(' OFF '), null);
});

function registerSelected(outputs: ReturnType<typeof createOutputs>) {
  outputs.register({
    id: ID,
    name: 'Kitchen ATV',
    type: 'AirPlay',
    selected: true,
    volume: 100,
    host: HOST,
    connectionStrategy: 'owntone',
  });
}

async function until(
  what: string,
  fn: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!fn()) {
    if (performance.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

Deno.test('unselected play does not spawn the helper', async () => {
  const { outputs, playback, spawned, close } = await setup();
  try {
    outputs.register({
      id: ID,
      name: 'Kitchen ATV',
      type: 'AirPlay',
      selected: false,
      volume: 100,
      host: HOST,
    });
    playback.queueAdd([fixtureSong()], { play: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assertEquals(spawned.length, 0);
  } finally {
    await close();
  }
});

Deno.test('selected + play: start command, then the track as PCM', async () => {
  const { outputs, playback, spawned, close, referenceBytes } = await setup();
  try {
    registerSelected(outputs);
    playback.queueAdd([fixtureSong()], { play: true });
    await until('helper spawned', () => spawned.length === 1);
    const t = spawned[0];
    const start = t.cmds().find((c) => c.cmd === 'start');
    assert(start, 'start command sent');
    assertEquals(start.host, HOST);
    assertEquals(start.port, 7000);
    assertEquals(start.name, 'Kitchen ATV');
    assertEquals(start.volume, 50);
    assertEquals(start.wanted_metadata, 0);
    assertEquals(start.title, 'First Song');
    assertEquals(start.artist, 'Fixture Artist');
    // The session is up: the pump starts (OwnTone's shape — PCM after
    // CONNECTED, not during the handshake).
    t.onEvent('state', 'connected');
    // Every PCM frame comes after the start command on the wire.
    const startIdx = t.frames.findIndex((f) => f.cmd?.cmd === 'start');
    const firstPcmIdx = t.frames.findIndex((f) => f.type === 'pcm');
    assert(firstPcmIdx === -1 || startIdx < firstPcmIdx);
    // Admission may advance the engine clock. Independently decode its
    // actual position, and require the entire resulting tail at the sink.
    const expected = await referenceBytes();
    assert(expected > 0 && expected <= FIXTURE_PCM_BYTES);
    await until('PCM streamed', () => t.pcmBytes() === expected);
  } finally {
    await close();
  }
});

Deno.test('no PCM before the helper reports connected', async () => {
  const realMedia = createMedia();
  let decodeCalls = 0;
  let startMs: number | undefined;
  let decodedBytes = 0;
  let decoded = false;
  const media: Media = {
    ...realMedia,
    async decodePcm(path, opts) {
      decodeCalls++;
      startMs = opts?.startMs;
      const stream = await realMedia.decodePcm(path, opts);
      if (stream === null) return null;
      return (async function* () {
        for await (const chunk of stream) {
          decodedBytes += chunk.length;
          yield chunk;
        }
        decoded = true;
      })();
    },
  };
  const { outputs, playback, spawned, close } = await setup({ media });
  try {
    registerSelected(outputs);
    playback.queueAdd([fixtureSong()], { play: true });
    await until('helper spawned', () => spawned.length === 1);
    const t = spawned[0];
    await until('start sent', () => t.cmds().some((c) => c.cmd === 'start'));
    // Handshake in flight: nothing may be pumped into the buffer yet.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assertEquals(t.pcmBytes(), 0);
    // The session connects: the track flows from the engine position.
    const beforeConnectedMs = playback.playerView().itemProgressMs;
    t.onEvent('state', 'connected');
    const afterConnectedMs = playback.playerView().itemProgressMs;
    await until('remaining PCM decoded', () => decoded);
    assertEquals(decodeCalls, 1);
    assert(startMs !== undefined);
    assert(startMs >= beforeConnectedMs && startMs <= afterConnectedMs);
    assert(decodedBytes > 0 && decodedBytes < FIXTURE_PCM_BYTES);
    assertEquals(
      t.pcmBytes(),
      decodedBytes,
      'the complete decoded tail reaches the transport',
    );
  } finally {
    await close();
  }
});

Deno.test('select while playing starts streaming (the HA flow)', async () => {
  const { outputs, playback, spawned, close } = await setup();
  try {
    outputs.register({
      id: ID,
      name: 'Kitchen ATV',
      type: 'AirPlay',
      selected: false,
      volume: 100,
      host: HOST,
    });
    playback.queueAdd([fixtureSong()], { play: true });
    assertEquals(spawned.length, 0);
    outputs.update(ID, { selected: true });
    await until('helper spawned on select', () => spawned.length === 1);
    spawned[0].onEvent('state', 'connected');
    await until('PCM streamed', () => spawned[0].pcmBytes() > 0);
  } finally {
    await close();
  }
});

Deno.test('OwnTone pause flushes, resume re-decodes, Stop holds; deselect immediately tears down', async () => {
  const { outputs, playback, spawned, close, referenceBytes } = await setup();
  try {
    registerSelected(outputs);
    playback.queueAdd([fixtureSong()], { play: true });
    await until('helper spawned', () => spawned.length === 1);
    spawned[0].onEvent('state', 'connected');
    const expected = await referenceBytes();
    assert(expected > 0 && expected <= FIXTURE_PCM_BYTES);
    await until(
      'PCM streamed',
      () => spawned[0]?.pcmBytes() === expected,
    );
    const t = spawned[0];

    playback.pause();
    assert(t.cmds().some((c) => c.cmd === 'flush'), 'pause sends flush');

    playback.play(); // resume → the fixture decodes again from ~position
    const before = t.pcmBytes();
    await until('resume re-streams', () => t.pcmBytes() > before);

    playback.stop();
    assertEquals(playback.playerView().current, null);
    assert(!t.closed, 'OwnTone Stop starts its bounded quick-restart hold');
    outputs.update(ID, { selected: false });
    await until(
      'teardown',
      () => t.cmds().some((c) => c.cmd === 'teardown') && t.closed,
    );
  } finally {
    await close();
  }
});

Deno.test('volume and pin reach the helper; password event sets needsAuthKey', async () => {
  const { outputs, playback, spawned, close } = await setup();
  try {
    registerSelected(outputs);
    playback.queueAdd([fixtureSong()], { play: true });
    await until('helper spawned', () => spawned.length === 1);
    const t = spawned[0];

    playback.setVolume({ volume: 33 });
    await until(
      'master volume cmd',
      () => t.cmds().some((c) => c.cmd === 'volume' && c.volume === 33),
    );

    playback.setVolume({ volume: 100 });
    await until(
      'master 100',
      () => t.cmds().some((c) => c.cmd === 'volume' && c.volume === 100),
    );
    outputs.update(ID, { volume: 42 });
    await until(
      'volume cmd',
      () => t.cmds().some((c) => c.cmd === 'volume' && c.volume === 42),
    );

    outputs.update(ID, { pin: '1234' });
    await until(
      'pin cmd',
      () => t.cmds().some((c) => c.cmd === 'pin' && c.pin === '1234'),
    );

    assertEquals(outputs.get(ID)!.needsAuthKey, undefined);
    t.onEvent('state', 'password');
    assertEquals(outputs.get(ID)!.needsAuthKey, true);
  } finally {
    await close();
  }
});

Deno.test('deselect and unregister tear the helper down', async () => {
  const { outputs, playback, spawned, close } = await setup();
  try {
    registerSelected(outputs);
    playback.queueAdd([fixtureSong()], { play: true });
    await until('helper spawned', () => spawned.length === 1);
    const t = spawned[0];

    outputs.update(ID, { selected: false });
    await until('teardown on deselect', () => t.closed);

    // Again for unregister.
    registerSelected(outputs);
    outputs.update(ID, { selected: true }); // Catalog registration is not a grant.
    await until('respawned', () => spawned.length === 2);
    const t2 = spawned[1];
    outputs.unregister(ID);
    await until('teardown on unregister', () => t2.closed);
    assert(t2.cmds().some((c) => c.cmd === 'teardown'));
  } finally {
    await close();
  }
});

Deno.test('mDNS-derived devtype/encrypt ride the admitted start command', async () => {
  const { outputs, playback, spawned, devices, close } = await setup();
  try {
    outputs.register({
      id: ID,
      name: 'Kitchen ATV',
      type: 'AirPlay',
      selected: true,
      volume: 100,
      host: HOST,
    });
    devices.observe(ID, {
      name: '001122334455@Kitchen ATV._raop._tcp.local',
      host: 'fixture.local',
      address: HOST,
      port: 7000,
      ttlMs: 120000,
      txt: { tp: 'UDP', am: 'AirPort10,1', ek: '1' },
    });
    playback.queueAdd([fixtureSong()], { play: true });
    await until('helper spawned', () => spawned.length === 1);
    const start = spawned[0].cmds().find((c) => c.cmd === 'start')!;
    assertEquals(start.devtype, 'apex3');
    assertEquals(start.encrypt, true);
  } finally {
    await close();
  }
});

Deno.test('a failed session from the helper tears the runtime down', async () => {
  const { outputs, playback, spawned, close } = await setup();
  try {
    registerSelected(outputs);
    playback.queueAdd([fixtureSong()], { play: true });
    await until('helper spawned', () => spawned.length === 1);
    const t = spawned[0];
    t.onEvent('state', 'failed');
    await until('closed after failure', () => t.closed);
  } finally {
    await close();
  }
});

Deno.test('session failure: pause, retry-resume, recover (OwnTone cycle)', async () => {
  const { outputs, playback, spawned, close } = await setup({
    retryBackoffMs: [0, 1, 1],
  });
  try {
    registerSelected(outputs);
    playback.queueAdd([fixtureSong()], { play: true });
    await until('helper spawned', () => spawned.length === 1);
    const first = spawned[0];
    first.onEvent('state', 'connected');
    await until('PCM streamed', () => first.pcmBytes() > 0);
    // The link dies: the helper reports failure; with nothing else live the
    // player pauses (OwnTone pb_suspend — no lying progress), the boot waits,
    // resumes the player (pb_resume), and re-spawns over discovery's record.
    first.onEvent('state', 'failed');
    await until('player paused', () => playback.playerView().state === 'pause');
    await until('retry spawned', () => spawned.length === 2);
    assert(first.closed, 'failed helper torn down');
    spawned[1].onEvent('state', 'connected');
    await until('PCM re-streamed', () => spawned[1].pcmBytes() > 0);
    assertEquals(playback.playerView().state, 'play');
  } finally {
    await close();
  }
});

Deno.test('persistent failure: the player pauses and stays put (no storm)', async () => {
  const { outputs, playback, spawned, close } = await setup({
    retryBackoffMs: [0], // one retry; the next failure ends the table
  });
  try {
    registerSelected(outputs);
    playback.queueAdd([fixtureSong()], { play: true });
    await until('helper spawned', () => spawned.length === 1);
    spawned[0].onEvent('state', 'failed');
    await until('retry spawned', () => spawned.length === 2);
    spawned[1].onEvent('state', 'failed');
    await until('player paused', () => playback.playerView().state === 'pause');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertEquals(spawned.length, 2, 'no retry storm after the table ran out');
    assertEquals(outputs.get(ID)?.selected, true, 'no forced deselect');
  } finally {
    await close();
  }
});

function controlledRetry() {
  let next = 0;
  const pending = new Map<number, () => void>();
  return {
    timer: {
      set(callback: () => void, delay: number) {
        assertEquals(delay, 150);
        const id = ++next;
        pending.set(id, callback);
        return {
          cancel: () => {
            pending.delete(id);
          },
        };
      },
    },
    fire() {
      const item = pending.entries().next().value;
      assert(item);
      pending.delete(item[0]);
      item[1]();
    },
  };
}

Deno.test('catalog events do not move sessions: another device registering leaves a failed session down', async () => {
  const retry = controlledRetry();
  const { outputs, playback, spawned, close } = await setup({
    retryBackoffMs: [150],
    retryTimer: retry.timer,
  });
  try {
    registerSelected(outputs);
    // A second selected speaker: its session stays live, so the player
    // keeps playing when the first one fails.
    const id2 = airplayOutputId('192.0.2.11');
    outputs.register({
      id: id2,
      name: 'Bedroom ATV',
      type: 'AirPlay',
      selected: true,
      volume: 100,
      host: '192.0.2.11',
    });
    playback.queueAdd([fixtureSong()], { play: true });
    await until('both spawned', () => spawned.length === 2);
    spawned[0].onEvent('state', 'connected');
    spawned[1].onEvent('state', 'connected');
    await until(
      'PCM on both',
      () => spawned[0].pcmBytes() > 0 && spawned[1].pcmBytes() > 0,
    );

    // The first link dies. The second is live → no pause (hub keeps playing).
    spawned[0].onEvent('state', 'failed');
    await until('first torn down', () => spawned[0].closed);
    assertEquals(
      playback.playerView().state,
      'play',
      'a live session keeps the player playing',
    );

    // A third device appears on the network (a catalog event). It must not
    // restart the failed session — sessions move on hub decisions only.
    outputs.register({
      id: airplayOutputId('192.0.2.12'),
      name: 'okasan',
      type: 'AirPlay',
      selected: false,
      volume: 100,
      host: '192.0.2.12',
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assertEquals(
      spawned.length,
      2,
      'catalog event did not respawn the failed session',
    );

    // The hub's retry for that output does.
    retry.fire();
    await until('retry respawned', () => spawned.length === 3);
  } finally {
    await close();
  }
});

Deno.test('a re-announcement of the same device does not restart its failed session', async () => {
  const retry = controlledRetry();
  const { outputs, playback, spawned, close } = await setup({
    retryBackoffMs: [150],
    retryTimer: retry.timer,
  });
  try {
    registerSelected(outputs);
    const id2 = airplayOutputId('192.0.2.11');
    outputs.register({
      id: id2,
      name: 'Bedroom ATV',
      type: 'AirPlay',
      selected: true,
      volume: 100,
      host: '192.0.2.11',
    });
    playback.queueAdd([fixtureSong()], { play: true });
    await until('both spawned', () => spawned.length === 2);
    spawned[0].onEvent('state', 'connected');
    spawned[1].onEvent('state', 'connected');
    spawned[0].onEvent('state', 'failed');
    await until('first torn down', () => spawned[0].closed);

    // The same device re-announces at a new address (ethernet→wifi): the
    // record is replaced and selection preserved — still not a hub decision
    // to start the session.
    outputs.register({
      id: ID,
      name: 'Kitchen ATV',
      type: 'AirPlay',
      selected: true,
      volume: 100,
      host: '192.0.2.99',
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assertEquals(spawned.length, 2, 're-announcement did not respawn');

    // The retry is the hub decision — and it dials the re-announced address
    // (discovery owns the address; the session binds to the device).
    retry.fire();
    await until('retry respawned', () => spawned.length === 3);
    const start = spawned[2].cmds().find((c) => c.cmd === 'start')!;
    assertEquals(
      start.host,
      '192.0.2.99',
      'retry used the re-announced address',
    );
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// ATV3 session recycle (plan atv3-session-recycle): the affected model
// (model: 'AppleTV3,1') retires its RAOP session on every would-be FLUSH.
// Deterministic synthetic media (hour-long entries keep seeks above the
// 1500 ms detector) and the close-controllable fake expose the lifecycle
// races: delayed close, failed close, stale events mid-retirement.

const ATV3 = 'AppleTV3,1';

interface DecodeCall {
  path: string;
  startMs?: number;
}

/** Deterministic synthetic decode: paced nonzero chunks, each filled with
 * the 1-based call index so bytes from different decodes are
 * distinguishable in a transport's pcm frames. */
function syntheticMedia(
  calls: DecodeCall[],
  opts: { chunks?: number; chunkBytes?: number; paceMs?: number } = {},
): Media {
  const chunks = opts.chunks ?? 1000;
  const chunkBytes = opts.chunkBytes ?? 8192;
  const paceMs = opts.paceMs ?? 2;
  return {
    decodePcm: (path: string, o?: { startMs?: number }) => {
      calls.push({ path, startMs: o?.startMs });
      const tag = calls.length & 0xff;
      let n = 0;
      return Promise.resolve({
        async *[Symbol.asyncIterator]() {
          while (n++ < chunks) {
            if (paceMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, paceMs));
            }
            yield new Uint8Array(chunkBytes).fill(tag);
          }
        },
      });
    },
  } as unknown as Media;
}

let longSongN = 0;
/** An hour-long entry: seeks of tens of seconds stay inside it. */
function longSong(suffix?: string): SongRow {
  longSongN++;
  const id = `long-${suffix ?? longSongN}`;
  return {
    id,
    path: `/music/${id}.mp3`,
    libraryId: null,
    libraryPath: null,
    title: `Long ${id}`,
    albumId: null,
    albumName: 'Long Album',
    albumFolderName: 'Long Album',
    artistId: null,
    artistName: 'Long Artist',
    track: 1,
    disc: 1,
    durationMs: 3_600_000,
    size: 1,
    genre: null,
    year: null,
    firstSeenMs: null,
    isVideo: false,
    suffix: 'mp3',
    contentType: 'audio/mpeg',
  };
}

async function recycleSetup(
  overrides: {
    log?: Log;
    retryBackoffMs?: number[];
    chunks?: number;
    chunkBytes?: number;
    paceMs?: number;
  } = {},
) {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-ap-' });
  const store = await openStore(dir);
  const db = store;
  const notify = createNotify();
  const outputs = createOutputs({ notify, log: overrides.log });
  const player = createPlayer();
  const library = createLibrary(store);
  const playback = createPlayback({
    log: overrides.log,
    player,
    nowPlaying: createNowPlaying(store),
    library,
    cfg: {},
    notify,
  });
  const decodeCalls: DecodeCall[] = [];
  const spawned: FakeTransport[] = [];
  const devices = createTestAirplayDevices(
    outputs,
    recordingSpawn((onEvent) => {
      const t = new FakeTransport(onEvent);
      spawned.push(t);
      return t;
    }),
  );
  const boot = createAirplayBoot({
    log: overrides.log,
    outputs,
    playback,
    media: syntheticMedia(decodeCalls, overrides),
    notify,
    devices,
    ...(overrides.retryBackoffMs !== undefined &&
      { retryBackoffMs: overrides.retryBackoffMs }),
  });
  return {
    outputs,
    playback,
    spawned,
    decodeCalls,
    close: async () => {
      await boot.close();
      await db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

/** The affected output: mDNS-derived identity, model AppleTV3,1. */
function registerAtv3(outputs: ReturnType<typeof createOutputs>): string {
  outputs.register({
    id: ID,
    name: 'arbat',
    type: 'AirPlay',
    selected: true,
    volume: 100,
    host: HOST,
    model: ATV3,
  });
  return ID;
}

Deno.test('ATV3 pause: retires without FLUSH and stays down; resume connects a fresh session', async () => {
  const { outputs, playback, spawned, decodeCalls, close } =
    await recycleSetup();
  try {
    registerAtv3(outputs);
    playback.queueAdd([longSong()], { play: true });
    await until('spawned', () => spawned.length === 1);
    const t1 = spawned[0];
    t1.onEvent('state', 'connected');
    await until('pcm', () => t1.pcmBytes() > 0);

    playback.pause();
    await until('retired', () => t1.closed);
    assert(
      !t1.cmds().some((c) => c.cmd === 'flush'),
      'no FLUSH on the affected model',
    );
    assert(t1.cmds().some((c) => c.cmd === 'teardown'), 'teardown sent');
    await new Promise((resolve) => setTimeout(resolve, 120));
    assertEquals(spawned.length, 1, 'no reconnect while paused');

    playback.play(); // resume
    await until('replacement', () => spawned.length === 2);
    const t2 = spawned[1];
    await new Promise((resolve) => setTimeout(resolve, 60));
    assertEquals(t2.pcmBytes(), 0, 'no PCM before its own connected');
    t2.onEvent('state', 'connected');
    await until('resume pcm', () => t2.pcmBytes() > 0);
    assertEquals(decodeCalls.length, 2, 'one decode per session');
  } finally {
    await close();
  }
});

Deno.test('ATV3 seek: retires and replaces with the latest state — no FLUSH', async () => {
  const { outputs, playback, spawned, decodeCalls, close } =
    await recycleSetup();
  try {
    const id = registerAtv3(outputs);
    playback.queueAdd([longSong('a'), longSong('b')], { play: true });
    await until('spawned', () => spawned.length === 1);
    const t1 = spawned[0];
    t1.onEvent('state', 'connected');
    await until('pcm', () => t1.pcmBytes() > 0);

    playback.seek({ positionMs: 120_000 });
    await until('old retired', () => t1.closed);
    await until('replacement', () => spawned.length === 2);
    assert(!t1.cmds().some((c) => c.cmd === 'flush'), 'no FLUSH');
    const t2 = spawned[1];
    const start = t2.cmds().find((c) => c.cmd === 'start')!;
    assertEquals(start.host, HOST, 'replacement re-read the output record');
    t2.onEvent('state', 'connected');
    await until('pcm', () => t2.pcmBytes() > 0);
    const last = decodeCalls[decodeCalls.length - 1];
    assert(
      Math.abs((last.startMs ?? 0) - 120_000) < 1500,
      `replacement decodes at the requested position: ${last.startMs}`,
    );
    // Queue, selection and volume are not the recycle's business.
    assertEquals(playback.playerView().state, 'play');
    assertEquals(outputs.get(id)!.selected, true);
    assertEquals(outputs.get(id)!.volume, 100);
    assertEquals(playback.queueView().items.length, 2);
  } finally {
    await close();
  }
});

Deno.test('ATV3 track change: retires; the replacement decodes the new entry from 0', async () => {
  const { outputs, playback, spawned, decodeCalls, close } =
    await recycleSetup();
  try {
    registerAtv3(outputs);
    playback.queueAdd([longSong('a'), longSong('b')], { play: true });
    await until('spawned', () => spawned.length === 1);
    const t1 = spawned[0];
    t1.onEvent('state', 'connected');
    await until('pcm', () => t1.pcmBytes() > 0);

    playback.next();
    await until('old retired', () => t1.closed);
    await until('replacement', () => spawned.length === 2);
    assert(!t1.cmds().some((c) => c.cmd === 'flush'), 'no FLUSH');
    const t2 = spawned[1];
    t2.onEvent('state', 'connected');
    await until('pcm', () => t2.pcmBytes() > 0);
    const last = decodeCalls[decodeCalls.length - 1];
    assert(last.path.includes('long-b'), `new entry decoded: ${last.path}`);
    assert(
      (last.startMs ?? 0) < 1500,
      `the new entry decodes near its head, not an obsolete position: ${last.startMs}`,
    );
  } finally {
    await close();
  }
});

Deno.test('explicit OwnTone choice keeps FLUSH-based transitions regardless of model', async () => {
  const { outputs, playback, spawned, close } = await recycleSetup();
  try {
    outputs.register({
      id: ID,
      name: 'Old ATV',
      type: 'AirPlay',
      selected: true,
      volume: 100,
      host: HOST,
      model: 'AppleTV2,1',
      connectionStrategy: 'owntone',
    });
    playback.queueAdd([longSong()], { play: true });
    await until('spawned', () => spawned.length === 1);
    const t = spawned[0];
    t.onEvent('state', 'connected');
    await until('pcm', () => t.pcmBytes() > 0);

    playback.pause();
    await until('flush', () => t.cmds().some((c) => c.cmd === 'flush'));
    assert(!t.closed, 'no retirement on an unaffected model');
    playback.play(); // resume re-decodes on the SAME session
    const before = t.pcmBytes();
    await until('resume pcm', () => t.pcmBytes() > before);

    playback.seek({ positionMs: 120_000 });
    await until(
      'seek flush',
      () => t.cmds().filter((c) => c.cmd === 'flush').length === 2,
    );
    assertEquals(spawned.length, 1, 'no replacement for an unaffected model');
  } finally {
    await close();
  }
});

Deno.test('ATV3 rapid commands: a seek/next burst during a delayed close converges on one current replacement', async () => {
  const { outputs, playback, spawned, decodeCalls, close } =
    await recycleSetup();
  try {
    registerAtv3(outputs);
    playback.queueAdd([longSong('a'), longSong('b')], { play: true });
    await until('spawned', () => spawned.length === 1);
    const t1 = spawned[0];
    t1.onEvent('state', 'connected');
    await until('pcm', () => t1.pcmBytes() > 0);
    const gate = closeGate();
    t1.closeGate = gate.gate; // the close cannot complete until released

    playback.seek({ positionMs: 120_000 });
    await until('close started', () => t1.closeCalls === 1);
    playback.seek({ positionMs: 240_000 });
    playback.next(); // entry change mid-close: coalesces
    assertEquals(spawned.length, 1, 'no spawn while the gate holds');
    gate.release();
    await until('replacement', () => spawned.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertEquals(spawned.length, 2, 'the burst converged on one replacement');
    const t2 = spawned[1];
    assertEquals(
      t2.frames[0]?.type,
      'cmd',
      'no obsolete PCM ahead of the start command',
    );
    t2.onEvent('state', 'connected');
    await until('pcm', () => t2.pcmBytes() > 0);
    const last = decodeCalls[decodeCalls.length - 1];
    assert(
      last.path.includes('long-b'),
      `the LATEST entry decoded: ${last.path}`,
    );
    assert(
      (last.startMs ?? 0) < 1500,
      `no obsolete 240000 ms snapshot: ${last.startMs}`,
    );
  } finally {
    await close();
  }
});

Deno.test('ATV3 cancellation: pause during a pending replacement cancels it', async () => {
  const { outputs, playback, spawned, close } = await recycleSetup();
  try {
    registerAtv3(outputs);
    playback.queueAdd([longSong('a'), longSong('b')], { play: true });
    await until('spawned', () => spawned.length === 1);
    const t1 = spawned[0];
    t1.onEvent('state', 'connected');
    await until('pcm', () => t1.pcmBytes() > 0);
    const gate = closeGate();
    t1.closeGate = gate.gate;

    playback.seek({ positionMs: 120_000 }); // retires, replacement pending
    await until('close started', () => t1.closeCalls === 1);
    playback.pause(); // cancels the pending replacement
    gate.release();
    await until('closed', () => t1.closed);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertEquals(spawned.length, 1, 'the pause canceled the replacement');
    assertEquals(playback.playerView().state, 'pause');
  } finally {
    await close();
  }
});

Deno.test('ATV3 cancellation: a play edge during a pause retirement waits for the barrier', async () => {
  const { outputs, playback, spawned, close } = await recycleSetup();
  try {
    registerAtv3(outputs);
    playback.queueAdd([longSong()], { play: true });
    await until('spawned', () => spawned.length === 1);
    const t1 = spawned[0];
    t1.onEvent('state', 'connected');
    await until('pcm', () => t1.pcmBytes() > 0);
    const gate = closeGate();
    t1.closeGate = gate.gate;

    playback.pause(); // retire starts
    await until('close started', () => t1.closeCalls === 1);
    playback.play(); // a valid play decision mid-close
    assertEquals(
      spawned.length,
      1,
      'no spawn before the close barrier released',
    );
    gate.release();
    await until('replacement after close', () => spawned.length === 2);
    spawned[1].onEvent('state', 'connected');
    await until('pcm', () => spawned[1].pcmBytes() > 0);
  } finally {
    await close();
  }
});

Deno.test('ATV3 stale events from the retired session cannot touch the replacement or the row', async () => {
  const { outputs, playback, spawned, decodeCalls, close } =
    await recycleSetup();
  try {
    const id = registerAtv3(outputs);
    playback.queueAdd([longSong()], { play: true });
    await until('spawned', () => spawned.length === 1);
    const t1 = spawned[0];
    t1.onEvent('state', 'connected');
    await until('pcm', () => t1.pcmBytes() > 0);
    const gate = closeGate();
    t1.closeGate = gate.gate;

    playback.seek({ positionMs: 120_000 });
    await until('close started', () => t1.closeCalls === 1);
    const decodesBefore = decodeCalls.length;
    // Stale events DURING the gated retirement: all must be ignored.
    t1.onEvent('state', 'connected');
    t1.onEvent('state', 'password');
    t1.onEvent('state', 'failed');
    gate.release();
    await until('replacement', () => spawned.length === 2);
    assertEquals(
      playback.playerView().state,
      'play',
      'a stale failed did not pause the engine',
    );
    assertEquals(
      outputs.get(id)!.needsAuthKey,
      undefined,
      'a stale password did not touch the output row',
    );
    assertEquals(
      decodeCalls.length,
      decodesBefore,
      'a stale connected did not start a decode',
    );

    const t2 = spawned[1];
    t2.onEvent('state', 'connected');
    t2.onEvent('state', 'connected'); // repeated valid connected
    await until('pcm', () => t2.pcmBytes() > 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assertEquals(
      decodeCalls.length,
      decodesBefore + 1,
      'no duplicate pump on repeated connected',
    );

    // Stale events from the OLD session after the replacement: still inert.
    t1.onEvent('state', 'connected');
    t1.onEvent('state', 'failed');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertEquals(decodeCalls.length, decodesBefore + 1);
    assertEquals(spawned.length, 2, 'no retry storm from stale events');
  } finally {
    await close();
  }
});

Deno.test('ATV3 failure: a failed close blocks the output — visibly, until restart', async () => {
  const { log, lines: errors } = captureLogs();
  try {
    const { outputs, playback, spawned, close } = await recycleSetup({ log });
    try {
      registerAtv3(outputs);
      playback.queueAdd([longSong()], { play: true });
      await until('spawned', () => spawned.length === 1);
      const t1 = spawned[0];
      t1.onEvent('state', 'connected');
      await until('pcm', () => t1.pcmBytes() > 0);
      t1.closeError = new Error('native free wedged');

      playback.seek({ positionMs: 120_000 });
      await until('close attempted', () => t1.closeCalls === 1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assertEquals(
        spawned.length,
        1,
        'a failed retirement authorizes no replacement',
      );
      assert(
        errors.some((l) =>
          parseLogfmt(l).event === 'retirement_failed' &&
          parseLogfmt(l).output === ID &&
          parseLogfmt(l).generation !== undefined
        ),
        `the failure is logged with output and generation: ${
          errors.join(' | ')
        }`,
      );
      assertEquals(
        playback.playerView().state,
        'play',
        'no manufactured pause',
      );
      // Play, reselect and catalog events must not clear the block.
      playback.pause();
      playback.play();
      outputs.update(ID, { selected: false });
      outputs.update(ID, { selected: true });
      outputs.register({
        id: '999000',
        name: 'okasan',
        type: 'AirPlay',
        selected: false,
        volume: 100,
        host: '192.0.2.12',
      });
      await new Promise((resolve) => setTimeout(resolve, 120));
      assertEquals(
        spawned.length,
        1,
        'the block survived play/reselect/catalog events',
      );
    } finally {
      await close();
    }
  } finally {
    await log.flush();
  }
});

Deno.test('ATV3 provenance: a recycle fabricates no core commands; catalog/volume do not reconnect a down session', async () => {
  const { log, lines } = captureLogs();
  try {
    const { outputs, playback, spawned, close } = await recycleSetup({ log });
    try {
      registerAtv3(outputs);
      playback.queueAdd([longSong()], { play: true });
      await until('spawned', () => spawned.length === 1);
      spawned[0].onEvent('state', 'connected');
      await until('pcm', () => spawned[0].pcmBytes() > 0);

      lines.length = 0; // only the user's own command may follow
      playback.seek({ positionMs: 120_000 });
      await until('replacement', () => spawned.length === 2);
      const cmds = lines.map(parseLogfmt).filter((l) => l.event === 'command');
      assertEquals(
        cmds.length,
        1,
        'the recycle manufactured no pause/play/selection',
      );
      assertEquals(cmds[0].command, 'seek');
      assertEquals(JSON.parse(cmds[0].facts), { position_ms: 120000 });
      assertEquals(cmds[0].kind, 'internal');

      // A down session (paused, retired) is not resurrected by a volume
      // update or an unrelated registration.
      playback.pause();
      await until('retired', () => spawned[1].closed);
      outputs.update(ID, { volume: 42 });
      outputs.register({
        id: '999000',
        name: 'okasan',
        type: 'AirPlay',
        selected: false,
        volume: 100,
        host: '192.0.2.12',
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assertEquals(
        spawned.length,
        2,
        'catalog/volume events did not reconnect a down session',
      );
      assertEquals(outputs.get(ID)!.volume, 42, 'the update itself landed');
    } finally {
      await close();
    }
  } finally {
    await log.flush();
  }
});

Deno.test('ATV3 detection: a 500 ms same-entry seek does not recycle; a large seek and an entry change do', async () => {
  const { outputs, playback, spawned, close } = await recycleSetup();
  try {
    registerAtv3(outputs);
    playback.queueAdd([longSong('a'), longSong('b')], { play: true });
    await until('spawned', () => spawned.length === 1);
    const t1 = spawned[0];
    t1.onEvent('state', 'connected');
    await until('pcm', () => t1.pcmBytes() > 0);

    // Below the 1500 ms detector: the pre-existing limitation stands.
    const progress = playback.playerView().itemProgressMs;
    playback.seek({ positionMs: progress + 500 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assertEquals(spawned.length, 1, 'a small same-entry seek: no recycle');
    assert(!t1.closed, 'small seek: not retired');
    assert(
      !t1.cmds().some((c) => c.cmd === 'flush'),
      'small seek: not flushed either',
    );

    // A large detected seek recycles.
    playback.seek({ positionMs: 90_000 });
    await until('seek recycle', () => spawned.length === 2);
    spawned[1].onEvent('state', 'connected');
    await until('pcm2', () => spawned[1].pcmBytes() > 0);

    // A different queue-entry id transitions even within one song length.
    playback.next();
    await until('track recycle', () => spawned.length === 3);
  } finally {
    await close();
  }
});

Deno.test('ATV3: an entry change during the handshake is absorbed by the connecting session', async () => {
  const { outputs, playback, spawned, decodeCalls, close } =
    await recycleSetup();
  try {
    registerAtv3(outputs);
    playback.queueAdd([longSong('a'), longSong('b'), longSong('c')], {
      play: true,
    });
    await until('spawned', () => spawned.length === 1);
    const t1 = spawned[0];
    // Handshake still in flight (no connected yet): two entry changes.
    playback.next();
    playback.next();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assertEquals(
      spawned.length,
      1,
      'no churn: the in-flight session absorbs the changes',
    );
    t1.onEvent('state', 'connected');
    await until('pcm', () => t1.pcmBytes() > 0);
    const last = decodeCalls[decodeCalls.length - 1];
    assert(
      last.path.includes('long-c'),
      `the connected session decodes the LATEST entry: ${last.path}`,
    );
    // And a settled track change after connected recycles normally.
    playback.previous(); // back to long-b: a full recycle
    await until('recycled', () => spawned.length === 2);
    spawned[1].onEvent('state', 'connected');
    await until('pcm2', () => spawned[1].pcmBytes() > 0);
    assert(
      decodeCalls[decodeCalls.length - 1].path.includes('long-b'),
      'the settled recycle decodes the current entry',
    );
  } finally {
    await close();
  }
});
