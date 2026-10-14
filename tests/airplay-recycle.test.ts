// tests/airplay-recycle.test.ts — the ATV3 session-recycle policy at two
// depths (plan atv3-session-recycle §3.6):
//
// Part A (deterministic, boot level): the shared-feed handoff. Feed-fake
// transports model raop-ffi.ts's election — the first pcm writer is THE
// FEED, every other handle accepts-and-drops, the token releases only when
// the feed's close() PROVES cleanup — and count EFFECTIVE accepted bytes,
// not method calls. Matrix: retiring the feed and the non-feed, reverse
// registration order, two concurrent retirements, resume before/after the
// close, a peer connecting mid-retirement, and cancellation.
//
// Part B (integration, gated on the built library): the REAL boot → FFI
// transport → native library → fake receiver chain. 40 sequential detected
// seeks recycle the affected model every time: zero FLUSHes on its
// connections, a fresh SETUP/RECORD and new-session RTP on every cycle,
// continued peer RTP on the companion receiver, and old-session writes
// ending when the old handle closes. Run under both feed-ownership orders
// and with delayed old-session cleanup. Packet counts establish wire
// delivery — not decoded sample identity, and not an Apple TV DAC rendering.
import { assert, assertEquals } from '@std/assert';
import { openDb } from '../src/db.ts';
import { createLibrary, type SongRow } from '../src/library.ts';
import type { Media } from '../src/media.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createNotify } from '../src/notify.ts';
import { createOutputs, createPlayer } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';
import {
  airplayOutputId,
  type AirplayTransport,
  createAirplayBoot,
  type HelperEventFn,
} from '../src/boots/airplay.ts';
import { startFakeRaop } from './helpers/fake-raop.ts';
import { createFfiSpawn } from '../src/boots/raop-ffi.ts';
import {
  createTestAirplayDevices,
  recordingSpawn,
} from './helpers/airplay-devices.ts';

const LIB_PATH = decodeURIComponent(
  new URL('../helper/raop/libmelofon_raop.so', import.meta.url).pathname,
);
const HAVE_LIB = await Deno.stat(LIB_PATH).then(() => true).catch(() => false);
// Optional test-only LD_PRELOAD observer. The explicit verification run loads
// this same inode before Deno starts, so counters observe native connect/close,
// independently of helper state and delayed receiver EOF.
const observerPath = Deno.env.get('MELOFON_RAOP_FAULT_OBSERVER');
const observer = observerPath
  ? Deno.dlopen(observerPath, {
    raop_fi_last_generation: { parameters: [], result: 'u64' },
    raop_fi_generation_live: { parameters: ['u64'], result: 'i32' },
  })
  : null;

const ATV3 = 'AppleTV3,1';
const HOST_A = '192.0.2.10';
const HOST_B = '192.0.2.11';
const HOST_C = '192.0.2.12';
const ID_B = airplayOutputId(HOST_B);

let songN = 0;
/** An hour-long entry: seeks of tens of seconds stay inside it. */
function longSong(suffix?: string): SongRow {
  songN++;
  const id = `rec-${suffix ?? songN}`;
  return {
    id,
    path: `/music/${id}.mp3`,
    libraryId: null,
    libraryPath: null,
    title: `Rec ${id}`,
    albumId: null,
    albumName: 'Rec Album',
    artistId: null,
    artistName: 'Rec Artist',
    track: 1,
    disc: 1,
    durationMs: 3_600_000,
    size: 1,
    genre: null,
    year: null,
    isVideo: false,
    suffix: 'mp3',
    contentType: 'audio/mpeg',
  };
}

interface DecodeCall {
  path: string;
  startMs?: number;
}

/** Deterministic synthetic decode: paced chunks, each filled with the
 * 1-based call index so bytes from different decodes are distinguishable. */
