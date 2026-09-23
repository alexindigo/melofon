// tests/airplay-boot.test.ts — the AirPlay boot against a FAKE helper
// transport (no helper binary, no device): unselected play spawns nothing,
// selected + play starts the helper, PCM flows only after the helper
// reports connected (real decodePcm on the fixture), pause flushes, resume
// re-decodes from the engine position, stop / deselect / unregister tear
// down, volume and pin reach the helper, and a helper "password" event
// flips needsAuthKey on the output row.
import { assert, assertEquals } from '@std/assert';
import { openDb } from '../src/db.ts';
import { createLibrary, type SongRow } from '../src/library.ts';
import { createMedia } from '../src/media.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createNotify } from '../src/notify.ts';
import { createOutputs, createPlayer } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';
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
    artistId: null,
    artistName: 'Fixture Artist',
    track: 1,
    disc: 1,
    durationMs: 1000,
    size: 1,
    genre: null,
    year: null,
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
  constructor(public onEvent: HelperEventFn) {}
  send(cmd: Record<string, unknown>) {
    this.frames.push({ type: 'cmd', cmd });
    return Promise.resolve();
  }
  pcm(chunk: Uint8Array) {
    this.frames.push({ type: 'pcm', bytes: chunk.length });
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
  cmds() {
    return this.frames.filter((f) => f.type === 'cmd').map((f) => f.cmd!);
  }
  pcmBytes() {
    return this.frames.reduce((n, f) => n + (f.bytes ?? 0), 0);
  }
}

async function setup(overrides: { retryBackoffMs?: number[] } = {}) {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-ap-' });
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
  const spawned: FakeTransport[] = [];
  const boot = createAirplayBoot({
    outputs,
    playback,
    media: createMedia(),
    notify,
    spawn: (onEvent) => {
      const t = new FakeTransport(onEvent);
      spawned.push(t);
      return t;
    },
    ...(overrides.retryBackoffMs !== undefined &&
      { retryBackoffMs: overrides.retryBackoffMs }),
  });
  return {
    outputs,
    playback,
    spawned,
    close: async () => {
      await boot.close();
      db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('airplay.retry config parse: default, clamp at 60, off', () => {
  assertEquals(parseRetryBackoff(null), [0, 2, 5, 10, 20, 30, 60]);
  assertEquals(parseRetryBackoff(''), [0, 2, 5, 10, 20, 30, 60]);
  assertEquals(parseRetryBackoff('0,2,700,40'), [0, 2, 60, 40]);
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
  const { outputs, playback, spawned, close } = await setup();
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
    // The whole 1 s fixture decodes through.
    await until('PCM streamed', () => t.pcmBytes() === FIXTURE_PCM_BYTES);
  } finally {
    await close();
  }
});

Deno.test('no PCM before the helper reports connected', async () => {
  const { outputs, playback, spawned, close } = await setup();
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
    t.onEvent('state', 'connected');
    await until('PCM streamed', () => t.pcmBytes() === FIXTURE_PCM_BYTES);
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

Deno.test('pause flushes; resume re-decodes; stop tears down', async () => {
  const { outputs, playback, spawned, close } = await setup();
  try {
    registerSelected(outputs);
    playback.queueAdd([fixtureSong()], { play: true });
    await until('helper spawned', () => spawned.length === 1);
    spawned[0].onEvent('state', 'connected');
    await until(
      'PCM streamed',
      () => spawned[0]?.pcmBytes() === FIXTURE_PCM_BYTES,
    );
    const t = spawned[0];

    playback.pause();
    assert(t.cmds().some((c) => c.cmd === 'flush'), 'pause sends flush');

    playback.play(); // resume → the fixture decodes again from ~position
    const before = t.pcmBytes();
    await until('resume re-streams', () => t.pcmBytes() > before);

    playback.stop();
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
    await until('respawned', () => spawned.length === 2);
    const t2 = spawned[1];
    outputs.unregister(ID);
    await until('teardown on unregister', () => t2.closed);
    assert(t2.cmds().some((c) => c.cmd === 'teardown'));
  } finally {
    await close();
  }
});

Deno.test('mDNS-derived devtype/encrypt ride the start command', async () => {
  const { outputs, playback, spawned, close } = await setup();
  try {
    outputs.register({
      id: ID,
      name: 'Kitchen ATV',
      type: 'AirPlay',
      selected: true,
      volume: 100,
      host: HOST,
      devtype: 'apex3',
      encrypt: true,
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