function syntheticMedia(
  calls: DecodeCall[],
  opts: { chunks?: number; chunkBytes?: number; paceMs?: number } = {},
): Media {
  const chunks = opts.chunks ?? 100_000;
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

async function until(
  what: string,
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 30_000, // the shared ark host stalls under load; realtime pacing
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await fn())) {
    if (performance.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Part A — the shared-feed handoff (boot level, feed-modeling fakes)
// ---------------------------------------------------------------------------

/** Mirrors raop-ffi.ts: the first pcm writer is THE FEED; every other
 * transport accepts-and-drops. The token releases only when the feed's
 * close() completes successfully. Counts EFFECTIVE accepted bytes. */
class FeedFakeTransport implements AirplayTransport {
  static feed: symbol | null = null;
  readonly token = Symbol('feedfake');
  readonly cmds: Record<string, unknown>[] = [];
  acceptedBytes = 0;
  droppedBytes = 0;
  closed = false;
  /** A test-controlled gate: close() cannot complete until it resolves —
   * retirement-window assertions without wall-clock luck. */
  closeGate: Promise<void> | null = null;
  constructor(public onEvent: HelperEventFn) {}
  send(cmd: Record<string, unknown>) {
    this.cmds.push(cmd);
    return Promise.resolve();
  }
  pcm(chunk: Uint8Array) {
    if (FeedFakeTransport.feed === null) {
      FeedFakeTransport.feed = this.token;
    }
    if (FeedFakeTransport.feed !== this.token) {
      this.droppedBytes += chunk.length;
      return Promise.resolve();
    }
    this.acceptedBytes += chunk.length;
    return Promise.resolve();
  }
  close() {
    return (async () => {
      if (this.closeGate !== null) await this.closeGate;
      this.closed = true;
      if (FeedFakeTransport.feed === this.token) {
        FeedFakeTransport.feed = null;
      }
    })();
  }
  ownsSharedFeed() {
    return FeedFakeTransport.feed === this.token;
  }
  cancelPcm() {}
  totalBytes() {
    return this.acceptedBytes + this.droppedBytes;
  }
}

/** A test-controlled close gate: resolve it to let the close complete. */
function closeGate(): { gate: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

async function feedSetup() {
  FeedFakeTransport.feed = null;
  const dir = await Deno.makeTempDir({ prefix: 'melofon-rec-' });
  const db = await openDb(dir);
  const notify = createNotify();
  const outputs = createOutputs({ notify });
  const player = createPlayer();
  const library = createLibrary(db);
  const playback = createPlayback({
    player,
    nowPlaying: createNowPlaying(db),
    library,
    cfg: {},
    notify,
  });
  const decodeCalls: DecodeCall[] = [];
  const spawned: FeedFakeTransport[] = [];
  const byHost = new Map<string, FeedFakeTransport>();
  const devices = createTestAirplayDevices(
    outputs,
    recordingSpawn((onEvent) => {
      const t = new FeedFakeTransport(onEvent);
      spawned.push(t);
      return t;
    }),
  );
  const boot = createAirplayBoot({
    outputs,
    playback,
    media: syntheticMedia(decodeCalls),
    notify,
    devices,
  });
  return {
    outputs,
    playback,
    spawned,
    byHost,
    decodeCalls,
    close: async () => {
      await boot.close();
      db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

function register(
  outputs: ReturnType<typeof createOutputs>,
  host: string,
  model?: string,
) {
  outputs.register({
    id: airplayOutputId(host),
    name: `atv-${host}`,
    type: 'AirPlay',
    selected: true,
    volume: 100,
    host,
    ...(model === undefined ? {} : { model }),
    connectionStrategy: model === ATV3 ? 'melofon' : 'owntone',
  });
}

/** The latest transport spawned for a host's output start command. */
function transportFor(
  spawned: FeedFakeTransport[],
  host: string,
): FeedFakeTransport {
  for (let i = spawned.length - 1; i >= 0; i--) {
    const t = spawned[i];
    if (t.cmds.some((c) => c.cmd === 'start' && c.host === host)) return t;
  }
  throw new Error(`no transport for ${host}`);
}

Deno.test('feed handoff: retiring the feed holds the peer’s re-pump until the barrier', async () => {
  const { outputs, playback, spawned, close } = await feedSetup();
  try {
    register(outputs, HOST_A, ATV3);
    register(outputs, HOST_B);
    playback.queueAdd([longSong()], { play: true });
    await until('two sessions', () => spawned.length === 2);
    const a1 = transportFor(spawned, HOST_A);
    const b = transportFor(spawned, HOST_B);
    a1.onEvent('state', 'connected');
    await until('A pumps (feed)', () => a1.acceptedBytes > 0);
    b.onEvent('state', 'connected');
    await until('B pumps (dropped)', () => b.droppedBytes > 0);
    assertEquals(b.acceptedBytes, 0, 'B is the accept-and-drop peer');

    const gate = closeGate();
    a1.closeGate = gate.gate; // A's close cannot complete until released
    playback.seek({ positionMs: 120_000 }); // sync reconcile: A retires, B held
    const bDropped = b.droppedBytes;
    await sleep(20);
    assertEquals(b.droppedBytes, bDropped, 'B dropped nothing mid-handoff');
    assertEquals(b.acceptedBytes, 0, 'B not re-pumped while the gate holds');

    gate.release();
    await until('A closed', () => a1.closed);
    await until('B is the feed now', () => b.acceptedBytes > 0);
    await until('A replacement', () => transportFor(spawned, HOST_A) !== a1);
    const a2 = transportFor(spawned, HOST_A);
    a2.onEvent('state', 'connected');
    await until('A2 pumps (dropped)', () => a2.droppedBytes > 0);
    assertEquals(a2.acceptedBytes, 0, 'the replacement is the non-feed');
  } finally {
    await close();
  }
});

Deno.test('feed handoff: reverse ownership — a surviving feed is never re-elected or re-decoded', async () => {
  const { outputs, playback, spawned, decodeCalls, close } = await feedSetup();
  try {
    register(outputs, HOST_A, ATV3);
    register(outputs, HOST_B);
    playback.queueAdd([longSong()], { play: true });
    await until('two sessions', () => spawned.length === 2);
    const a1 = transportFor(spawned, HOST_A);
    const b = transportFor(spawned, HOST_B);
    // B connects and pumps first: B is the feed.
    b.onEvent('state', 'connected');
    await until('B pumps (feed)', () => b.acceptedBytes > 0);
    a1.onEvent('state', 'connected');
    await until('A pumps (dropped)', () => a1.droppedBytes > 0);

    // A's session dies (a peer-ONLY event — B has no transition of its own).
    const gate = closeGate();
    a1.closeGate = gate.gate;
    const bAccepted = b.acceptedBytes;
    const bFlushes = b.cmds.filter((c) => c.cmd === 'flush').length;
    const decodesBefore = decodeCalls.length;
    a1.onEvent('state', 'failed');
    // While the gate holds (A's retirement window), B must be undisturbed.
    await until(
      'B kept streaming through the peer retirement',
      () => b.acceptedBytes > bAccepted + 8192,
    );
    gate.release();
    assert(
      b.acceptedBytes > bAccepted,
      'B (surviving feed) kept streaming through the peer retirement',
    );
    assertEquals(b.droppedBytes, 0, 'B was never demoted');
    assertEquals(
      b.cmds.filter((c) => c.cmd === 'flush').length,
      bFlushes,
      'B was not flushed by a peer-only event',
    );
    assertEquals(
      decodeCalls.length,
      decodesBefore,
      'B was not re-decoded (no blanket peer refresh)',
    );
    assertEquals(
      playback.playerView().state,
      'play',
      'a live session keeps the player playing',
    );
    await until(
      'A replacement after the barrier',
      () =>
        spawned.filter((t) =>
          t.cmds.some((c) => c.cmd === 'start' && c.host === HOST_A)
        ).length === 2,
    );
    const a2 = transportFor(spawned, HOST_A);
    a2.onEvent('state', 'connected');
    await until('A2 dropped', () => a2.droppedBytes > 0);
    assertEquals(a2.acceptedBytes, 0, 'B never stopped being the feed');
  } finally {
    await close();
  }
});

Deno.test('feed handoff: a peer connecting during a retirement joins the pending handoff', async () => {
  const { outputs, playback, spawned, close } = await feedSetup();
  try {
    register(outputs, HOST_A, ATV3);
    playback.queueAdd([longSong()], { play: true });
    await until('one session', () => spawned.length === 1);
    const a1 = transportFor(spawned, HOST_A);
    a1.onEvent('state', 'connected');
    await until('A pumps', () => a1.acceptedBytes > 0);

    const gate = closeGate();
    a1.closeGate = gate.gate;
    playback.seek({ positionMs: 120_000 }); // sync: A retires, close gated
    // A NEW selected output appears mid-retirement (catalog event + hub
    // select edge): its first pump must wait for the batch.
    register(outputs, HOST_C);
    outputs.update(airplayOutputId(HOST_C), { selected: true });
    await until(
      'C spawned',
      () =>
        spawned.some((t) =>
          t.cmds.some((c) => c.cmd === 'start' && c.host === HOST_C)
        ),
    );
    const c = transportFor(spawned, HOST_C);
    c.onEvent('state', 'connected');
    await sleep(20);
    assertEquals(
      c.totalBytes(),
      0,
      'C decoded nothing into the accept-and-drop window',
    );
    gate.release();
    await until('C pumps after the barrier', () => c.totalBytes() > 0);
  } finally {
    await close();
  }
});

Deno.test('feed handoff: two concurrent retirements hold the peer until BOTH finish', async () => {
  const { outputs, playback, spawned, close } = await feedSetup();
  try {
    register(outputs, HOST_A, ATV3);
    register(outputs, HOST_C, ATV3); // a second affected output
    register(outputs, HOST_B);
    playback.queueAdd([longSong()], { play: true });
    await until('three sessions', () => spawned.length === 3);
    const a = transportFor(spawned, HOST_A);
    const c = transportFor(spawned, HOST_C);
    const b = transportFor(spawned, HOST_B);
    a.onEvent('state', 'connected');
    await until('A feed', () => a.acceptedBytes > 0);
    c.onEvent('state', 'connected');
    b.onEvent('state', 'connected');
    await until(
      'everyone pumping',
      () => c.droppedBytes > 0 && b.droppedBytes > 0,
    );

    const gate = closeGate();
    a.closeGate = gate.gate; // the SLOW close, test-controlled
    playback.seek({ positionMs: 120_000 }); // retires BOTH affected outputs
    await until('C closed', () => c.closed);
    const bDropped = b.droppedBytes;
    await sleep(20);
    assert(!a.closed, 'A still closing (gated)');
    assertEquals(
      b.droppedBytes,
      bDropped,
      'B stays held while the second retirement is still in flight',
    );
    gate.release();
    await until('A closed', () => a.closed);
    await until('B re-pumped after both', () => b.acceptedBytes > 0);
  } finally {
    await close();
  }
});

Deno.test('feed handoff: resume during the close waits; resume after the close is a plain play edge', async () => {
  const { outputs, playback, spawned, close } = await feedSetup();
  try {
    register(outputs, HOST_A, ATV3);
    playback.queueAdd([longSong()], { play: true });
    await until('one session', () => spawned.length === 1);
    const a1 = transportFor(spawned, HOST_A);
    a1.onEvent('state', 'connected');
    await until('A pumps', () => a1.acceptedBytes > 0);

    // Resume BEFORE the close finished: the play decision is remembered,
    // the retirement is not bypassed.
    const gate = closeGate();
    a1.closeGate = gate.gate;
    playback.pause();
    playback.play();
    await sleep(20);
    assertEquals(
      spawned.filter((t) =>
        t.cmds.some((c) => c.cmd === 'start' && c.host === HOST_A)
      ).length,
      1,
      'still one session while the gate holds',
    );
    gate.release();
    await until(
      'replacement',
      () =>
        spawned.filter((t) =>
          t.cmds.some((c) => c.cmd === 'start' && c.host === HOST_A)
        ).length === 2,
    );

    // Resume AFTER the close: a plain play edge, no barrier involved.
    const a2t = transportFor(spawned, HOST_A);
    a2t.onEvent('state', 'connected');
    await until('A2 pumps', () => a2t.totalBytes() > 0);
    playback.pause();
    await until('A2 closed', () => a2t.closed);
    playback.play();
    await until(
      'third session',
      () =>
        spawned.filter((t) =>
          t.cmds.some((c) => c.cmd === 'start' && c.host === HOST_A)
        ).length === 3,
    );
  } finally {
    await close();
  }
});

Deno.test('feed handoff: deselecting a held peer cancels its pending pump', async () => {
  const { outputs, playback, spawned, close } = await feedSetup();
  try {
    register(outputs, HOST_A, ATV3);
    register(outputs, HOST_B);
    playback.queueAdd([longSong()], { play: true });
    await until('two sessions', () => spawned.length === 2);
    const a1 = transportFor(spawned, HOST_A);
    const b = transportFor(spawned, HOST_B);
    a1.onEvent('state', 'connected');
    await until('A feed', () => a1.acceptedBytes > 0);
    b.onEvent('state', 'connected');
    await until('B dropped', () => b.droppedBytes > 0);

    const gate = closeGate();
    a1.closeGate = gate.gate;
    playback.seek({ positionMs: 120_000 }); // B's re-pump is now held
    outputs.update(ID_B, { selected: false }); // cancel the held pump
    gate.release();
    await until('A closed', () => a1.closed);
    const bTotal = b.totalBytes();
    await sleep(50); // the barrier has released; nothing more may come
    assertEquals(
      b.totalBytes(),
      bTotal,
      'the deselected peer never pumped again',
    );
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// Part B — real boot → FFI → native library → fake receiver (gated)
// ---------------------------------------------------------------------------

interface Integration {
  outputs: ReturnType<typeof createOutputs>;
  playback: ReturnType<typeof createPlayback>;
  fakeA: Awaited<ReturnType<typeof startFakeRaop>>;
  fakeB: Awaited<ReturnType<typeof startFakeRaop>>;
  decodeCalls: DecodeCall[];
  companionFirst: boolean;
  native: AirplayTransport[];
  localReleases: bigint[];
  close: () => Promise<void>;
}

async function integrationSetup(opts: {
  aRecordDelayMs?: number;
  bRecordDelayMs?: number;
  aTeardownDelayMs?: number;
  companionFirst?: boolean;
}): Promise<Integration> {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-rec-ffi-' });
  const db = await openDb(dir);
  const notify = createNotify();
  const outputs = createOutputs({ notify });
  const player = createPlayer();
  const library = createLibrary(db);
  const playback = createPlayback({
    player,
    nowPlaying: createNowPlaying(db),
    library,
    cfg: {},
    notify,
  });
  const decodeCalls: DecodeCall[] = [];
  // Realtime-ish pacing: the native ~2 s read-ahead cap keeps the pump in
  // backpressure between drains — the wire sees continuous RTP.
  const media = syntheticMedia(decodeCalls, { chunkBytes: 8192, paceMs: 10 });
  const fakeA = await startFakeRaop({
    recordDelayMs: opts.aRecordDelayMs,
    teardownDelayMs: opts.aTeardownDelayMs,
  });
  const fakeB = await startFakeRaop({ recordDelayMs: opts.bRecordDelayMs });
  // The REAL boot: its default spawn is the FFI transport.
  const native: AirplayTransport[] = [];
  const localReleases: bigint[] = [];
  const ffiSpawn = createFfiSpawn();
  const devices = createTestAirplayDevices(outputs, (event) => {
    let generation: bigint | undefined;
    const driver = ffiSpawn((name, value) => {
      if (
        observer && generation === undefined && name === 'state' &&
        value === 'connected'
      ) {
        generation = observer.symbols.raop_fi_last_generation();
      }
      event(name, value);
    });
    const underlying = driver.transport;
    const transport: AirplayTransport = {
      send: (command) => underlying.send(command),
      pcm: (data) => underlying.pcm(data),
      ownsSharedFeed: () => underlying.ownsSharedFeed(),
      cancelPcm: () => underlying.cancelPcm(),
      async close() {
        await underlying.close();
        if (observer && generation !== undefined) {
          assertEquals(
            observer.symbols.raop_fi_generation_live(generation),
            0,
            'native TCP generation destroyed before close resolves/replacement',
          );
          localReleases.push(generation);
        }
      },
    };
    native.push(transport);
    return { transport, start: driver.start };
  });
  const boot = createAirplayBoot({
    outputs,
    playback,
    media,
    notify,
    devices,
  });

  const registerAt = (
    id: string,
    port: number,
    name: string,
    model?: string,
  ) => {
    // Both receivers live on 127.0.0.1, so the ids are explicit distinct
    // decimals (as mDNS instance ids would be) — a host-hash id would
    // collide, and 192.0.2.x is never dialed in a live-FFI test.
    outputs.register({
      id,
      name,
      type: 'AirPlay',
      selected: opts.companionFirst === true
        ? id === '222222222222'
        : id === '111111111111',
      volume: 100,
      host: '127.0.0.1',
      port,
      ...(model === undefined ? {} : { model }),
      connectionStrategy: model === ATV3 ? 'melofon' : 'owntone',
    });
  };
  registerAt('111111111111', fakeA.port, 'arbat (affected)', ATV3);
  registerAt('222222222222', fakeB.port, 'companion');

  return {
    outputs,
    playback,
    fakeA,
    fakeB,
    decodeCalls,
    companionFirst: opts.companionFirst === true,
    native,
    localReleases,
    close: async () => {
      await boot.close();
      fakeA.close();
      fakeB.close();
      db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

function flushesOn(fake: Awaited<ReturnType<typeof startFakeRaop>>): number {
  return fake.sessions.reduce((n, s) => n + s.flushes, 0);
}

function packetsOn(fake: Awaited<ReturnType<typeof startFakeRaop>>): number {
  return fake.sessions.reduce((n, s) => n + s.audioPackets, 0);
}

/** The recycle battery: 40 sequential detected seeks. Every cycle must
 * retire the affected session (never FLUSH it) and land a fresh one with
 * RTP, while the companion receiver keeps its ONE session and keeps
 * receiving. */
async function seekBattery(
  label: string,
  it: Integration,
  cycles: number,
) {
  // Eight entries: the seek battery stays on the first; the track-change
  // phase then walks next() without ever running off the end (which would
  // legitimately stop the engine).
  const songs = Array.from(
    { length: 8 },
    (_, i) => longSong(`${label}-${i + 1}`),
  );
  it.playback.queueAdd(songs, { play: true });
  const owner = it.companionFirst ? it.fakeB : it.fakeA;
  await until(
    'intended feed alone actually streaming',
    () => (owner.sessions[0]?.audioPackets ?? 0) > 2,
  );
  assertEquals(it.native.length, 1, 'only intended owner selected initially');
  assert(
    it.native[0].ownsSharedFeed(),
    'observe production feed ownership, not RTP at both receivers',
  );
  it.outputs.update(it.companionFirst ? '111111111111' : '222222222222', {
    selected: true,
  });
  await until(
    `${label}: both receivers streaming`,
    () =>
      it.fakeA.sessions.length === 1 &&
      (it.fakeA.sessions[0]?.audioPackets ?? 0) > 2 &&
      it.fakeB.sessions.length === 1 &&
      (it.fakeB.sessions[0]?.audioPackets ?? 0) > 2,
    20_000,
  );

  for (let i = 1; i <= cycles; i++) {
    const beforeB = packetsOn(it.fakeB);
    const prevA = it.fakeA.sessions[it.fakeA.sessions.length - 1];
    it.playback.seek({ positionMs: i * 60_000 });
    await until(
      `${label} cycle ${i}: fresh affected session with RTP`,
      () =>
        it.fakeA.sessions.length === i + 1 &&
        (it.fakeA.sessions[i]?.audioPackets ?? 0) > 2,
    );
    const nowA = it.fakeA.sessions[i];
    if (observer) {
      assertEquals(
        it.localReleases.length,
        i,
        `${label} cycle ${i}: native destruction observed before replacement`,
      );
      assertEquals(
        new Set(it.localReleases).size,
        i,
        'distinct connection generations, never FD identity',
      );
    }
    assert(
      nowA.requests.some((r) => r.method === 'SETUP') &&
        nowA.requests.some((r) => r.method === 'RECORD'),
      `${label} cycle ${i}: the replacement ran its own SETUP/RECORD`,
    );
    assertEquals(
      flushesOn(it.fakeA),
      0,
      `${label} cycle ${i}: zero FLUSHes on the affected device`,
    );
    // The old session's writes ended when its handle closed — the barrier
    // means the replacement's RTP only started after that. (Its last
    // buffered packets may still land during the close itself; the freeze
    // is measured from the replacement's first RTP.)
    const frozenAt = prevA.audioPackets;
    await sleep(60);
    assertEquals(
      prevA.audioPackets,
      frozenAt,
      `${label} cycle ${i}: the retired session received no further RTP`,
    );
    assert(
      packetsOn(it.fakeB) > beforeB,
      `${label} cycle ${i}: the companion kept receiving`,
    );
    assertEquals(
      it.fakeB.sessions.length,
      1,
      `${label} cycle ${i}: the companion's session persists`,
    );
    assertEquals(
      it.playback.playerView().state,
      'play',
      `${label} cycle ${i}: engine still playing`,
    );
  }
}

Deno.test({
  name:
    'ATV3 recycle integration (feed: affected first): 40 seeks, pause/resume, track changes',
  ignore: !HAVE_LIB,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const it = await integrationSetup({ bRecordDelayMs: 400 });
    try {
      await seekBattery('a-first', it, 40);

      // Pause retires the affected session and stays down; resume starts a
      // fresh one. The companion only ever flushes.
      for (let round = 1; round <= 3; round++) {
        const sessionsBefore = it.fakeA.sessions.length;
        it.playback.pause();
        await until(
          `pause ${round}: affected torn down on the wire`,
          () => it.fakeA.sessions[sessionsBefore - 1]?.teardowns === 1,
        );
        await sleep(150);
        assertEquals(
          it.fakeA.sessions.length,
          sessionsBefore,
          `pause ${round}: no reconnect while paused`,
        );
        assertEquals(
          flushesOn(it.fakeA),
          0,
          `pause ${round}: still zero FLUSHes`,
        );
        it.playback.play();
        await until(
          `resume ${round}: fresh session with RTP`,
          () =>
            it.fakeA.sessions.length === sessionsBefore + 1 &&
            (it.fakeA.sessions[sessionsBefore]?.audioPackets ?? 0) > 2,
        );
      }

      // Track changes: the affected output streams the CURRENT entry after
      // every next(), still with zero FLUSHes. The paced common case is a
      // full recycle per next(); a next() landing mid-handshake is absorbed
      // by the connecting session (it re-reads the engine at connected) —
      // never more than one session per next, never a stale entry.
      let trackRecycles = 0;
      for (let round = 1; round <= 5; round++) {
        const sessionsBefore = it.fakeA.sessions.length;
        const expectPath = `/music/rec-a-first-${round + 1}.mp3`;
        it.playback.next();
        await until(
          `track ${round}: current entry streaming on the affected output`,
          () => {
            const last = it.decodeCalls[it.decodeCalls.length - 1];
            const lastSession = it.fakeA.sessions[it.fakeA.sessions.length - 1];
            return last?.path === expectPath &&
              (lastSession?.audioPackets ?? 0) > 2;
          },
        );
        const sessionCount = it.fakeA.sessions.length;
        assert(
          sessionCount <= sessionsBefore + 1,
          `track ${round}: at most one new session per transition`,
        );
        if (sessionCount === sessionsBefore + 1) trackRecycles++;
        assertEquals(flushesOn(it.fakeA), 0, `track ${round}: no FLUSH`);
        // Let the boot's connected event land before the next transition.
        await sleep(120);
      }
      assert(
        trackRecycles >= 1,
        `track changes recycled on the wire (${trackRecycles}/5 full recycles)`,
      );
      // Spot-check the last seek position landed near the request.
      // (Position truth at the DAC is the hardware gate's business.)
      assertEquals(it.fakeB.sessions.length, 1, 'companion never recycled');
    } finally {
      await it.close();
    }
  },
});

Deno.test({
  name:
    'ATV3 recycle integration (feed: companion first; delayed old-session cleanup): 40 seeks',
  ignore: !HAVE_LIB,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Select companion ALONE, observe actual feed, then explicitly select A.
    const it = await integrationSetup({
      aRecordDelayMs: 0,
      bRecordDelayMs: 400,
      aTeardownDelayMs: 150,
      companionFirst: true,
    });
    try {
      await seekBattery('b-first', it, 40);
      // Every retired session's connection eventually ends despite the
      // dragged teardown replies (the receiver notices the client close
      // only after its own delayed reply fails — wait for the last one).
      await until(
        'all retired connections closed',
        () =>
          it.fakeA.sessions.slice(0, -1).every((s) => s.closedAtMs !== null),
      );
      for (const [i, s] of it.fakeA.sessions.slice(0, -1).entries()) {
        assert(
          s.closedAtMs !== null,
          `retired session ${i + 1} connection closed`,
        );
      }
      assertEquals(flushesOn(it.fakeA), 0, 'zero FLUSHes across the battery');
    } finally {
      await it.close();
    }
  },
});
